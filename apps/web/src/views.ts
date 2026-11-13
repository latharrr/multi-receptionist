// Server-rendered screens. Read-only: every change goes through the control API (public/app.js).
import { randomUUID } from 'node:crypto'
import type { Role } from '@lathar/contracts'
import { one, withUser, type Tx, type WorkspaceContext } from '@lathar/database'
import { PRICE_DATE, PRICES, SUPPORTED_MODELS } from './adapters/anthropic.ts'
import { getConfig, PROVIDERS } from './ai.ts'
import { diagnostics, ws } from './api.ts'
import { Redirect, type Add, type Ctx, type Handler } from './app.ts'
import { ENQUIRY_FIELDS, getBehavior, listEnquiries, type EnquiryField } from './assistant.ts'
import { html, Raw } from './http.ts'
import { getSettings, listConversations, listMessages, type ConversationRow } from './inbox.ts'
import { getDraft, listSources, nextQuestion, published } from './knowledge.ts'
import { readiness, type Check } from './readiness.ts'
import { canManage, listMembers, ROLE_CAN, ROLE_NAMES } from './team.ts'
import { usageSummary } from './usage.ts'
import { currentConnection, linkArtifact, ROUTES, type Connection, type Route } from './whatsapp.ts'

const icon = (name: string, lg = false) => html`<svg class="icon${lg ? ' lg' : ''}"><use href="#i-${name}"/></svg>`
const status = (kind: 'ok' | 'warn' | 'bad' | 'idle', i: string, text: string) => html`<span class="status ${kind}">${icon(i)}${text}</span>`
const MOCK = status('idle', 'mock', 'Development mock')
const money = (micros: number) => (micros > 0 && micros < 10_000 ? `$${(micros / 1e6).toFixed(4)}` : `$${(micros / 1e6).toFixed(2)}`)
const raw = (s: string) => new Raw(s)
/** Set once at start-up: true only in a development build (local mailbox, mocks available). */
let DEV = false
const time = (d: Date) => d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const err = html`<p class="form-err" role="alert"></p>`

const doc = (title: string, view: string, body: Raw) => html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Receptionist</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/styles/tokens.css">
<link rel="stylesheet" href="/styles/ui.css">
<link rel="stylesheet" href="/styles/app.css">
</head>
<body data-view="${view}">
${DEV ? html`<div class="proto-bar"><span>Development build · sign-in mail goes to the local mailbox · anything labelled “mock” is simulated</span></div>` : ''}
${body}
<script src="/public/icons.js"></script>
<script src="/public/app.js"></script>
</body>
</html>`

const LEGAL = html`<p class="meta" style="margin-top: var(--space-24)"><a href="/support">Support</a> · <a href="/privacy">Privacy</a></p>`
const plain = (title: string, body: Raw) => doc(title, 'plain', html`<main><div class="auth">${body}${LEGAL}</div></main>`)

interface Shell {
  name: string
  paused: boolean
  active: boolean
  waiting: number
  conn: Connection | null
}
async function shellData(tx: Tx): Promise<Shell> {
  const w = one(await tx.query<{ name: string; paused: boolean; active: boolean }>(`SELECT name, replies_paused_at IS NOT NULL AS paused, state = 'active' AS active FROM workspaces WHERE id = app_workspace_id()`))
  const { n } = one(await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM conversations WHERE mode = 'handoff_requested'`))
  return { ...w, waiting: n, conn: await currentConnection(tx) }
}

const PAUSE_NOTE = 'Pausing automation stops new automated replies. A message already submitted to WhatsApp may still arrive.'
const STAFF_WHILE_PAUSED = 'Staff can still take over a chat and reply while automation is paused.'
const pauseForm = (w: string, paused: boolean, square = false) =>
  paused
    ? html`<form data-api="/api/v1/workspaces/${w}/resume-replies"><button class="btn secondary${square ? ' square' : ''}" ${square ? html`aria-label="Resume automation"` : ''} title="Let the assistant reply again">${icon('right', square)}${square ? '' : 'Resume automation'}</button>${square ? '' : err}</form>`
    : html`<form data-api="/api/v1/workspaces/${w}/pause"><button class="btn secondary${square ? ' square' : ''}" ${square ? html`aria-label="Pause automation"` : ''} title="${PAUSE_NOTE} ${STAFF_WHILE_PAUSED}">${icon('pause', square)}${square ? '' : 'Pause automation'}</button>${square ? '' : err}</form>`

const NAV = [
  ['', 'home', 'Home'], ['inbox', 'inbox', 'Inbox'], ['enquiries', 'list', 'Enquiries'], null,
  ['business', 'info', 'Business info'], ['knowledge', 'book', 'Knowledge'], ['assistant', 'sliders', 'Assistant'], ['ai', 'chip', 'AI provider'],
  ['whatsapp', 'link', 'WhatsApp'], ['test', 'send', 'Test chat'], null,
  ['usage', 'chart', 'Usage and limit'], ['team', 'users', 'Team'], ['settings', 'info', 'Settings'], ['not-built', 'more', 'Not built yet'],
] as const

function shell(s: Shell, w: string, nav: string, title: string, view: string, body: Raw) {
  const base = `/w/${w}`
  const cur = (k: string) => (k === nav ? html`aria-current="page"` : '')
  const wsButton = html`<a class="ws" href="/workspaces" title="Switch workspace"><span class="mark" aria-hidden="true">${s.name.slice(0, 1).toUpperCase()}</span><span class="name">${s.name}</span>${icon('down')}</a>`
  const state = s.paused ? 'Automation paused' : s.active ? 'Live · staff approve replies' : 'Test mode'
  return doc(title, view, html`<div class="app">
  <aside class="side">
    ${wsButton}
    <nav aria-label="Workspace">
      ${NAV.map((n) => n === null ? html`<hr>` : html`<a href="${base}${n[0] && '/'}${n[0]}" ${cur(n[0])}>${icon(n[1], true)}${n[2]}${n[0] === 'inbox' && s.waiting ? html`<span class="count">${s.waiting}<span class="sr-only"> waiting for staff</span></span>` : ''}</a>`)}
    </nav>
    <div class="side-foot">
      <div>
        <span style="font: var(--text-label); font-weight: 600">${state}</span>
        <p class="meta tnum" style="margin-top: 4px">${s.conn?.state === 'connected' ? html`${s.conn.mode === 'mock' ? 'Mock · ' : ''}${s.conn.masked_number} · ${ROUTES[s.conn.route].name}` : 'No WhatsApp route connected'}</p>
        <p class="meta" style="margin-top: 4px"><a href="/support">Support</a> · <a href="/privacy">Privacy</a></p>
      </div>
      ${pauseForm(w, s.paused)}
    </div>
  </aside>
  <header class="topbar">
    ${wsButton}
    <span class="meta" style="font-weight: 600; color: var(--text)">${state}</span>
    ${pauseForm(w, s.paused, true)}
  </header>
  <main>${body}</main>
  <nav class="tabs" aria-label="Sections">
    <a href="${base}" ${cur('')}>${icon('home')}Home</a>
    <a href="${base}/inbox" ${cur('inbox')}>${icon('inbox')}Inbox</a>
    <a href="${base}/knowledge" ${cur('knowledge')}>${icon('book')}Knowledge</a>
    <a href="${base}/test" ${cur('test')}>${icon('send')}Test chat</a>
  </nav>
</div>`)
}

const page = (nav: string, title: string, fn: (tx: Tx, c: Ctx, api: string, w: WorkspaceContext) => Promise<Raw>, view?: string): Handler =>
  ws(undefined, async (tx, c, w) => {
    const body = await fn(tx, c, `/api/v1/workspaces/${c.param('w')}`, w)
    return shell(await shellData(tx), c.param('w'), nav, title, view ?? 'home', view ? body : html`<section class="view" id="v-home">${body}</section>`)
  })

const STEP_LINK: Record<Check['key'], string> = { business: 'business', knowledge: 'knowledge', assistant: 'assistant', ai: 'ai', limit: 'usage', whatsapp: 'whatsapp', test: 'test', privacy: 'settings', activate: 'settings' }
const STEP_STATUS = { done: status('ok', 'check', 'Done'), mock: MOCK, blocked: status('warn', 'alert', 'Blocked'), todo: status('idle', 'idle', 'To do') }

const SEND_STATE: Record<string, string> = {
  reserved: 'Queued', submitting: 'Sending', accepted: 'Accepted by WhatsApp · delivery not confirmed', delivered: 'Delivered', read: 'Read',
  draft: 'Draft · not sent', discarded: 'Draft discarded · not sent',
  uncertain: 'Delivery uncertain · not resent automatically', interrupted_during_send: 'Delivery uncertain · interrupted while sending · not resent automatically',
  no_answer_from_provider: 'Delivery uncertain · no answer from WhatsApp · not resent automatically',
  stopped_by_takeover: 'Not sent · stopped by takeover', stopped_by_pause: 'Not sent · replies were paused', connection_not_ready: 'Not sent · WhatsApp not connected', failed: 'Not sent',
  stopped_by_operator: 'Not sent · all sending is stopped by the platform operator', workspace_not_active: 'Not sent · real customers are switched off',
  needs_approval: 'Not sent · needed staff approval', outside_reply_window: 'Not sent · more than 24 hours since the customer last wrote (WhatsApp’s rule)',
  message_cap_reached: 'Not sent · monthly WhatsApp message cap reached', session_not_connected: 'Not sent · the QR link was not connected', route_not_configured: 'Not sent · this route is not set up',
  rejected_after_acceptance: 'Not delivered · WhatsApp rejected it after accepting',
}
// In a development build notices go to the local mailbox, and every state says so.
const notice = (c: ConversationRow) => {
  const people = `${c.notified} team member${c.notified === 1 ? '' : 's'}`
  return c.notice_state === 'sent' ? (DEV ? `Staff notice simulated: written to the local mailbox for ${people}. No real email was sent.` : `Staff notice emailed to ${people}. Handed to the mail server; arrival is not confirmed.`)
    : c.notice_state === 'failed' ? `Staff notice failed${DEV ? ' (simulated delivery)' : ''}. Not everyone was told; it is retried, and this chat shows here either way.`
    : c.notice_state === 'skipped' ? 'No staff notice: someone took over first.'
    : c.notice_state === 'pending' ? `Staff notice queued${DEV ? ' (simulated delivery)' : ''}.` : ''
}
const who = (c: ConversationRow) => c.name ?? `Customer ••• ${c.number}`
const MODE: Record<string, Raw> = {
  bot: status('idle', 'idle', 'Assistant'),
  handoff_requested: status('warn', 'alert', 'Waiting for staff'),
  human: status('ok', 'users', 'With staff'),
  resolved: status('idle', 'check', 'Resolved'),
}

export function pageRoutes(add: Add, localMailbox: boolean) {
  DEV = localMailbox
  add('GET', '/', async (c) => {
    if (!c.user) return new Redirect('/signin')
    const first = await withUser(c.deps.db, c.user.id, (tx) =>
      tx.query<{ id: string }>(`SELECT workspace_id AS id FROM memberships WHERE user_id = app_user_id() AND status = 'active' ORDER BY created_at LIMIT 1`))
    return new Redirect(first.rows[0] ? `/w/${first.rows[0].id}` : '/workspaces')
  }, true)

  add('GET', '/signin', async (c) => plain('Sign in', html`
    <h1 class="page-title">Sign in</h1>
    <form class="form" data-api="/api/auth/sign-in/magic-link" data-next="${localMailbox ? '/dev/mailbox' : '/signin?sent=1'}">
      <input type="hidden" name="callbackURL" value="/">
      <div class="field"><label for="email">Email</label><input class="input" id="email" name="email" type="email" autocomplete="email" required>
        <span class="hint">We’ll email you a link that signs you in once and expires in 15 minutes. No password.</span></div>
      ${err}
      <div><button class="btn primary">Send me a sign-in link</button></div>
    </form>
    ${localMailbox ? html`<p class="note">Development mode: no email is sent. The link appears in the <a href="/dev/mailbox">local mailbox</a> on this machine.</p>`
      : c.query.get('sent') ? html`<p class="note" role="status">If that address can sign in, a link is on its way. It works once and expires in 15 minutes. Check your spam folder if it has not arrived in a few minutes.</p>` : ''}`), true)

  // Development only: not registered at all when the local mailbox is off.
  if (localMailbox) add('GET', '/dev/mailbox', async (c) => {
    const mail = await c.deps.db.query<{ to_email: string; subject: string; body: string; created_at: Date }>('SELECT to_email, subject, body, created_at FROM local_mail ORDER BY created_at DESC LIMIT 30')
    // Only links back to this server are made clickable.
    const link = (body: string) => {
      const last = body.split('\n').pop() ?? ''
      return last.startsWith(`${c.deps.baseUrl}/`) ? last : null
    }
    return plain('Local mailbox', html`
      <h1 class="page-title">Local mailbox</h1>
      <p class="note">Stands in for email during development: sign-in links, invitations and staff notices. Nothing here was sent anywhere; these messages exist only in this machine’s database.</p>
      ${mail.rows.length ? html`<ul class="src">${mail.rows.map((m) => {
        const url = link(m.body)
        const signin = url?.startsWith(`${c.deps.baseUrl}/api/auth/magic-link/verify?`)
        return html`<li><span><b>${m.subject}</b><br>To ${m.to_email}${signin ? '' : html`<br><span class="meta">${m.body.split('\n')[0]}</span>`}<br><span class="meta tnum">${time(m.created_at)}</span></span>${url ? html`<a class="btn secondary sm" href="${url}">${signin ? 'Open sign-in link' : 'Open'}</a>` : ''}</li>`
      })}</ul>` : html`<div class="empty"><h3>No mail yet</h3><p>Request a sign-in link and it will appear here.</p><a class="btn secondary" href="/signin">Sign in</a></div>`}`)
  }, true)

  add('GET', '/workspaces', async (c) => {
    const list = await withUser(c.deps.db, c.user.id, (tx) =>
      tx.query<{ id: string; name: string; role: string }>(`SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = app_user_id() AND m.status = 'active' ORDER BY w.created_at`))
    const invites = await withUser(c.deps.db, c.user.id, (tx) => tx.query<{ id: string; workspace_name: string; role: Role }>('SELECT id, workspace_name, role FROM my_invitations()'))
    return plain('Workspaces', html`
      <h1 class="page-title">Your workspaces</h1>
      ${invites.rows.length ? html`<h2 class="h">Invitations</h2><ul class="src">${invites.rows.map((i) => html`<li><span>${i.workspace_name}<br><span class="meta">As ${ROLE_NAMES[i.role].toLowerCase()}</span></span>
        <form data-api="/api/v1/invitations/${i.id}/accept" data-next="/w/{id}"><button class="btn primary sm">Join</button>${err}</form></li>`)}</ul>` : ''}
      ${list.rows.length ? html`<ul class="src">${list.rows.map((w) => html`<li><a href="/w/${w.id}">${w.name}</a><span class="meta">${w.role.replace('_', ' ')}</span></li>`)}</ul>` : html`<p class="page-lede">A workspace holds one business: its facts, its WhatsApp number and its conversations.</p>`}
      <form class="form" data-api="/api/v1/workspaces" data-next="/w/{id}/business">
        <div class="field"><label for="name">Business name</label><input class="input" id="name" name="name" maxlength="200" required><span class="hint">Shown to your team, not to customers.</span></div>
        ${err}
        <div><button class="btn primary">Create workspace</button></div>
      </form>
      ${c.deps.operatorEmails.includes(c.user.email.toLowerCase()) ? html`<p><a href="/operator">Operator diagnostics</a></p>` : ''}
      <form data-api="/api/auth/sign-out" data-next="/signin"><button class="btn quiet">Sign out ${c.user.email}</button></form>`)
  })

  // ---------------------------------------------------------------- Home
  add('GET', '/w/:w', page('', 'Home', async (tx, c) => {
    const r = await readiness(tx, c.deps)
    const s = await shellData(tx)
    const waiting = (await listConversations(tx)).filter((v) => v.mode === 'handoff_requested')
    const base = `/w/${c.param('w')}`
    return html`
      <div class="home-head"><h1 class="page-title">Home</h1></div>
      <div class="state">
        <div>
          <strong>${s.paused ? html`Automation is paused ${status('warn', 'pause', 'Paused')}` : r.active ? html`Live for real customers ${status('ok', 'check', 'On')}` : html`Test mode ${c.deps.aiLive ? status('idle', 'idle', 'Not live') : MOCK}`}</strong>
          <p>${s.paused ? `The assistant is not replying. A message already submitted to WhatsApp may still arrive. ${STAFF_WHILE_PAUSED}`
            : r.active ? `Real customers are being answered. The assistant drafts each reply and a member of staff approves it before it is sent. ${PAUSE_NOTE} ${STAFF_WHILE_PAUSED}`
            : `Real customers are not answered yet. ${c.deps.aiLive ? 'Test chat uses your own AI key, so your provider charges you for it.' : 'This development build answers from a mock, not a real AI provider.'} ${PAUSE_NOTE} ${STAFF_WHILE_PAUSED}`}</p>
        </div>
        ${pauseForm(c.param('w'), s.paused)}
      </div>
      <div class="home-grid">
        <div class="block">
          <div class="block-head"><h2 class="h">Setup</h2></div>
          <ol class="steps">${r.checks.map((k, i) => html`<li class="${k.state === 'done' || k.state === 'blocked' ? k.state : ''}"><span class="dot" aria-hidden="true">${k.state === 'done' ? icon('check') : k.state === 'blocked' ? icon('alert') : i + 1}</span><span><b>${STEP_LINK[k.key] ? html`<a href="${base}/${STEP_LINK[k.key]}">${k.title}</a>` : k.title}</b><small>${k.detail}</small></span>${STEP_STATUS[k.state]}</li>`)}</ol>
          ${r.active ? '' : r.can_activate
            ? html`<div class="note" style="margin-top: var(--space-16)"><b>Ready for real customers</b><p>Every check has passed. Switching on is a separate step in <a href="${base}/settings">Settings</a>.</p></div>`
            : html`<div class="note" style="margin-top: var(--space-16)"><b>Before real customers can be answered</b><ul>${r.blockers.map((b) => html`<li>${b}</li>`)}</ul></div>`}
        </div>
        <div class="block" style="margin-top: 0">
          <div class="block-head"><h2 class="h">Waiting for your staff</h2><a href="${base}/inbox">Open inbox</a></div>
          ${waiting.length ? html`<ul class="waiting">${waiting.map((v) => html`<li><b>${who(v)}</b><span class="wait tnum">Since ${time(v.last_message_at)}</span><p>${v.handoff_reason}<br><span class="meta">${notice(v)}</span></p><a class="btn secondary sm" href="${base}/inbox/${v.id}">${v.has_draft ? 'Review draft' : 'Open'}</a></li>`)}</ul>` : html`<div class="empty" style="margin-top: var(--space-16)"><h3>No one is waiting</h3><p>Drafts that need your approval, and questions the assistant can’t answer from your published facts, appear here.</p></div>`}
          <p class="actions-row" style="margin-top: var(--space-24); font: var(--text-label)"><a href="${base}/enquiries">Enquiries</a><a href="${base}/usage">Usage and limit</a><a href="${base}/team">Team</a><a href="${base}/not-built">Not built yet</a></p>
        </div>
      </div>`
  }))

  // ---------------------------------------------------------------- Settings: reply mode, retention, going live
  add('GET', '/w/:w/settings', page('settings', 'Settings', async (tx, c, api, w) => {
    const st = await getSettings(tx)
    const r = await readiness(tx, c.deps)
    const owner = w.can('workspace.activate')
    const off = owner ? '' : html`disabled`
    return html`
      <div class="home-head"><h1 class="page-title">Settings</h1>${r.active ? status('ok', 'check', 'Live for real customers') : status('idle', 'idle', 'Not live')}</div>
      <p class="page-lede">How replies are sent, how long customer conversations are kept, and whether real customers are answered.${owner ? '' : ' Only the workspace owner can change these.'}</p>
      <div class="cols-2">
        <div class="stack" style="gap: var(--space-32)">
          <form class="form" data-api="${api}/settings" data-method="PATCH">
            <h2 class="h">How replies are sent</h2>
            <label class="choice"><input type="radio" name="reply_mode" value="supervised" ${st.reply_mode === 'supervised' ? html`checked` : ''}><span>Staff approve every reply<small>The assistant writes a draft. Nothing is sent until a person approves or edits it in the inbox.</small></span></label>
            <label class="choice"><input type="radio" name="reply_mode" value="autonomous" ${st.reply_mode === 'autonomous' ? html`checked` : ''} ${c.deps.allowAutonomous ? '' : html`disabled`}><span>Send without approval<small>${c.deps.allowAutonomous ? 'Development builds only, so the automatic path can be tested. Switching on real customers puts this back to staff approval.' : 'Not available. Automatic sending stays off until its safety checks have been passed in a supervised pilot.'}</small></span></label>
            ${err}
            <div><button class="btn secondary" ${off}>Save</button></div>
          </form>
          <form class="form" data-api="${api}/settings" data-method="PATCH">
            <h2 class="h">How long conversations are kept</h2>
            <div class="field"><label for="retention_days">Days after the last message</label><input class="input" id="retention_days" name="retention_days" inputmode="numeric" required value="${st.retention_days ?? ''}" placeholder="90">
              <span class="hint">After this, a conversation, its messages, its enquiry and the customer’s contact record are deleted automatically (checked hourly). Backups keep them until the backups themselves expire. Real customers cannot be switched on until this is set.</span></div>
            ${err}
            <div><button class="btn secondary" ${off}>Save</button></div>
          </form>
        </div>
        <div class="stack" style="gap: var(--space-32)">
          <div class="stack">
            <h2 class="h">Real customers</h2>
            ${r.active ? html`<p class="page-lede" style="margin: 0">On. Messages from real customers are answered, with every reply approved by staff first.</p>
              <form data-api="${api}/deactivate"><button class="btn danger" ${off}>Switch off for real customers</button>${err}</form>
              <p class="meta">Switching off stops all processing of customer messages. They still arrive in WhatsApp on your phone or Meta account, but nothing is drafted or sent from here.</p>`
              : r.can_activate ? html`<p class="page-lede" style="margin: 0">Every check has passed. Switching on means messages to your connected number are read by the assistant, drafted with your AI key (which your provider charges for) and sent once staff approve.</p>
              <form data-api="${api}/activate"><button class="btn primary" ${off}>Switch on for real customers</button>${err}</form>`
              : html`<p class="page-lede" style="margin: 0">Not available yet:</p><ul class="note">${r.blockers.map((b) => html`<li>${b}</li>`)}</ul>`}
          </div>
          <div class="stack">
            <h2 class="h">Deleting a customer’s data</h2>
            <p class="meta">When a customer asks, open their conversation in the inbox and choose “Delete this customer’s data”. It removes the conversation, messages, enquiry and contact record at once. Owners and admins only.</p>
          </div>
          <dl class="kv"><div><dt>Workspace ID</dt><dd><code>${st.id}</code></dd></div><div><dt>Help</dt><dd><a href="/support">Support</a> · <a href="/privacy">Privacy</a></dd></div></dl>
          <p class="meta">The platform operator needs the workspace ID to enable real customers for a pilot.</p>
        </div>
      </div>`
  }))

  // ---------------------------------------------------------------- Business inputs
  add('GET', '/w/:w/business', page('business', 'Business info', async (tx, c, api) => {
    const sources = await listSources(tx)
    const q = await nextQuestion(tx)
    return html`
      <h1 class="page-title">Business information</h1>
      <p class="page-lede">Add what your customers ask about. Everything lands in a draft; nothing is used in replies until you review and publish it.</p>
      <div class="cols-2">
        <div class="stack" style="gap: var(--space-32)">
          <form class="form" data-api="${api}/sources">
            <div class="field"><label for="text">Paste text or FAQs</label>
              <textarea class="input" id="text" name="text" rows="7" placeholder="Opening hours: Mon–Sat, 9am–6pm&#10;&#10;Q: Do you take walk-ins?&#10;A: Yes, before 4pm."></textarea>
              <span class="hint">“Name: value” lines, headings with a paragraph, and question-and-answer pairs are picked up. Up to 2 MB.</span></div>
            <div class="field"><label for="type">This is</label><span class="select"><select id="type" name="type"><option value="text">General information</option><option value="faq">Questions and answers</option></select>${icon('down')}</span></div>
            ${err}
            <div><button class="btn primary">Add to draft</button></div>
          </form>
          <form class="form" data-api="${api}/uploads">
            <div class="field"><label for="file">Upload files</label><input class="input" id="file" type="file" accept=".md,.txt,text/plain,text/markdown" multiple required style="height: auto; padding: 8px">
              <span class="hint">Markdown or plain text, UTF-8, up to 2 MB each, 10 at a time.</span></div>
            ${err}
            <div><button class="btn secondary">Upload</button></div>
          </form>
          <form class="form" data-api="${api}/sources">
            <input type="hidden" name="type" value="url">
            <div class="field"><label for="url">Website page</label><input class="input" id="url" name="url" type="url" placeholder="https://">
              <span class="hint">Reading web pages isn’t built yet. The address is saved, but paste the page’s text above for now.</span></div>
            ${err}
            <div><button class="btn secondary">Save address</button></div>
          </form>
        </div>
        <div class="stack" style="gap: var(--space-32)">
          ${q ? html`<form class="form panel" style="padding: var(--space-16)" data-api="${api}/questions/${q.id}/answer">
            <div class="field"><label for="answer" style="font: var(--text-heading)">${q.ask}</label><span class="hint">${q.reason}</span>
              <input class="input" id="answer" name="answer" maxlength="600"></div>
            ${err}
            <div class="actions-row"><button class="btn primary">Save answer</button><button class="btn quiet" name="skip" value="1">Skip, leave unknown</button><span class="meta">${q.remaining} question${q.remaining === 1 ? '' : 's'} left</span></div>
          </form>` : ''}
          <div>
            <div class="block-head"><h2 class="h">Added so far</h2><a href="/w/${c.param('w')}/knowledge">Review facts</a></div>
            ${sources.length ? html`<ul class="src">${sources.map((s) => html`<li><span>${s.metadata.filename ?? s.url ?? (s.type === 'faq' ? 'Pasted questions and answers' : 'Pasted text')}${s.status === 'failed' ? html`<br><span class="meta">Reading web pages isn’t built yet. Paste the page’s text instead.</span>` : ''}</span>${s.status === 'imported' ? status('ok', 'check', `${s.facts} fact${s.facts === 1 ? '' : 's'} found`) : status('warn', 'alert', 'Not imported')}</li>`)}</ul>` : html`<p class="page-lede">Nothing yet.</p>`}
          </div>
        </div>
      </div>`
  }))

  // ---------------------------------------------------------------- Knowledge review
  add('GET', '/w/:w/knowledge', page('knowledge', 'Knowledge', async (tx, c, api) => {
    const d = await getDraft(tx)
    const DIFF: Record<string, Raw> = {
      published: status('ok', 'check', 'Published'), changed: status('idle', 'idle', 'Changed, not published'),
      new: status('idle', 'idle', 'New, not published'), unreviewed: status('idle', 'idle', 'Needs review'),
    }
    const next = (d.published?.sequence ?? 0) + 1
    return html`
      <div class="home-head"><h1 class="page-title">Knowledge</h1>${d.published ? status('ok', 'check', `Version ${d.published.sequence} published ${time(d.published.approved_at)}`) : status('idle', 'idle', 'Nothing published')}</div>
      <p class="page-lede">The assistant answers only from the published version. Edits stay in this draft until you publish${d.published ? `, and customers keep getting version ${d.published.sequence} until then` : ''}.</p>
      <div class="cols-2">
        <div>
          ${d.conflicts ? html`<p class="note warn">${icon('alert')} Some facts disagree. Choose the right one for each before you can publish.</p>` : ''}
          ${d.pending ? html`<form class="actions-row" data-api="${api}/knowledge/draft" data-method="PATCH" style="margin-top: var(--space-12)"><input type="hidden" name="accept_all" value="1"><button class="btn secondary sm">Accept all ${d.pending} unreviewed</button><span class="meta">Read them first. Accepted facts are what customers will be told.</span>${err}</form>` : ''}
          ${d.facts.length ? d.facts.map((f) => html`<form class="fact" data-api="${api}/knowledge/draft" data-method="PATCH">
            <input type="hidden" name="id" value="${f.id}">
            <div class="fact-head"><b><label for="f-${f.id}">${f.value.label}</label></b>${f.conflict ? status('warn', 'alert', 'Conflict') : DIFF[f.diff]}</div>
            <textarea class="input" id="f-${f.id}" name="text" rows="2" maxlength="600">${f.value.text}</textarea>
            <span class="meta">${f.source ? `From ${f.source} · ` : ''}${f.evidence}</span>
            ${err}
            <div class="actions-row"><button class="btn secondary sm" name="review_state" value="accepted">${f.conflict ? 'Use this one' : f.diff === 'unreviewed' ? 'Accept' : 'Save change'}</button><button class="btn quiet sm" name="review_state" value="rejected">Remove</button></div>
          </form>`) : html`<div class="empty"><h3>No facts yet</h3><p>Add information about your business and the facts found in it appear here for review.</p><a class="btn secondary" href="/w/${c.param('w')}/business">Add information</a></div>`}
          ${d.removed.length ? html`<p class="note" style="margin-top: var(--space-16)">Publishing will remove: ${d.removed.map((r) => r.label).join(', ')}.</p>` : ''}
        </div>
        <div class="stack" style="gap: var(--space-32)">
          <form class="form" data-api="${api}/knowledge/publish">
            <h2 class="h">Publish</h2>
            <p class="page-lede" style="margin: 0">Only accepted facts are published. Unreviewed ones are left out, and anything not listed stays unknown: the assistant hands those questions to staff.</p>
            ${err}
            <div><button class="btn primary" ${d.conflicts ? html`disabled` : ''}>Publish version ${next}</button></div>
          </form>
          <form class="form" data-api="${api}/knowledge/draft" data-method="PATCH">
            <div class="field"><label for="business_type">Type of business</label><input class="input" id="business_type" name="business_type" maxlength="80" value="${d.business_type ?? ''}">
              <span class="hint">${d.type_confirmed ? 'Confirmed by you.' : d.business_type ? 'Guessed from your text. Correct it if it’s wrong.' : 'We couldn’t tell from your text. Tell us what kind of business this is.'}</span></div>
            ${err}
            <div><button class="btn secondary">Save type</button></div>
          </form>
          <form class="form" data-api="${api}/knowledge/draft" data-method="PATCH">
            <h2 class="h">Add a fact</h2>
            <div class="field"><label for="label">Name</label><input class="input" id="label" name="label" maxlength="120" placeholder="Parking"></div>
            <div class="field"><label for="newtext">What customers should be told</label><textarea class="input" id="newtext" name="text" rows="2" maxlength="600"></textarea></div>
            ${err}
            <div><button class="btn secondary">Add fact</button></div>
          </form>
        </div>
      </div>`
  }))

  // ---------------------------------------------------------------- AI provider
  add('GET', '/w/:w/ai', page('ai', 'AI provider', async (tx, c, api) => {
    const cfg = await getConfig(tx)
    const live = c.deps.aiLive
    const state = !cfg ? status('idle', 'idle', 'Not set up') : !live ? MOCK
      : cfg.state === 'valid' ? status('ok', 'check', 'Key and model checked') : cfg.state === 'invalid' ? status('bad', 'alert', 'Check failed')
      : cfg.state === 'validating' ? status('idle', 'clock', 'Checking') : status('idle', 'idle', 'Not checked yet')
    return html`
      <div class="home-head" ${cfg?.state === 'validating' ? html`data-refresh="3"` : ''}><h1 class="page-title">AI provider</h1>${state}</div>
      <p class="page-lede">The assistant uses your own account with the provider, and the provider charges you directly. Your key is stored encrypted, opened only by the background worker to make your calls, and never shown again after saving.</p>
      ${live ? '' : html`<p class="note" style="margin-top: var(--space-16)">This development build answers from a built-in mock. Your settings and key are stored, but no provider is contacted and nothing is charged.</p>`}
      <div class="cols-2">
        <form class="form" data-api="${api}/ai-configs">
          <h2 class="h">Provider and model</h2>
          <div class="field"><label for="provider">Provider</label><span class="select"><select id="provider" name="provider">${Object.entries(PROVIDERS).map(([k, v]) => html`<option value="${k}" ${k === 'anthropic' ? html`selected` : html`disabled`}>${v}${k === 'anthropic' ? '' : ' · no adapter yet'}</option>`)}</select>${icon('down')}</span></div>
          <div class="field"><label for="model_id">Model</label><span class="select"><select id="model_id" name="model_id">${SUPPORTED_MODELS.map((m) => html`<option value="${m}" ${m === cfg?.model_id ? html`selected` : ''}>${m} · $${PRICES[m]?.input} in / $${PRICES[m]?.output} out per million tokens</option>`)}</select>${icon('down')}</span>
            <span class="hint">List prices as of ${PRICE_DATE}, used to cap each call and estimate cost. Check the provider’s current prices: your invoice from them is what you actually pay.</span></div>
          ${cfg ? html`<p class="meta">Saving again starts a fresh configuration and removes the saved key, so a key is never sent to a different destination.</p>` : ''}
          ${err}
          <div><button class="btn ${cfg ? 'secondary' : 'primary'}">Save provider</button></div>
        </form>
        ${cfg ? html`<div class="stack" style="gap: var(--space-32)">
          <div class="stack">
            <h2 class="h">Your ${PROVIDERS[cfg.provider]} key</h2>
            ${cfg.key ? html`<div class="secret"><code>${cfg.key.masked_label}</code>
              <form data-api="${api}/ai-configs/${cfg.id}/secret" data-method="DELETE"><button class="btn secondary sm">Remove</button></form></div>
              <p class="meta">Removing the key here stops us using it. It does not cancel the key with ${PROVIDERS[cfg.provider]}; do that in your account there.</p>` : ''}
            <form class="form" data-api="${api}/ai-configs/${cfg.id}/secret">
              <div class="field"><label for="api_key">${cfg.key ? 'Replace key' : 'API key'}</label><input class="input" id="api_key" name="api_key" type="password" autocomplete="off" required maxlength="500">
                <span class="hint">Sent to ${PROVIDERS[cfg.provider]} only. It can be replaced or removed, never viewed. A new key needs a new check.</span></div>
              ${err}
              <div><button class="btn ${cfg.key ? 'secondary' : 'primary'}">Save key</button></div>
            </form>
          </div>
          <div class="stack">
            <h2 class="h">Check</h2>
            ${live ? html`<form class="actions-row" data-api="${api}/ai-configs/${cfg.id}/tests"><button class="btn ${cfg.state === 'valid' ? 'secondary' : 'primary'}" ${cfg.key ? '' : html`disabled`}>Run live check</button>${cfg.state === 'valid' && cfg.last_test ? status('ok', 'check', `Passed ${time(cfg.last_test.at)}`) : ''}${err}</form>
              ${cfg.state === 'invalid' ? html`<p class="note warn" role="status">${icon('alert')} The check failed: ${cfg.last_error ?? 'unknown reason'}. Nothing is generated until a check passes.</p>` : ''}
              <p class="meta">Asks the provider for this model’s details using your key. It proves the key works and the model exists. Nothing is generated, so the check itself is not charged.</p>`
              : html`<div class="actions-row"><button class="btn secondary" disabled>Run live check</button>${MOCK}</div><p class="meta">Not available in this development build because no provider is contacted.</p>`}
          </div>
        </div>` : ''}
      </div>`
  }))

  // ---------------------------------------------------------------- WhatsApp
  const ROUTE_COPY: Record<Route, { how: string; before: string; risk: string; disclosure: string }> = {
    official_cloud_api: {
      how: 'Through Meta’s WhatsApp Cloud API, with a phone number ID and an access token from your own Meta business account.',
      before: 'A WhatsApp Business Account and a number Meta has accepted for the Cloud API. Meta decides which businesses and numbers are eligible. The operator of this platform must also subscribe its Meta app to your account so messages reach us; Meta’s own sign-up window is not built.',
      risk: 'Replies can only be sent within 24 hours of the customer’s last message. Later replies need Meta-approved templates, which are not built. Meta charges per message under its own price list.',
      disclosure: 'Meta’s messaging rules and charges apply to this route and are billed to your Meta account. Meta must accept the business and the number. Replies are only possible within 24 hours of the customer’s last message; after that nothing is sent from here.',
    },
    unofficial_qr: {
      how: 'As a linked device, by scanning a QR code with the phone that has the number. It uses an open-source library that is not affiliated with or supported by WhatsApp.',
      before: 'The phone with that number, and your agreement to the risks.',
      risk: 'This is not permitted by WhatsApp as an integration. WhatsApp can ban, restrict or disconnect the number without warning. The link can drop and need scanning again, and messages can be missed while it is down.',
      disclosure: 'This route is not an official WhatsApp integration and WhatsApp does not support it. WhatsApp can ban, restrict or disconnect the number without warning, and a ban can be permanent. The link can drop and need scanning again; messages sent meanwhile are not answered. We cannot fix problems on WhatsApp’s side. Do not use a number you cannot afford to lose.',
    },
  }
  const CONN_ERROR: Record<string, string> = {
    number_mismatch: 'The number that was linked is not the one you authorised. Nothing will be sent through it.',
    number_already_connected_elsewhere: 'That number is already connected to another workspace. A number can only be connected once.',
    could_not_verify: 'WhatsApp could not be reached, or it did not recognise those details. Check the phone number ID and the token, then try again.',
    credentials_missing: 'No access token is saved for this connection.',
    logged_out: 'The device was unlinked from the phone, or WhatsApp ended the session. Remove this connection and link again.',
    link_failed: 'The link kept failing. WhatsApp may be refusing this device. Remove this connection and try again later.',
  }
  add('GET', '/w/:w/whatsapp', page('whatsapp', 'WhatsApp', async (tx, c, api, w) => {
    const conn = await currentConnection(tx)
    const sup = c.deps.support
    const mock = conn?.mode === 'mock'
    const head = (refresh = false) => html`<div class="home-head" ${refresh ? html`data-refresh="4"` : ''}><h1 class="page-title">WhatsApp</h1>${!conn ? status('idle', 'idle', 'Not connected')
      : conn.state === 'connected' ? (mock ? status('idle', 'mock', 'Mock connection') : status('ok', 'check', 'Connected'))
      : conn.state === 'needs_action' ? status('warn', 'alert', 'Needs action') : status('idle', 'clock', 'Setup in progress')}</div>`
    const cancel = (k: Connection, label: string) => html`<form data-api="${api}/connections/${k.id}/disconnect"><button class="btn ${k.state === 'connected' ? 'danger' : 'quiet'}">${label}</button>${err}</form>`
    if (!conn) return html`${head()}
      <p class="page-lede">Two ways to connect. Read the difference before you choose; only one can be open at a time.</p>
      <div class="cols-2">${(Object.keys(ROUTES) as Route[]).map((r) => {
        const on = r === 'official_cloud_api' ? sup.official : sup.qr
        return html`<article class="stack">
        <div class="fact-head"><h2 class="h">${ROUTES[r].name}</h2>${on ? status('ok', 'check', 'Available') : status('idle', 'clock', 'Not set up on this platform')}</div>
        <dl class="kv"><div><dt>How it connects</dt><dd>${ROUTE_COPY[r].how}</dd></div><div><dt>Before you start</dt><dd>${ROUTE_COPY[r].before}</dd></div><div><dt>Main risk</dt><dd>${ROUTE_COPY[r].risk}</dd></div></dl>
        ${on ? html`<form class="actions-row" data-api="${api}/connections"><input type="hidden" name="route" value="${r}"><input type="hidden" name="mode" value="live"><button class="btn primary">Set up ${ROUTES[r].name}</button>${err}</form>`
          : html`<p class="meta">${ROUTES[r].liveBlocker}</p>`}
        ${sup.mock ? html`<form class="actions-row" data-api="${api}/connections"><input type="hidden" name="route" value="${r}"><input type="hidden" name="mode" value="mock"><button class="btn secondary">Set up a mock connection</button><span class="meta">Development only</span>${err}</form>` : ''}
      </article>`
      })}</div>`
    const name = `${ROUTES[conn.route].name}${mock ? ' · mock setup' : ''}`
    const official = conn.route === 'official_cloud_api'
    const credentials = html`<form class="form" data-api="${api}/connections/${conn.id}/credentials">
      <div class="field"><label for="phone_number_id">Phone number ID</label><input class="input" id="phone_number_id" name="phone_number_id" inputmode="numeric" autocomplete="off" required maxlength="40">
        <span class="hint">From your Meta business account, under the WhatsApp number’s API setup. Digits only. It is not the phone number itself.</span></div>
      <div class="field"><label for="access_token">Access token</label><input class="input" id="access_token" name="access_token" type="password" autocomplete="off" required maxlength="1000">
        <span class="hint">A token from your Meta business account that is allowed to send messages for this number. Stored encrypted, never shown again. Temporary tokens stop working within a day.</span></div>
      ${err}
      <div><button class="btn primary">Save and check with Meta</button></div>
      <p class="meta">We ask Meta which number these details belong to. If it is not the number you authorised, nothing is connected.</p>
    </form>`
    if (conn.state === 'unconfigured') return html`${head()}
      <p class="page-lede">${name}. ${mock ? 'Nothing is linked to WhatsApp.' : 'Nothing is linked until you finish the next step.'}</p>
      <form class="form" data-api="${api}/connections/${conn.id}/start" style="margin-top: var(--space-24)">
        <p class="note warn">${ROUTE_COPY[conn.route].disclosure}</p>
        <div class="field"><label for="authorized_number">Number you want to connect</label><input class="input" id="authorized_number" name="authorized_number" inputmode="tel" autocomplete="tel" placeholder="+15550100" required>
          <span class="hint">With country code. If a different number ends up linked, nothing is sent until you sort it out.</span></div>
        <label class="choice"><input type="checkbox" name="accept" required><span>${official ? 'I understand these conditions apply to this number.' : 'I understand this is an unofficial route and I accept these risks for this number.'}</span></label>
        ${err}
        <div class="actions-row"><button class="btn primary">Continue</button></div>
      </form>${cancel(conn, 'Choose a different route')}`
    if (conn.state === 'pending_auth') {
      const expires = conn.link_expires_at
      const open = expires !== null && expires > new Date()
      const again = html`<form class="actions-row" data-api="${api}/connections/${conn.id}/start"><button class="btn primary">Start again</button>${err}</form>`
      if (mock) return html`${head()}
      <p class="page-lede">${name}.</p>
      <div class="stack" style="margin-top: var(--space-24); max-width: 560px">
        <div class="panel" style="padding: var(--space-24)"><b>${official ? 'The Cloud API details would be entered here' : 'A QR code would appear here'}</b>
          <p class="meta" style="margin-top: 4px">This is a placeholder. There is nothing to scan and nothing is sent to WhatsApp. ${open ? `This step expires at ${expires?.toLocaleTimeString('en-GB')}.` : 'This step has expired.'}</p></div>
        ${open ? html`
        <form class="actions-row" data-api="${api}/connections/${conn.id}/mock-link"><button class="btn primary">Simulate a successful link</button>${err}</form>
        <form class="form" data-api="${api}/connections/${conn.id}/mock-link">
          <div class="field"><label for="linked_number">Simulate a different number being linked</label><input class="input" id="linked_number" name="linked_number" inputmode="tel" placeholder="+15550199" required></div>
          ${err}<div><button class="btn secondary">Simulate wrong number</button></div>
        </form>` : again}
        ${cancel(conn, 'Cancel setup')}
      </div>`
      if (official) return html`${head()}
      <p class="page-lede">${name}. Enter the details for the number you authorised.</p>
      <div class="stack" style="margin-top: var(--space-24); max-width: 560px">${credentials}${cancel(conn, 'Cancel setup')}</div>`
      const code = open && w.can('connection.manage') ? await linkArtifact(tx, conn.id) : null
      return html`${head(open)}
      <p class="page-lede">${name}. Link this workspace as a device on the phone that has the number you authorised.</p>
      <div class="stack" style="margin-top: var(--space-24); max-width: 560px">
        ${open ? html`<div class="panel" style="padding: var(--space-24)">
          ${code?.svg ? html`<div style="max-width: 280px; background: #fff" role="img" aria-label="QR code to scan with WhatsApp">${raw(code.svg)}</div>` : html`<b>Waiting for a code from WhatsApp…</b>`}
          <p class="meta" style="margin-top: var(--space-12)">On the phone: WhatsApp, then Linked devices, then Link a device, and scan this code. The code changes every few seconds and this page refreshes itself. This step expires at ${expires?.toLocaleTimeString('en-GB')}.</p></div>
          <p class="note warn">${ROUTE_COPY.unofficial_qr.risk}</p>`
          : html`<p class="note">That code expired and has been cleared.</p>${again}`}
        ${cancel(conn, 'Cancel setup')}
      </div>`
    }
    if (conn.state === 'connecting') return html`${head(true)}
      <p class="page-lede">${name}. Checking with ${official ? 'Meta' : 'WhatsApp'}. This page refreshes itself.</p>
      <div style="margin-top: var(--space-16)">${cancel(conn, 'Cancel setup')}</div>`
    if (conn.state === 'needs_action') {
      const why = conn.last_error ?? conn.last_health ?? ''
      return html`${head()}
      <p class="note warn" style="margin-top: var(--space-16)">${icon('alert')} ${CONN_ERROR[why] ?? 'This connection needs your attention. Nothing is being sent through it.'}</p>
      <div class="stack" style="margin-top: var(--space-16); max-width: 560px">${official && !mock && why !== 'number_already_connected_elsewhere' ? credentials : ''}${cancel(conn, 'Remove and start again')}</div>`
    }
    return html`${head()}
      <p class="page-lede">${mock ? `${name.replace(' setup', ' connection')}. Simulated customers can message this workspace from the inbox; nothing reaches WhatsApp.` : `${name}. Messages to this number reach this workspace. Customers are only answered once real customers are switched on in Settings.`}</p>
      <dl class="kv" style="max-width: 560px; margin-top: var(--space-24)">
        <div><dt>Number</dt><dd class="tnum">${conn.masked_number}</dd></div>
        <div><dt>Route</dt><dd>${ROUTES[conn.route].name}</dd></div>
        <div><dt>Checked</dt><dd class="tnum">${conn.last_health_at ? time(conn.last_health_at) : 'Never'}${mock ? ' (mock)' : ''}</dd></div>
      </dl>
      ${mock ? '' : html`<p class="note warn" style="margin-top: var(--space-16)">${ROUTE_COPY[conn.route].risk}</p>`}
      <div class="stack" style="margin-top: var(--space-24); max-width: 560px"><p class="meta">Disconnecting stops replies first, then removes the link here. A message already submitted may still arrive. ${mock ? '' : official ? 'It does not cancel the token with Meta; do that in your Meta account.' : 'Also remove the linked device in WhatsApp on the phone.'}</p>${cancel(conn, 'Disconnect')}</div>`
  }))

  // ---------------------------------------------------------------- Test chat
  add('GET', '/w/:w/test', page('test', 'Test chat', async (tx, c, api) => {
    const k = await published(tx)
    const live = c.deps.aiLive
    const cfg = await getConfig(tx)
    const runs = (await tx.query<{ mode: string; results: { question: string; reply: string; outcome: string; fact_path?: string; reason?: string; knowledge_sequence: number } }>(
      `SELECT mode, results FROM (SELECT mode, results, created_at FROM test_runs WHERE type = 'sample_chat' ORDER BY created_at DESC LIMIT 20) t ORDER BY created_at`)).rows
    const badge = live ? status('idle', 'idle', 'Not sent to anyone') : MOCK
    if (!k) return html`<div class="home-head"><h1 class="page-title">Test chat</h1>${badge}</div>
      <div class="empty" style="margin-top: var(--space-24)"><h3>Publish your knowledge first</h3><p>The assistant only answers from published facts, so there is nothing to test yet.</p><a class="btn secondary" href="/w/${c.param('w')}/knowledge">Review knowledge</a></div>`
    return html`<div class="home-head"><h1 class="page-title">Test chat</h1>${badge}</div>
      <p class="page-lede">${live
        ? `Ask what your customers ask. Replies come from ${cfg?.model_id ?? 'your AI provider'} on your own key, using published version ${k.sequence} and your published assistant instructions. Each question is a real call that your provider charges you for, and it counts against your spending limit. Nothing is sent to WhatsApp.`
        : `Ask what your customers ask. Replies come from published version ${k.sequence} through a development mock that looks up your facts. No AI provider is used, so wording will differ from live replies, and assistant instructions are not applied. Each question counts a synthetic 1 cent against your spending limit; nothing is charged.`}</p>
      <div class="panel" style="margin-top: var(--space-24); max-width: 720px; overflow: hidden">
        <div class="msgs" style="min-height: 160px">${runs.length ? runs.map((r) => html`<div class="bubble">${r.results.question}</div>
          <div class="bubble out">${r.results.reply}<span class="meta">${r.mode === 'live' ? '' : 'Mock · '}${r.results.outcome === 'answered' ? `answered from “${r.results.fact_path}”` : r.results.outcome === 'clarify' ? 'asked the customer to clarify' : `would go to staff: ${r.results.reason}`} · version ${r.results.knowledge_sequence}</span></div>`) : html`<span class="day">No questions asked yet</span>`}</div>
        <form class="composer" data-api="${api}/sample-chats">
          <label class="sr-only" for="message">Ask as a customer</label>
          <textarea class="input" id="message" name="message" rows="2" maxlength="2000" required placeholder="Are you open on Sunday?"></textarea>
          <button class="btn primary">${icon('send')}Ask</button>
          ${err}
        </form>
      </div>`
  }))

  // ---------------------------------------------------------------- Inbox
  const inbox = (thread: boolean): Handler => page('inbox', 'Inbox', async (tx, c, api, w) => {
    const base = `/w/${c.param('w')}/inbox`
    const convs = await listConversations(tx)
    const conn = await currentConnection(tx)
    const open = thread ? await listMessages(tx, c.param('c')) : null
    const { paused } = await shellData(tx)
    const mock = conn?.mode === 'mock'
    const bot = c.deps.aiLive ? 'Assistant' : 'Assistant (mock)'
    const simulate = (label: string, from?: string) => mock && conn.state === 'connected'
      ? html`<details class="sim"><summary>${label}</summary>
        <form class="form" data-api="${api}/connections/${conn.id}/mock-inbound" data-next="${base}/{id}">
          ${from ? html`<input type="hidden" name="from" value="${from}">` : html`<div class="field"><label for="from">Customer number</label><input class="input" id="from" name="from" inputmode="tel" value="+15550142" required></div>`}
          <div class="field"><label for="sim-${from ? 'next' : 'new'}">Customer message</label><input class="input" id="sim-${from ? 'next' : 'new'}" name="text" maxlength="2000" required></div>
          ${err}<div><button class="btn secondary sm">Send as customer</button></div>
        </form></details>`
      : !conn && c.deps.support.mock ? html`<p class="sim meta">Set up a <a href="/w/${c.param('w')}/whatsapp">mock WhatsApp connection</a> to simulate customers.</p>` : ''
    const v = open?.conversation
    const sendState = (m: { state: string; error_code: string | null }) => {
      const code = m.error_code ?? m.state
      return mock && code === 'accepted' ? 'Accepted by the mock, not delivered to anyone'
        : SEND_STATE[code] ?? (/^(meta_error_|http_)/.test(code) ? `Not sent · WhatsApp refused it (${code.replace(/_/g, ' ')})` : m.state === 'failed' ? 'Not sent' : m.state)
    }
    const waitingNote = (k: ConversationRow) => k.has_draft ? 'A drafted reply is waiting for your approval. Nothing has been sent.' : `Waiting for staff: ${k.handoff_reason ?? 'the assistant could not answer'}.`
    return html`<section class="view two" id="v-inbox" aria-label="Inbox">
      <div class="pane convs">
        <div class="pane-head"><h1 class="page-title">Inbox</h1></div>
        ${convs.length ? html`<ul class="pane-scroll">${convs.map((k) => html`<li><a href="${base}/${k.id}" ${k.id === v?.id ? html`aria-current="true"` : ''}><b>${who(k)}</b><span class="meta tnum">${time(k.last_message_at)}</span><p>${k.preview}</p>${k.has_draft ? status('warn', 'alert', 'Draft to approve') : MODE[k.mode]}</a></li>`)}</ul>`
          : html`<div class="pane-scroll" style="padding: var(--space-16)"><div class="empty"><h3>No conversations yet</h3><p>Customer chats appear here${mock ? '. With a mock connection you can simulate one below' : ''}.</p></div></div>`}
        ${simulate('Simulate a new customer message (mock)')}
      </div>
      <div class="pane thread">${v && open ? html`
        <div class="pane-head">
          <a class="btn quiet square back" href="${base}" aria-label="Back to conversations">${icon('back', true)}</a>
          <span class="who"><b>${who(v)}</b><span class="meta tnum">••• ${v.number} · ${mock ? 'mock connection' : conn ? ROUTES[conn.route].name : 'not connected'}</span></span>
        </div>
        <div class="mode">
          <span>${icon(v.mode === 'human' ? 'users' : v.mode === 'handoff_requested' ? 'alert' : 'idle')}${v.mode === 'human' ? (v.assigned_to_me ? 'You’re replying. The assistant is off for this chat.' : 'A teammate is replying. The assistant is off for this chat.') : v.mode === 'handoff_requested' ? `${waitingNote(v)} ${notice(v)}` : paused ? 'Automation is paused, so the assistant is not answering this chat. Take over to reply yourself.' : 'The assistant is answering this chat. Taking over stops new automated replies; one already submitted may still arrive.'}</span>
          ${v.mode === 'human' ? html`<form data-api="${api}/conversations/${v.id}/resume"><button class="btn secondary sm">Hand back to assistant</button>${err}</form>` : html`<form data-api="${api}/conversations/${v.id}/takeover"><button class="btn secondary sm">Take over</button>${err}</form>`}
        </div>
        <div class="pane-scroll msgs">${open.messages.map((m) => m.direction === 'inbound'
          ? html`<div class="bubble">${m.body}<span class="meta tnum">${time(m.created_at)}</span></div>`
          : m.state === 'draft' ? html`<div class="bubble out uncertain">
            <form class="form" data-api="${api}/conversations/${v.id}/drafts/${m.id}/approve">
              <label for="d-${m.id}"><b>Draft from the ${bot.toLowerCase()}</b> · not sent · ${time(m.created_at)}</label>
              <textarea class="input" id="d-${m.id}" name="text" rows="4" maxlength="2000" required>${m.body}</textarea>
              ${err}
              <div><button class="btn primary sm">${icon('send')}Approve and send</button></div>
            </form>
            <form data-api="${api}/conversations/${v.id}/drafts/${m.id}/discard" style="margin-top: var(--space-8)"><button class="btn quiet sm">Discard and reply myself</button>${err}</form>
            <span class="meta">You can edit the text before sending. What you approve is sent as written${mock ? ' (to the mock)' : ''}.</span></div>`
          : html`<div class="bubble out${m.state === 'uncertain' ? ' uncertain' : ''}">${m.body}<span class="meta tnum">${m.sender === 'bot' ? bot : 'Staff'} · ${time(m.created_at)} · ${sendState(m)}</span></div>`)}</div>
        ${v.mode === 'human' ? html`<form class="composer" data-api="${api}/conversations/${v.id}/reply">
          <input type="hidden" name="idempotency_key" value="${randomUUID()}">
          <label class="sr-only" for="reply">Reply as staff</label>
          <textarea class="input" id="reply" name="text" rows="2" maxlength="2000" required></textarea>
          <button class="btn primary">${icon('send')}Send</button>
          <span class="meta">${mock ? `Mock send from ${conn?.masked_number ?? 'a disconnected number'}. Nothing leaves this machine.` : `Sends to the customer on WhatsApp from ${conn?.masked_number ?? 'a disconnected number'}.`}${paused ? ' Automation is paused; your replies still send.' : ''}</span>${err}
        </form>` : html`<p class="composer meta">${v.has_draft ? 'Approve or discard the draft above, or take over to write your own reply.' : 'Take over to reply yourself.'}</p>`}
        ${simulate('Simulate this customer’s next message (mock)', v.full_number)}
        ${w.can('member.manage') ? html`<details class="sim"><summary>Delete this customer’s data</summary>
          <form class="form" data-api="${api}/conversations/${v.id}" data-method="DELETE" data-next="${base}">
            <p class="meta">Removes this conversation, its messages, its enquiry and the customer’s contact record now. It cannot be undone here; backups keep a copy until they expire. Messages already delivered stay on the customer’s phone.</p>
            ${err}<div><button class="btn danger sm">Delete permanently</button></div>
          </form></details>` : ''}`
        : html`<div class="pane-scroll" style="padding: var(--space-24)"><p class="page-lede">Choose a conversation.</p></div>`}
      </div>
    </section>`
  }, thread ? 'thread' : 'inbox')
  add('GET', '/w/:w/inbox', inbox(false))
  add('GET', '/w/:w/inbox/:c', inbox(true))

  // ---------------------------------------------------------------- Assistant settings
  add('GET', '/w/:w/assistant', page('assistant', 'Assistant', async (tx, c, api) => {
    const b = await getBehavior(tx)
    const v = b.draft ?? b.published
    return html`
      <div class="home-head"><h1 class="page-title">Assistant</h1>${b.published.sequence ? status('ok', 'check', `Version ${b.published.sequence} published`) : status('idle', 'idle', 'Using defaults')}</div>
      <p class="page-lede">How the assistant behaves when it can’t answer. Changes are saved as a draft; customers get the published version until you publish again.</p>
      <div class="cols-2">
        <form class="form" data-api="${api}/behavior/draft" data-method="PATCH">
          <div class="field"><label for="handoff_message">What to say when handing over to staff</label><textarea class="input" id="handoff_message" name="handoff_message" rows="3" maxlength="300" required>${v.handoff_message}</textarea>
            <span class="hint">Sent when a question isn’t covered by your published facts or the customer asks for a person. Staff are emailed when this happens. Don’t promise a response time you can’t keep.</span></div>
          <fieldset class="field" style="border: 0; padding: 0"><legend class="label" style="font: var(--text-label); font-weight: 600">Details to note down for an enquiry</legend>
            ${(Object.keys(ENQUIRY_FIELDS) as EnquiryField[]).map((f) => html`<label class="choice"><input type="checkbox" name="field_${f}" ${v.enquiry_fields.includes(f) ? html`checked` : ''}><span>${ENQUIRY_FIELDS[f]}<small>Only if the customer offers it. The assistant never asks for more than this.</small></span></label>`)}
            <span class="hint">What the customer asked for is always noted.</span></fieldset>
          <div class="field"><label for="instructions">Instructions for the assistant</label><textarea class="input" id="instructions" name="instructions" rows="4" maxlength="2000">${v.instructions}</textarea>
            <span class="hint">Tone and house style, for example “Keep replies short and friendly”. Instructions cannot add facts or allow anything the fixed limits below forbid. Published instructions apply from the next reply.</span>
            ${c.deps.aiLive ? '' : html`<p class="note warn">${icon('alert')} This development build answers from a mock that does not apply these instructions. They take effect with a real AI provider.</p>`}</div>
          ${err}
          <div><button class="btn secondary">Save draft</button></div>
        </form>
        <div class="stack">
          <h2 class="h">Publish</h2>
          <p class="page-lede" style="margin: 0">${b.draft ? 'You have saved changes that customers are not getting yet.' : 'No unpublished changes.'}</p>
          <form class="actions-row" data-api="${api}/behavior/publish"><button class="btn primary" ${b.draft ? '' : html`disabled`}>Publish version ${b.draft?.sequence ?? b.published.sequence + 1}</button>${err}</form>
          <p class="meta">These limits always apply and cannot be changed here: the assistant never quotes a fact that isn’t published, never takes payments or confirms bookings, treats what customers write as questions and never as instructions, and stops when you pause or take over. A reply containing a number that is not in your published facts is not sent; it goes to staff.</p>
        </div>
      </div>`
  }))

  // ---------------------------------------------------------------- Enquiries
  add('GET', '/w/:w/enquiries', page('enquiries', 'Enquiries', async (tx, c, api) => {
    const list = await listEnquiries(tx)
    const LABEL: Record<string, Raw> = { new: status('idle', 'idle', 'New'), open: status('warn', 'clock', 'Open'), closed: status('ok', 'check', 'Closed') }
    return html`
      <div class="home-head"><h1 class="page-title">Enquiries</h1></div>
      <p class="page-lede">What customers asked for when the assistant handed them to staff, with any details they offered. Changing a status is a note for your team; it does not contact the customer.</p>
      ${list.length ? html`<table class="table" style="margin-top: var(--space-24)">
        <thead><tr><th>Customer</th><th>Asked for</th><th>Details given</th><th>Received</th><th>Status</th></tr></thead>
        <tbody>${list.map((e) => html`<tr>
          <td><a href="/w/${c.param('w')}/inbox/${e.conversation_id}">••• ${e.number}</a></td>
          <td class="wide">${e.fields.wants}</td>
          <td data-label="Details given">${[e.fields.name, e.fields.email].filter(Boolean).join(' · ') || 'None'}</td>
          <td data-label="Received" class="tnum">${time(e.created_at)}</td>
          <td><form class="actions-row" data-api="${api}/enquiries/${e.id}" data-method="PATCH">${LABEL[e.status]}
            <label class="sr-only" for="st-${e.id}">Status for enquiry from ${e.number}</label>
            <span class="select"><select id="st-${e.id}" name="status">${['new', 'open', 'closed'].map((s) => html`<option value="${s}" ${s === e.status ? html`selected` : ''}>${s[0]?.toUpperCase()}${s.slice(1)}</option>`)}</select>${icon('down')}</span>
            <button class="btn secondary sm">Save</button>${err}</form></td>
        </tr>`)}</tbody></table>`
        : html`<div class="empty" style="margin-top: var(--space-24)"><h3>No enquiries yet</h3><p>When the assistant hands a conversation to staff, what the customer asked for is noted here.</p></div>`}
      <p class="meta" style="margin-top: var(--space-16)">Details are picked out by fixed patterns, not by the AI. CSV export and assigning to a teammate are not built yet.</p>`
  }))

  // ---------------------------------------------------------------- Usage and spending limit
  add('GET', '/w/:w/usage', page('usage', 'Usage and limit', async (tx, c, api) => {
    const u = await usageSummary(tx)
    const live = c.deps.aiLive
    const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })
    const l = u.limit
    const used = l ? l.settled_micros + l.reserved_micros : 0
    const pct = l?.hard_limit_micros ? Math.min(100, Math.round((used / l.hard_limit_micros) * 100)) : 0
    const CAT: Record<string, string> = { reply_generation: 'Replies written for customers', test_chat: 'Test chat questions', whatsapp_message: 'WhatsApp messages with a receipt from Meta' }
    return html`
      <div class="home-head"><h1 class="page-title">Usage and limit</h1>${live ? status('idle', 'info', 'Estimates') : MOCK}</div>
      <p class="page-lede">The spending limit is a hard stop: when it is reached the assistant generates nothing more and hands conversations to staff. It never switches to another provider or account.</p>
      ${live ? html`<p class="note" style="margin-top: var(--space-16)"><b>These are estimates, not bills.</b> AI cost is the number of tokens your provider reported for each call, multiplied by its list price on ${PRICE_DATE}. It is not reconciled with your provider’s invoice, which is what you actually pay. WhatsApp charges are billed by Meta to your Meta account: this page counts messages and shows how many Meta marked as billable, but does not know Meta’s rates, so they are not in the dollar figures.</p>`
        : html`<p class="note" style="margin-top: var(--space-16)"><b>Synthetic costs.</b> In this development build every figure is a made-up 1 cent per generated reply, so you can see the limit work. It is not a price or an estimate of one. No provider is contacted and nothing is charged.</p>`}
      <div class="cols-2">
        <div class="stack">
          <h2 class="h">Monthly limits</h2>
          ${l ? html`<div class="cap tnum">
            <div class="row"><span><b>${money(used)}</b> of ${money(l.hard_limit_micros)} this month</span><span class="meta">${live ? 'AI, estimated' : 'Synthetic 1¢ per reply'}</span></div>
            <div class="cap-bar" role="img" aria-label="${pct} percent of this month’s limit used"><i style="width: ${pct}%"></i></div>
            <p class="meta">${money(l.settled_micros)} recorded since ${day(l.period_start)} · ${money(l.reserved_micros)} set aside for calls in progress. The count starts again on ${day(l.resets_on)}.${used >= l.hard_limit_micros ? ' The limit is reached: replies are stopped and conversations go to staff.' : ''}</p>
            <p class="meta">${l.message_cap === null ? 'No WhatsApp message cap is set.' : `${l.messages_used} of ${l.message_cap} WhatsApp messages sent this month.${l.messages_used >= l.message_cap ? ' The cap is reached: nothing more is sent to real customers this month.' : ''}`}</p>
          </div>` : html`<p class="note warn">No limit is set. Nothing is generated, in test chat or for customers, until you set one.</p>`}
          <form class="form" data-api="${api}/limits" data-method="PATCH">
            <div class="field"><label for="amount">${l ? 'Change monthly AI spending limit' : 'Set monthly AI spending limit'} (US dollars)</label><input class="input" id="amount" name="amount" inputmode="decimal" required value="${l ? (l.hard_limit_micros / 1e6).toFixed(2) : ''}" placeholder="20.00">
              <span class="hint">Per calendar month (UTC). Before each AI call the most it could cost is set aside; if that would pass the limit, the call is not made.</span></div>
            <div class="field"><label for="message_cap">Monthly WhatsApp message cap</label><input class="input" id="message_cap" name="message_cap" inputmode="numeric" value="${l?.message_cap ?? ''}" placeholder="500">
              <span class="hint">The most messages sent to real customers in a month, counted before each send. Needed before real customers can be switched on, because Meta’s per-message charges are not known here.</span></div>
            <p class="meta">Only the workspace owner can change these, and neither can be set below what is already used this month.</p>
            ${err}
            <div><button class="btn ${l ? 'secondary' : 'primary'}">Save limits</button></div>
          </form>
        </div>
        <div class="stack">
          <h2 class="h">What used it this month</h2>
          ${u.by_category.length ? html`<dl class="figures">${u.by_category.map((r) => html`<div><dt>${CAT[r.category] ?? r.category} · ${r.n}<br><small>${r.category === 'whatsapp_message' ? `${r.billable} marked billable by Meta · ` : r.input_tokens || r.output_tokens ? `${r.input_tokens.toLocaleString('en-GB')} tokens in, ${r.output_tokens.toLocaleString('en-GB')} out · ` : ''}${r.provenance}</small></dt><dd>${r.cost === null ? 'Billed by Meta' : money(r.cost)}</dd></div>`)}</dl>` : html`<p class="page-lede" style="margin: 0">Nothing used yet.</p>`}
        </div>
      </div>`
  }))

  // ---------------------------------------------------------------- Team
  add('GET', '/w/:w/team', page('team', 'Team', async (tx, _c, api, w) => {
    const members = await listMembers(tx)
    const manage = w.can('member.manage')
    const roles = (['support_agent', 'admin'] as const).filter((r) => canManage(w.role, r))
    const select = (id: string, label: string, current?: Role) => html`<label class="sr-only" for="${id}">${label}</label><span class="select"><select id="${id}" name="role">${roles.map((r) => html`<option value="${r}" ${r === current ? html`selected` : ''}>${ROLE_NAMES[r]}</option>`)}</select>${icon('down')}</span>`
    return html`
      <div class="home-head"><h1 class="page-title">Team</h1>${DEV ? status('idle', 'mock', 'Simulated email') : ''}</div>
      <p class="page-lede">Who can work in this workspace and what they can do. Removing someone takes effect on their next click.</p>
      <div class="cols-2">
        <div>
          <ul class="src">${members.map((m) => html`<li>
            <span>${m.email}${m.is_me ? ' (you)' : ''}<br><span class="meta">${ROLE_NAMES[m.role]}${m.status === 'invited' ? ' · invited, has not joined yet' : ''}</span></span>
            ${manage && !m.is_me && canManage(w.role, m.role) ? html`<span class="actions-row">
              <form class="actions-row" data-api="${api}/members/${m.id}" data-method="PATCH">${select(`role-${m.id}`, `Role for ${m.email}`, m.role)}<button class="btn secondary sm">Save role</button>${err}</form>
              <form data-api="${api}/members/${m.id}" data-method="DELETE"><button class="btn quiet sm" aria-label="Remove ${m.email}">Remove</button>${err}</form>
            </span>` : m.status === 'invited' ? status('idle', 'clock', 'Invited') : ''}
          </li>`)}</ul>
          ${manage ? '' : html`<p class="meta" style="margin-top: var(--space-16)">Only owners and admins can invite or remove people.</p>`}
        </div>
        <div class="stack" style="gap: var(--space-32)">
          ${manage ? html`<form class="form" data-api="${api}/members">
            <h2 class="h">Invite someone</h2>
            <div class="field"><label for="invite-email">Email</label><input class="input" id="invite-email" name="email" type="email" autocomplete="off" maxlength="254" required></div>
            <div class="field"><span class="label" style="font: var(--text-label); font-weight: 600">Role</span>${select('invite-role', 'Role')}</div>
            ${err}
            <div><button class="btn primary">Send invitation</button></div>
            <p class="meta">${DEV ? 'Simulated: the invitation is written to the local mailbox on this machine, not emailed.' : 'They are emailed a link.'} They join by signing in with that address.</p>
          </form>` : ''}
          <div class="stack">
            <h2 class="h">What each role can do</h2>
            <dl class="kv">${(Object.keys(ROLE_NAMES) as Role[]).map((r) => html`<div><dt>${ROLE_NAMES[r]}</dt><dd>${ROLE_CAN[r]}</dd></div>`)}</dl>
            <p class="meta">Not built: transferring ownership, giving an admin extra permissions such as publishing, and choosing who gets staff alerts (every active member does).</p>
          </div>
        </div>
      </div>`
  }))

  // ---------------------------------------------------------------- Operator diagnostics
  // Platform support, not a workspace screen. Counts, states and IDs only.
  add('GET', '/operator', async (c) => {
    const d = await diagnostics(c)
    const ago = (s: number) => (s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`)
    const table = (head: string[], rows: (string | number | Raw)[][], empty: string) => rows.length
      ? html`<table class="table"><thead><tr>${head.map((h) => html`<th>${h}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map((v, i) => html`<td ${i ? html`data-label="${head[i] ?? ''}"` : ''} class="tnum${i === 0 ? ' wide' : ''}">${v}</td>`)}</tr>`)}</tbody></table>`
      : html`<p class="meta">${empty}</p>`
    const alive = d.workers.filter((w) => w.seconds_ago < 30)
    const JOB_STATE: Record<string, Raw> = { dead_letter: status('bad', 'alert', 'Gave up'), retry_wait: status('warn', 'clock', 'Will retry'), lease_expired: status('warn', 'alert', 'Worker stopped mid-job') }
    const h2 = (t: string) => html`<h2 class="h" style="margin-top: var(--space-32)">${t}</h2>`
    return doc('Operator diagnostics', 'plain', html`<main><div class="auth" style="max-width: 960px">
      <div class="home-head"><h1 class="page-title">Operator diagnostics</h1>${d.sending_stopped ? status('bad', 'pause', 'All sending stopped') : alive.length ? status('ok', 'check', 'Worker running') : status('bad', 'alert', 'No worker running')}</div>
      <p class="page-lede">Health of the whole installation. Counts, states and IDs only: no messages, customer numbers, emails or keys. Opening this page and every action on it is recorded below.</p>
      <dl class="figures" style="margin-top: var(--space-24)">
        <div><dt>Workspaces</dt><dd>${d.workspaces.total}</dd></div>
        <div><dt>With automation paused</dt><dd>${d.workspaces.automation_paused}</dd></div>
        <div><dt>Jobs completed in 24 hours</dt><dd>${d.jobs_completed_24h}</dd></div>
      </dl>
      ${h2('Stop all sending')}
      <p class="meta">${d.sending_stopped ? 'Stopped. Nothing is being sent for any workspace: not assistant replies, not approved drafts, not staff replies. Messages that reach the send step while stopped are marked not sent; they are not sent later.' : 'Sending is allowed. Stopping takes effect at the next send for every workspace, because each send checks this immediately before it goes.'}</p>
      <form data-api="/api/v1/operator/sending"><input type="hidden" name="stopped" value="${d.sending_stopped ? 'false' : 'true'}"><button class="btn ${d.sending_stopped ? 'secondary' : 'danger'}">${d.sending_stopped ? 'Allow sending again' : 'Stop all sending'}</button>${err}</form>
      ${h2('Enable real customers for a workspace')}
      <form class="form" data-api="/api/v1/operator/workspaces/{workspace_id}/live" style="max-width: 560px">
        <div class="field"><label for="workspace_id">Workspace ID</label><input class="input" id="workspace_id" name="workspace_id" required pattern="[0-9a-f-]{36}" autocomplete="off"><span class="hint">From the workspace’s Settings page. Enabling does not switch anything on: the owner still has to pass every check and switch on themselves.</span></div>
        ${err}
        <div class="actions-row"><button class="btn secondary" name="allow" value="true">Enable</button><button class="btn quiet" name="allow" value="false">Withdraw</button></div>
      </form>
      ${h2('Workers')}
      ${table(['Worker', 'Last seen'], d.workers.map((w) => [w.name, ago(w.seconds_ago)]), 'No worker has reported in the last day. Queued work is not being done.')}
      ${h2('Jobs needing attention')}
      ${table(['Job', 'Kind', 'State', 'Attempts', 'Workspace', 'Last change'], d.jobs_needing_attention.map((j) => [j.id, j.kind, JOB_STATE[j.state] ?? j.state, `${j.attempts} of ${j.max_attempts}`, j.workspace_id, time(new Date(j.updated_at))]), 'None. Nothing is waiting to retry, abandoned or stuck.')}
      ${h2('Unfinished jobs')}
      ${table(['Kind', 'State', 'Count', 'Oldest'], d.jobs_open.map((j) => [j.kind, j.state, j.n, ago(j.oldest_seconds)]), 'No unfinished jobs.')}
      ${h2('Sends in 24 hours')}
      ${table(['State', 'Reason', 'Count'], d.sends_24h.map((x) => [x.state, x.error_code ?? '—', x.n]), 'Nothing was sent.')}
      ${h2('Staff notices')}
      ${table(['State', 'Count'], d.staff_notices.map((x) => [x.state, x.n]), 'No handoffs yet.')}
      ${h2('WhatsApp connections')}
      ${table(['Route', 'Mode', 'State', 'Count'], d.connections.map((x) => [ROUTES[x.route as Route]?.name ?? x.route, x.mode, x.state, x.n]), 'No connections.')}
      ${h2('Operator activity')}
      ${table(['When', 'Operator', 'Action', 'Target'], d.audit.map((a) => [time(new Date(a.created_at)), a.operator_email, a.action, Object.values(a.target).join(' ') || '—']), 'Nothing recorded yet.')}
      <p style="margin-top: var(--space-32)"><a href="/workspaces">Back to workspaces</a></p>
    </div></main>`)
  })

  // ---------------------------------------------------------------- Privacy and support (open pages)
  add('GET', '/support', async (c) => plain('Support', html`
    <h1 class="page-title">Support</h1>
    ${c.deps.supportEmail ? html`<p class="page-lede">A person reads support email. Write to <a href="mailto:${c.deps.supportEmail}">${c.deps.supportEmail}</a>.</p>
      <p class="note">Don’t send API keys, access tokens or customers’ messages by email. If something is being sent that shouldn’t be, use “Pause automation” in your workspace first: it stops new automated replies straight away.</p>`
      : html`<p class="note warn">No support contact is configured for this installation, so real customers cannot be switched on.</p>`}
    <p class="meta">If you are a customer of a business that uses this service, contact that business directly. They decide what is kept about your conversation and can delete it.</p>
    <p><a href="/">Back</a></p>`), true)

  add('GET', '/privacy', async (c) => plain('Privacy', html`
    <h1 class="page-title">Privacy</h1>
    <p class="page-lede">What this service stores and where it sends it. It describes what the software does; it is not legal advice. Each business using it is responsible for its own privacy notice to its customers.</p>
    <dl class="kv" style="margin-top: var(--space-24)">
      <div><dt>What is stored</dt><dd>For each business: its team’s email addresses, the business information it adds, and its settings. For each of its customers who writes in: their WhatsApp number, profile name if WhatsApp provides one, the messages exchanged, and any enquiry details they offer.</dd></div>
      <div><dt>Where it goes</dt><dd>To draft a reply, the customer’s recent messages and the business’s published facts are sent to the AI provider the business chose, using the business’s own account. Replies are sent through WhatsApp. Sign-in links, invitations and staff alerts are sent by email; staff alerts contain a reason and a link, never the customer’s message or full number.</dd></div>
      <div><dt>Who can see it</dt><dd>Only members of that business’s workspace. Businesses cannot see each other’s data. The platform operator sees counts, states and IDs for support, not message text, numbers or keys, and each use of the operator screen is recorded.</dd></div>
      <div><dt>Keys</dt><dd>API keys and access tokens are encrypted, never displayed after saving, and can be replaced or removed at any time.</dd></div>
      <div><dt>How long</dt><dd>Each business sets how many days conversations are kept after the last message; they are then deleted automatically. A business can delete one customer’s data at once on request. Backups keep deleted data until the backups expire.</dd></div>
      <div><dt>Automated replies</dt><dd>Replies are drafted by an AI model and approved by a member of the business’s staff before they are sent.</dd></div>
      <div><dt>Contact</dt><dd>${c.deps.supportEmail ? html`<a href="mailto:${c.deps.supportEmail}">${c.deps.supportEmail}</a>` : 'No contact is configured for this installation.'} Customers of a business should contact that business.</dd></div>
    </dl>
    <p><a href="/">Back</a></p>`), true)

  // ---------------------------------------------------------------- Explicitly unfinished
  add('GET', '/w/:w/not-built', page('not-built', 'Not built yet', async () => html`
    <h1 class="page-title">Not built yet</h1>
    <p class="page-lede">These are part of the product and are not in this build. They are listed so nothing looks finished that isn’t.</p>
    <ul class="src" style="max-width: 720px; margin-top: var(--space-24)">
      ${[
        ['Sending without staff approval', 'Every reply to a real customer is approved by a person. Automatic sending stays off until it has passed its safety checks in a supervised pilot.'],
        ['Replies after 24 hours (official route)', 'Meta only allows free-form replies within 24 hours of the customer’s last message. Later replies need Meta-approved templates, which are not built.'],
        ['Meta’s sign-up window', 'The official route takes a phone number ID and token from your own Meta account, and the operator links the platform’s Meta app to it. Meta’s Embedded Signup is not built.'],
        ['Pictures, voice notes and files', 'Only text is read. Anything else from a customer goes to staff, who see that something arrived but not its content.'],
        ['Other AI providers', 'Only Claude (Anthropic API) has an adapter. The others are listed but cannot be chosen.'],
        ['Bills', 'Costs shown are estimates from reported usage. They are not reconciled with your AI provider’s or Meta’s invoices.'],
        ['Team extras', 'Transferring ownership, giving an admin extra permissions such as publishing, declining an invitation, and choosing who gets staff alerts.'],
        ['Operator tools', 'Retrying or cancelling a job by hand, and time-limited support access to a workspace.'],
        ['Reading web pages', 'Addresses are saved but not fetched. Paste the text instead.'],
        ['Export and closing a workspace', 'Conversations can be deleted per customer and by retention period. Exporting them and closing a whole workspace are not built.'],
        ['Usage history', 'Earlier months are stored but only the current month is shown.'],
      ].map(([t, d]) => html`<li><span><b>${t}</b><br><span class="meta">${d}</span></span>${status('idle', 'clock', 'Not built')}</li>`)}
    </ul>`))
}
