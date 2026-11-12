// Server-rendered screens. Read-only: every change goes through the control API (public/app.js).
import { randomUUID } from 'node:crypto'
import { one, withUser, type Tx, type WorkspaceContext } from '@lathar/database'
import { getConfig, PROVIDERS } from './ai.ts'
import { ws } from './api.ts'
import { Redirect, type Add, type Ctx, type Handler } from './app.ts'
import { ENQUIRY_FIELDS, getBehavior, listEnquiries, type EnquiryField } from './assistant.ts'
import { html, type Raw } from './http.ts'
import { listConversations, listMessages, type ConversationRow } from './inbox.ts'
import { getDraft, listSources, nextQuestion, published } from './knowledge.ts'
import { readiness, type Check } from './readiness.ts'
import { usageSummary } from './usage.ts'
import { currentConnection, ROUTES, type Connection, type Route } from './whatsapp.ts'

const icon = (name: string, lg = false) => html`<svg class="icon${lg ? ' lg' : ''}"><use href="#i-${name}"/></svg>`
const status = (kind: 'ok' | 'warn' | 'bad' | 'idle', i: string, text: string) => html`<span class="status ${kind}">${icon(i)}${text}</span>`
const MOCK = status('idle', 'mock', 'Mock only')
const time = (d: Date) => d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const err = html`<p class="form-err" role="alert"></p>`

const doc = (title: string, view: string, body: Raw) => html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Receptionist</title>
<link rel="stylesheet" href="/styles/tokens.css">
<link rel="stylesheet" href="/styles/ui.css">
<link rel="stylesheet" href="/styles/app.css">
</head>
<body data-view="${view}">
<div class="proto-bar"><span>Local prototype · WhatsApp and AI are mocked · nothing is sent or charged</span></div>
${body}
<script src="/public/icons.js"></script>
<script src="/public/app.js"></script>
</body>
</html>`

const plain = (title: string, body: Raw) => doc(title, 'plain', html`<main><div class="auth">${body}</div></main>`)

interface Shell {
  name: string
  paused: boolean
  waiting: number
  conn: Connection | null
}
async function shellData(tx: Tx): Promise<Shell> {
  const w = one(await tx.query<{ name: string; paused: boolean }>('SELECT name, replies_paused_at IS NOT NULL AS paused FROM workspaces WHERE id = app_workspace_id()'))
  const { n } = one(await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM conversations WHERE mode = 'handoff_requested'`))
  return { ...w, waiting: n, conn: await currentConnection(tx) }
}

const PAUSE_NOTE = 'Pausing stops new automated replies. A message already submitted to WhatsApp may still arrive.'
const pauseForm = (w: string, paused: boolean, square = false) =>
  paused
    ? html`<form data-api="/api/v1/workspaces/${w}/resume-replies"><button class="btn secondary${square ? ' square' : ''}" ${square ? html`aria-label="Resume replies"` : ''} title="Resume automated replies">${icon('right', square)}${square ? '' : 'Resume replies'}</button>${square ? '' : err}</form>`
    : html`<form data-api="/api/v1/workspaces/${w}/pause"><button class="btn secondary${square ? ' square' : ''}" ${square ? html`aria-label="Pause replies"` : ''} title="${PAUSE_NOTE}">${icon('pause', square)}${square ? '' : 'Pause replies'}</button>${square ? '' : err}</form>`

const NAV = [
  ['', 'home', 'Home'], ['inbox', 'inbox', 'Inbox'], ['enquiries', 'list', 'Enquiries'], null,
  ['business', 'info', 'Business info'], ['knowledge', 'book', 'Knowledge'], ['assistant', 'sliders', 'Assistant'], ['ai', 'chip', 'AI provider'],
  ['whatsapp', 'link', 'WhatsApp'], ['test', 'send', 'Test chat'], null,
  ['usage', 'chart', 'Usage and limit'], ['not-built', 'more', 'Not built yet'],
] as const

function shell(s: Shell, w: string, nav: string, title: string, view: string, body: Raw) {
  const base = `/w/${w}`
  const cur = (k: string) => (k === nav ? html`aria-current="page"` : '')
  const wsButton = html`<a class="ws" href="/workspaces" title="Switch workspace"><span class="mark" aria-hidden="true">${s.name.slice(0, 1).toUpperCase()}</span><span class="name">${s.name}</span>${icon('down')}</a>`
  const state = s.paused ? 'Replies paused' : 'Test mode'
  return doc(title, view, html`<div class="app">
  <aside class="side">
    ${wsButton}
    <nav aria-label="Workspace">
      ${NAV.map((n) => n === null ? html`<hr>` : html`<a href="${base}${n[0] && '/'}${n[0]}" ${cur(n[0])}>${icon(n[1], true)}${n[2]}${n[0] === 'inbox' && s.waiting ? html`<span class="count">${s.waiting}<span class="sr-only"> waiting for staff</span></span>` : ''}</a>`)}
    </nav>
    <div class="side-foot">
      <div>
        <span style="font: var(--text-label); font-weight: 600">${state}</span>
        <p class="meta tnum" style="margin-top: 4px">${s.conn?.state === 'connected' ? html`Mock · ${s.conn.masked_number} · ${ROUTES[s.conn.route].name}` : 'No WhatsApp route connected'}</p>
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

const STEP_LINK: Record<Check['key'], string> = { business: 'business', knowledge: 'knowledge', assistant: 'assistant', ai: 'ai', limit: 'usage', whatsapp: 'whatsapp', test: 'test', activate: '' }
const STEP_STATUS = { done: status('ok', 'check', 'Done'), mock: MOCK, blocked: status('warn', 'alert', 'Blocked'), todo: status('idle', 'idle', 'To do') }

const SEND_STATE: Record<string, string> = {
  reserved: 'Queued', submitting: 'Sending', accepted: 'Accepted by the mock, not delivered to anyone',
  uncertain: 'Delivery uncertain · not resent automatically', interrupted_during_send: 'Delivery uncertain · interrupted while sending · not resent automatically',
  no_answer_from_provider: 'Delivery uncertain · no answer from WhatsApp · not resent automatically',
  stopped_by_takeover: 'Not sent · stopped by takeover', stopped_by_pause: 'Not sent · replies were paused', connection_not_ready: 'Not sent · WhatsApp not connected', failed: 'Not sent',
}
const who = (c: ConversationRow) => c.name ?? `Customer ••• ${c.number}`
const MODE: Record<string, Raw> = {
  bot: status('idle', 'idle', 'Assistant'),
  handoff_requested: status('warn', 'alert', 'Waiting for staff'),
  human: status('ok', 'users', 'With staff'),
  resolved: status('idle', 'check', 'Resolved'),
}

export function pageRoutes(add: Add, localMailbox: boolean) {
  add('GET', '/', async (c) => {
    if (!c.user) return new Redirect('/signin')
    const first = await withUser(c.deps.db, c.user.id, (tx) =>
      tx.query<{ id: string }>(`SELECT workspace_id AS id FROM memberships WHERE user_id = app_user_id() AND status = 'active' ORDER BY created_at LIMIT 1`))
    return new Redirect(first.rows[0] ? `/w/${first.rows[0].id}` : '/workspaces')
  }, true)

  add('GET', '/signin', async () => plain('Sign in', html`
    <h1 class="page-title">Sign in</h1>
    <form class="form" data-api="/api/auth/sign-in/magic-link" data-next="${localMailbox ? '/dev/mailbox' : '/signin?sent=1'}">
      <input type="hidden" name="callbackURL" value="/">
      <div class="field"><label for="email">Email</label><input class="input" id="email" name="email" type="email" autocomplete="email" required>
        <span class="hint">We’ll email you a link that signs you in once and expires in 15 minutes. No password.</span></div>
      ${err}
      <div><button class="btn primary">Send me a sign-in link</button></div>
    </form>
    ${localMailbox ? html`<p class="note">Development mode: no email is sent. The link appears in the <a href="/dev/mailbox">local mailbox</a> on this machine.</p>` : html`<p class="note warn">No email sender is configured, so sign-in links cannot be delivered.</p>`}`), true)

  // Development only: not registered at all when the local mailbox is off.
  if (localMailbox) add('GET', '/dev/mailbox', async (c) => {
    const mail = await c.deps.db.query<{ to_email: string; body: string; created_at: Date }>('SELECT to_email, body, created_at FROM local_mail ORDER BY created_at DESC LIMIT 20')
    return plain('Local mailbox', html`
      <h1 class="page-title">Local mailbox</h1>
      <p class="note">Stands in for email during development. These messages exist only in this machine’s database.</p>
      ${mail.rows.length ? html`<ul class="src">${mail.rows.map((m) => html`<li><span>${m.to_email}<br><span class="meta tnum">${time(m.created_at)}</span></span>${m.body.startsWith(`${c.deps.baseUrl}/api/auth/magic-link/verify?`) ? html`<a class="btn secondary sm" href="${m.body}">Open sign-in link</a>` : ''}</li>`)}</ul>` : html`<div class="empty"><h3>No mail yet</h3><p>Request a sign-in link and it will appear here.</p><a class="btn secondary" href="/signin">Sign in</a></div>`}`)
  }, true)

  add('GET', '/workspaces', async (c) => {
    const list = await withUser(c.deps.db, c.user.id, (tx) =>
      tx.query<{ id: string; name: string; role: string }>(`SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = app_user_id() AND m.status = 'active' ORDER BY w.created_at`))
    return plain('Workspaces', html`
      <h1 class="page-title">Your workspaces</h1>
      ${list.rows.length ? html`<ul class="src">${list.rows.map((w) => html`<li><a href="/w/${w.id}">${w.name}</a><span class="meta">${w.role.replace('_', ' ')}</span></li>`)}</ul>` : html`<p class="page-lede">A workspace holds one business: its facts, its WhatsApp number and its conversations.</p>`}
      <form class="form" data-api="/api/v1/workspaces" data-next="/w/{id}/business">
        <div class="field"><label for="name">Business name</label><input class="input" id="name" name="name" maxlength="200" required><span class="hint">Shown to your team, not to customers.</span></div>
        ${err}
        <div><button class="btn primary">Create workspace</button></div>
      </form>
      <form data-api="/api/auth/sign-out" data-next="/signin"><button class="btn quiet">Sign out ${c.user.email}</button></form>`)
  })

  // ---------------------------------------------------------------- Home
  add('GET', '/w/:w', page('', 'Home', async (tx, c) => {
    const r = await readiness(tx)
    const s = await shellData(tx)
    const waiting = (await listConversations(tx)).filter((v) => v.mode === 'handoff_requested')
    const base = `/w/${c.param('w')}`
    return html`
      <div class="home-head"><h1 class="page-title">Home</h1></div>
      <div class="state">
        <div>
          <strong>${s.paused ? html`Replies are paused ${status('warn', 'pause', 'Paused')}` : html`Test mode ${MOCK}`}</strong>
          <p>${s.paused ? 'No new automated replies are being sent. A message already submitted to WhatsApp may still arrive.' : `Nothing reaches real customers. WhatsApp and the AI are simulated on this machine. ${PAUSE_NOTE}`}</p>
        </div>
        ${pauseForm(c.param('w'), s.paused)}
      </div>
      <div class="home-grid">
        <div class="block">
          <div class="block-head"><h2 class="h">Setup</h2></div>
          <ol class="steps">${r.checks.map((k, i) => html`<li class="${k.state === 'done' || k.state === 'blocked' ? k.state : ''}"><span class="dot" aria-hidden="true">${k.state === 'done' ? icon('check') : k.state === 'blocked' ? icon('alert') : i + 1}</span><span><b>${STEP_LINK[k.key] ? html`<a href="${base}/${STEP_LINK[k.key]}">${k.title}</a>` : k.title}</b><small>${k.detail}</small></span>${STEP_STATUS[k.state]}</li>`)}</ol>
          <div class="note" style="margin-top: var(--space-16)"><b>Before real customers can be answered</b><ul>${r.blockers.map((b) => html`<li>${b}</li>`)}</ul></div>
        </div>
        <div class="block" style="margin-top: 0">
          <div class="block-head"><h2 class="h">Waiting for your staff</h2><a href="${base}/inbox">Open inbox</a></div>
          ${waiting.length ? html`<ul class="waiting">${waiting.map((v) => html`<li><b>${who(v)}</b><span class="wait tnum">Since ${time(v.last_message_at)}</span><p>${v.handoff_reason}</p><a class="btn secondary sm" href="${base}/inbox/${v.id}">Open</a></li>`)}</ul>` : html`<div class="empty" style="margin-top: var(--space-16)"><h3>No one is waiting</h3><p>When the assistant can’t answer from your published facts, the conversation appears here.</p></div>`}
          <p class="actions-row" style="margin-top: var(--space-24); font: var(--text-label)"><a href="${base}/enquiries">Enquiries</a><a href="${base}/usage">Usage and limit</a><a href="${base}/not-built">Not built yet</a></p>
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
  add('GET', '/w/:w/ai', page('ai', 'AI provider', async (tx, _c, api) => {
    const cfg = await getConfig(tx)
    return html`
      <div class="home-head"><h1 class="page-title">AI provider</h1>${cfg ? MOCK : status('idle', 'idle', 'Not set up')}</div>
      <p class="page-lede">The assistant uses your own account with the provider, and you pay the provider directly. Your key is stored encrypted and is never shown again after saving.</p>
      <p class="note" style="margin-top: var(--space-16)">No provider is contacted in this prototype. Your settings and key are stored, but test replies come from a built-in mock, so nothing is charged.</p>
      <div class="cols-2">
        <form class="form" data-api="${api}/ai-configs">
          <h2 class="h">Provider and model</h2>
          <div class="field"><label for="provider">Provider</label><span class="select"><select id="provider" name="provider">${Object.entries(PROVIDERS).map(([k, v]) => html`<option value="${k}" ${k === (cfg?.provider ?? 'anthropic') ? html`selected` : ''}>${v}</option>`)}</select>${icon('down')}</span></div>
          <div class="field"><label for="model_id">Model ID</label><input class="input" id="model_id" name="model_id" maxlength="200" value="${cfg?.model_id ?? ''}" required autocomplete="off">
            <span class="hint">Type it exactly as your provider lists it. No models have been checked against a live provider yet, so none are suggested.</span></div>
          <div class="field"><label for="endpoint">API address</label><input class="input" id="endpoint" name="endpoint" type="url" placeholder="https://" value="${cfg?.endpoint ?? ''}">
            <span class="hint">Only for a custom compatible API. It must be a public https:// address.</span></div>
          ${cfg ? html`<p class="meta">Saving again starts a fresh configuration and removes the saved key, so a key is never sent to a different destination.</p>` : ''}
          ${err}
          <div><button class="btn ${cfg ? 'secondary' : 'primary'}">Save provider</button></div>
        </form>
        ${cfg ? html`<div class="stack" style="gap: var(--space-32)">
          <div class="stack">
            <h2 class="h">Your ${PROVIDERS[cfg.provider]} key</h2>
            ${cfg.key ? html`<div class="secret"><code>${cfg.key.masked_label}</code>${status('idle', 'idle', 'Not checked live')}
              <form data-api="${api}/ai-configs/${cfg.id}/secret" data-method="DELETE"><button class="btn secondary sm">Remove</button></form></div>
              <p class="meta">Removing the key here stops us using it. It does not cancel the key with ${PROVIDERS[cfg.provider]}; do that in your account there.</p>` : ''}
            <form class="form" data-api="${api}/ai-configs/${cfg.id}/secret">
              <div class="field"><label for="api_key">${cfg.key ? 'Replace key' : 'API key'}</label><input class="input" id="api_key" name="api_key" type="password" autocomplete="off" required maxlength="500">
                <span class="hint">Sent to ${cfg.endpoint ? new URL(cfg.endpoint).host : `${PROVIDERS[cfg.provider]} only`} once live replies exist. It can be replaced or removed, never viewed.</span></div>
              ${err}
              <div><button class="btn ${cfg.key ? 'secondary' : 'primary'}">Save key</button></div>
            </form>
          </div>
          <div class="stack">
            <h2 class="h">Check</h2>
            <form class="actions-row" data-api="${api}/ai-configs/${cfg.id}/tests"><input type="hidden" name="mode" value="mock"><button class="btn secondary">Run mock check</button>${cfg.last_test ? status('idle', 'mock', `Mock check passed ${time(cfg.last_test.at)}`) : ''}${err}</form>
            <p class="meta">The mock check looks at the saved settings only. No request is sent, so it costs nothing and says nothing about your account or key.</p>
            <div class="actions-row"><button class="btn secondary" disabled>Run live check</button>${status('idle', 'clock', 'Not built yet')}</div>
          </div>
        </div>` : ''}
      </div>`
  }))

  // ---------------------------------------------------------------- WhatsApp
  const ROUTE_COPY: Record<Route, { how: string; before: string; risk: string; disclosure: string }> = {
    official_cloud_api: {
      how: 'Through Meta’s business sign-up. Messages reach us from Meta’s servers.',
      before: 'Business and number checks with Meta. Not every number is eligible.',
      risk: 'Some replies can be blocked by Meta’s rules, and Meta’s messaging charges apply.',
      disclosure: 'Meta’s messaging rules and charges apply to this route. Meta must approve the business and the number, and some replies can be blocked outside Meta’s messaging window.',
    },
    unofficial_qr: {
      how: 'As a linked device, by scanning a QR code with your phone. This is not an official integration.',
      before: 'Your phone, and your agreement to the risks.',
      risk: 'WhatsApp can restrict or disconnect the account. The link can drop and need scanning again.',
      disclosure: 'This route is not an official WhatsApp integration. WhatsApp can restrict or disconnect the account, the link can drop and need scanning again, and we cannot fix problems on WhatsApp’s side.',
    },
  }
  add('GET', '/w/:w/whatsapp', page('whatsapp', 'WhatsApp', async (tx, _c, api) => {
    const conn = await currentConnection(tx)
    const head = html`<div class="home-head"><h1 class="page-title">WhatsApp</h1>${conn?.state === 'connected' ? status('idle', 'mock', 'Mock connection') : conn?.state === 'needs_action' ? status('warn', 'alert', 'Needs action') : status('idle', 'idle', 'Not connected')}</div>`
    const cancel = (c: Connection, label: string) => html`<form data-api="${api}/connections/${c.id}/disconnect"><button class="btn ${c.state === 'connected' ? 'danger' : 'quiet'}">${label}</button>${err}</form>`
    if (!conn) return html`${head}
      <p class="page-lede">Two ways to connect. Read the difference before you choose; you can only have one open at a time.</p>
      <p class="note" style="margin-top: var(--space-16)">Neither route can reach WhatsApp yet. A mock connection lets you try the rest of the product with simulated customers.</p>
      <div class="cols-2">${(Object.keys(ROUTES) as Route[]).map((r) => html`<article class="stack">
        <div class="fact-head"><h2 class="h">${ROUTES[r].name}</h2>${status('idle', 'clock', 'Live connection not built')}</div>
        <dl class="kv"><div><dt>How it connects</dt><dd>${ROUTE_COPY[r].how}</dd></div><div><dt>Before you start</dt><dd>${ROUTE_COPY[r].before}</dd></div><div><dt>Main risk</dt><dd>${ROUTE_COPY[r].risk}</dd></div></dl>
        <p class="meta">${ROUTES[r].liveBlocker}</p>
        <form class="actions-row" data-api="${api}/connections"><input type="hidden" name="route" value="${r}"><input type="hidden" name="mode" value="mock"><button class="btn secondary">Set up a mock connection</button>${err}</form>
      </article>`)}</div>`
    const name = ROUTES[conn.route].name
    if (conn.state === 'unconfigured') return html`${head}
      <p class="page-lede">${name} · mock setup. Nothing is linked to WhatsApp.</p>
      <form class="form" data-api="${api}/connections/${conn.id}/start" style="margin-top: var(--space-24)">
        <p class="note warn">${ROUTE_COPY[conn.route].disclosure}</p>
        <div class="field"><label for="authorized_number">Number you want to connect</label><input class="input" id="authorized_number" name="authorized_number" inputmode="tel" autocomplete="tel" placeholder="+15550100" required>
          <span class="hint">With country code. If a different number ends up linked, nothing is sent until you sort it out.</span></div>
        <label class="choice"><input type="checkbox" name="accept" required><span>${conn.route === 'unofficial_qr' ? 'I understand this is an unofficial route and I accept these risks for this number.' : 'I understand these conditions apply to this number.'}</span></label>
        ${err}
        <div class="actions-row"><button class="btn primary">Continue</button></div>
      </form>${cancel(conn, 'Choose a different route')}`
    if (conn.state === 'pending_auth') {
      const expires = conn.link_expires_at
      const live = expires !== null && expires > new Date()
      return html`${head}
      <p class="page-lede">${name} · mock setup.</p>
      <div class="stack" style="margin-top: var(--space-24); max-width: 560px">
        <div class="panel" style="padding: var(--space-24)"><b>${conn.route === 'unofficial_qr' ? 'A QR code would appear here' : 'Meta’s sign-up window would open here'}</b>
          <p class="meta" style="margin-top: 4px">This is a placeholder. There is nothing to scan and nothing is sent to WhatsApp. ${live ? `This step expires at ${expires?.toLocaleTimeString('en-GB')}.` : 'This step has expired.'}</p></div>
        ${live ? html`
        <form class="actions-row" data-api="${api}/connections/${conn.id}/mock-link"><button class="btn primary">Simulate a successful link</button>${err}</form>
        <form class="form" data-api="${api}/connections/${conn.id}/mock-link">
          <div class="field"><label for="linked_number">Simulate a different number being linked</label><input class="input" id="linked_number" name="linked_number" inputmode="tel" placeholder="+15550199" required></div>
          ${err}<div><button class="btn secondary">Simulate wrong number</button></div>
        </form>` : html`<form class="actions-row" data-api="${api}/connections/${conn.id}/start"><button class="btn primary">Start again</button>${err}</form>`}
        ${cancel(conn, 'Cancel setup')}
      </div>`
    }
    if (conn.state === 'needs_action') return html`${head}
      <p class="note warn" style="margin-top: var(--space-16)">${icon('alert')} The number that was linked is not the one you authorised. Nothing will be sent through it.</p>
      <div style="margin-top: var(--space-16)">${cancel(conn, 'Remove and start again')}</div>`
    return html`${head}
      <p class="page-lede">${name} · mock connection. Simulated customers can message this workspace from the inbox; nothing reaches WhatsApp.</p>
      <dl class="kv" style="max-width: 560px; margin-top: var(--space-24)">
        <div><dt>Number</dt><dd class="tnum">${conn.masked_number}</dd></div>
        <div><dt>Route</dt><dd>${name}</dd></div>
        <div><dt>Checked</dt><dd class="tnum">${conn.last_health_at ? time(conn.last_health_at) : 'Never'} (mock)</dd></div>
      </dl>
      <div class="stack" style="margin-top: var(--space-24); max-width: 560px"><p class="meta">Disconnecting stops replies first, then removes the link. A message already submitted may still arrive.</p>${cancel(conn, 'Disconnect')}</div>`
  }))

  // ---------------------------------------------------------------- Test chat
  add('GET', '/w/:w/test', page('test', 'Test chat', async (tx, c, api) => {
    const k = await published(tx)
    const runs = (await tx.query<{ results: { question: string; reply: string; outcome: string; fact_path?: string; reason?: string; knowledge_sequence: number } }>(
      `SELECT results FROM (SELECT results, created_at FROM test_runs WHERE type = 'sample_chat' ORDER BY created_at DESC LIMIT 20) t ORDER BY created_at`)).rows
    if (!k) return html`<div class="home-head"><h1 class="page-title">Test chat</h1>${MOCK}</div>
      <div class="empty" style="margin-top: var(--space-24)"><h3>Publish your knowledge first</h3><p>The assistant only answers from published facts, so there is nothing to test yet.</p><a class="btn secondary" href="/w/${c.param('w')}/knowledge">Review knowledge</a></div>`
    return html`<div class="home-head"><h1 class="page-title">Test chat</h1>${MOCK}</div>
      <p class="page-lede">Ask what your customers ask. Replies come from published version ${k.sequence} through a built-in mock that looks up your facts. Your AI provider is not used, so wording will differ from live replies.</p>
      <div class="panel" style="margin-top: var(--space-24); max-width: 720px; overflow: hidden">
        <div class="msgs" style="min-height: 160px">${runs.length ? runs.map((r) => html`<div class="bubble">${r.results.question}</div>
          <div class="bubble out">${r.results.reply}<span class="meta">${r.results.outcome === 'answered' ? `Mock · answered from “${r.results.fact_path}”` : `Mock · would go to staff: ${r.results.reason}`} · version ${r.results.knowledge_sequence}</span></div>`) : html`<span class="day">No questions asked yet</span>`}</div>
        <form class="composer" data-api="${api}/sample-chats">
          <label class="sr-only" for="message">Ask as a customer</label>
          <textarea class="input" id="message" name="message" rows="2" maxlength="2000" required placeholder="Are you open on Sunday?"></textarea>
          <button class="btn primary">${icon('send')}Ask</button>
          ${err}
        </form>
      </div>`
  }))

  // ---------------------------------------------------------------- Inbox
  const inbox = (thread: boolean): Handler => page('inbox', 'Inbox', async (tx, c, api) => {
    const base = `/w/${c.param('w')}/inbox`
    const convs = await listConversations(tx)
    const conn = await currentConnection(tx)
    const open = thread ? await listMessages(tx, c.param('c')) : null
    const simulate = (label: string, from?: string) => conn?.state === 'connected'
      ? html`<details class="sim"><summary>${label}</summary>
        <form class="form" data-api="${api}/connections/${conn.id}/mock-inbound" data-next="${base}/{id}">
          ${from ? html`<input type="hidden" name="from" value="${from}">` : html`<div class="field"><label for="from">Customer number</label><input class="input" id="from" name="from" inputmode="tel" value="+15550142" required></div>`}
          <div class="field"><label for="sim-${from ? 'next' : 'new'}">Customer message</label><input class="input" id="sim-${from ? 'next' : 'new'}" name="text" maxlength="2000" required></div>
          ${err}<div><button class="btn secondary sm">Send as customer</button></div>
        </form></details>`
      : html`<p class="sim meta">Set up a <a href="/w/${c.param('w')}/whatsapp">mock WhatsApp connection</a> to simulate customers.</p>`
    const v = open?.conversation
    return html`<section class="view two" id="v-inbox" aria-label="Inbox">
      <div class="pane convs">
        <div class="pane-head"><h1 class="page-title">Inbox</h1></div>
        ${convs.length ? html`<ul class="pane-scroll">${convs.map((k) => html`<li><a href="${base}/${k.id}" ${k.id === v?.id ? html`aria-current="true"` : ''}><b>${who(k)}</b><span class="meta tnum">${time(k.last_message_at)}</span><p>${k.preview}</p>${MODE[k.mode]}</a></li>`)}</ul>`
          : html`<div class="pane-scroll" style="padding: var(--space-16)"><div class="empty"><h3>No conversations yet</h3><p>Customer chats appear here. In this prototype you can simulate one below.</p></div></div>`}
        ${simulate('Simulate a new customer message (mock)')}
      </div>
      <div class="pane thread">${v && open ? html`
        <div class="pane-head">
          <a class="btn quiet square back" href="${base}" aria-label="Back to conversations">${icon('back', true)}</a>
          <span class="who"><b>${who(v)}</b><span class="meta tnum">••• ${v.number} · mock connection</span></span>
        </div>
        <div class="mode">
          <span>${icon(v.mode === 'human' ? 'users' : v.mode === 'handoff_requested' ? 'alert' : 'idle')}${v.mode === 'human' ? (v.assigned_to_me ? 'You’re replying. The assistant is off for this chat.' : 'A teammate is replying. The assistant is off for this chat.') : v.mode === 'handoff_requested' ? `Waiting for staff: ${v.handoff_reason ?? 'the assistant could not answer'}.` : 'The assistant is answering this chat. Taking over stops new automated replies; one already submitted may still arrive.'}</span>
          ${v.mode === 'human' ? html`<form data-api="${api}/conversations/${v.id}/resume"><button class="btn secondary sm">Hand back to assistant</button>${err}</form>` : html`<form data-api="${api}/conversations/${v.id}/takeover"><button class="btn secondary sm">Take over</button>${err}</form>`}
        </div>
        <div class="pane-scroll msgs">${open.messages.map((m) => m.direction === 'inbound'
          ? html`<div class="bubble">${m.body}<span class="meta tnum">${time(m.created_at)}</span></div>`
          : html`<div class="bubble out${m.state === 'uncertain' ? ' uncertain' : ''}">${m.body}<span class="meta tnum">${m.sender === 'bot' ? 'Assistant (mock)' : 'Staff'} · ${time(m.created_at)} · ${SEND_STATE[m.error_code ?? m.state] ?? m.state}</span></div>`)}</div>
        ${v.mode === 'human' ? html`<form class="composer" data-api="${api}/conversations/${v.id}/reply">
          <input type="hidden" name="idempotency_key" value="${randomUUID()}">
          <label class="sr-only" for="reply">Reply as staff</label>
          <textarea class="input" id="reply" name="text" rows="2" maxlength="2000" required></textarea>
          <button class="btn primary">${icon('send')}Send</button>
          <span class="meta">Mock send from ${conn?.masked_number ?? 'a disconnected number'}. Nothing leaves this machine.</span>${err}
        </form>` : html`<p class="composer meta">Take over to reply yourself.</p>`}
        ${simulate('Simulate this customer’s next message (mock)', v.full_number)}`
        : html`<div class="pane-scroll" style="padding: var(--space-24)"><p class="page-lede">Choose a conversation.</p></div>`}
      </div>
    </section>`
  }, thread ? 'thread' : 'inbox')
  add('GET', '/w/:w/inbox', inbox(false))
  add('GET', '/w/:w/inbox/:c', inbox(true))

  // ---------------------------------------------------------------- Assistant settings
  add('GET', '/w/:w/assistant', page('assistant', 'Assistant', async (tx, _c, api) => {
    const b = await getBehavior(tx)
    const v = b.draft ?? b.published
    return html`
      <div class="home-head"><h1 class="page-title">Assistant</h1>${b.published.sequence ? status('ok', 'check', `Version ${b.published.sequence} published`) : status('idle', 'idle', 'Using defaults')}</div>
      <p class="page-lede">How the assistant behaves when it can’t answer. Changes are saved as a draft; customers get the published version until you publish again.</p>
      <div class="cols-2">
        <form class="form" data-api="${api}/behavior/draft" data-method="PATCH">
          <div class="field"><label for="handoff_message">What to say when handing over to staff</label><textarea class="input" id="handoff_message" name="handoff_message" rows="3" maxlength="300" required>${v.handoff_message}</textarea>
            <span class="hint">Sent when a question isn’t covered by your published facts or the customer asks for a person. Don’t promise that staff were told: staff notifications aren’t built yet.</span></div>
          <fieldset class="field" style="border: 0; padding: 0"><legend class="label" style="font: var(--text-label); font-weight: 600">Details to note down for an enquiry</legend>
            ${(Object.keys(ENQUIRY_FIELDS) as EnquiryField[]).map((f) => html`<label class="choice"><input type="checkbox" name="field_${f}" ${v.enquiry_fields.includes(f) ? html`checked` : ''}><span>${ENQUIRY_FIELDS[f]}<small>Only if the customer offers it. The assistant never asks for more than this.</small></span></label>`)}
            <span class="hint">What the customer asked for is always noted.</span></fieldset>
          <div class="field"><label for="instructions">Instructions for the assistant</label><textarea class="input" id="instructions" name="instructions" rows="4" maxlength="2000">${v.instructions}</textarea>
            <span class="hint">Stored and versioned, but the built-in mock ignores free-text instructions. They will apply once a real AI provider is connected.</span></div>
          ${err}
          <div><button class="btn secondary">Save draft</button></div>
        </form>
        <div class="stack">
          <h2 class="h">Publish</h2>
          <p class="page-lede" style="margin: 0">${b.draft ? 'You have saved changes that customers are not getting yet.' : 'No unpublished changes.'}</p>
          <form class="actions-row" data-api="${api}/behavior/publish"><button class="btn primary" ${b.draft ? '' : html`disabled`}>Publish version ${b.draft?.sequence ?? b.published.sequence + 1}</button>${err}</form>
          <p class="meta">These limits always apply and cannot be changed here: the assistant never quotes a fact that isn’t published, never takes payments or confirms bookings, and stops when you pause or take over.</p>
        </div>
      </div>`
  }))

  // ---------------------------------------------------------------- Enquiries
  add('GET', '/w/:w/enquiries', page('enquiries', 'Enquiries', async (tx, c, api) => {
    const list = await listEnquiries(tx)
    const LABEL: Record<string, Raw> = { new: status('idle', 'idle', 'New'), open: status('warn', 'clock', 'Open'), closed: status('ok', 'check', 'Closed') }
    return html`
      <div class="home-head"><h1 class="page-title">Enquiries</h1>${MOCK}</div>
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
      <p class="meta" style="margin-top: var(--space-16)">Details are picked out by fixed patterns in this prototype, not by an AI. CSV export and assigning to a teammate are not built yet.</p>`
  }))

  // ---------------------------------------------------------------- Usage and spending limit
  add('GET', '/w/:w/usage', page('usage', 'Usage and limit', async (tx, _c, api) => {
    const u = await usageSummary(tx)
    const money = (minor: number) => `$${(minor / 100).toFixed(2)}`
    const l = u.limit
    const used = l ? l.settled_minor + l.reserved_minor : 0
    const pct = l?.hard_limit_minor ? Math.min(100, Math.round((used / l.hard_limit_minor) * 100)) : 0
    return html`
      <div class="home-head"><h1 class="page-title">Usage and limit</h1>${MOCK}</div>
      <p class="page-lede">The spending limit is a hard stop: when it is reached the assistant generates nothing more and hands conversations to staff. It never switches to another provider or account.</p>
      <p class="note" style="margin-top: var(--space-16)">Every figure here is a mock estimate of 1 cent per generated reply, so you can see the limit work. No provider is contacted and nothing is charged. Real costs will be measured from your provider once a live adapter exists.</p>
      <div class="cols-2">
        <div class="stack">
          <h2 class="h">Spending limit</h2>
          ${l ? html`<div class="cap tnum">
            <div class="row"><span><b>${money(used)}</b> of ${money(l.hard_limit_minor)}</span><span class="meta">Mock estimates</span></div>
            <div class="cap-bar" role="img" aria-label="${pct} percent of the limit used"><i style="width: ${pct}%"></i></div>
            <p class="meta">${money(l.settled_minor)} recorded · ${money(l.reserved_minor)} reserved for replies in progress.${used >= l.hard_limit_minor ? ' The limit is reached: replies are stopped and conversations go to staff.' : ''}</p>
          </div>` : html`<p class="note warn">No limit is set. Nothing is generated, in test chat or for customers, until you set one.</p>`}
          <form class="form" data-api="${api}/limits" data-method="PATCH">
            <div class="field"><label for="amount">${l ? 'Change limit' : 'Set limit'} (US dollars)</label><input class="input" id="amount" name="amount" inputmode="decimal" required value="${l ? (l.hard_limit_minor / 100).toFixed(2) : ''}" placeholder="20.00">
              <span class="hint">A total, not monthly: resetting each month isn’t built yet. Only the owner can set or raise it; it can’t be set below what is already used.</span></div>
            ${err}
            <div><button class="btn ${l ? 'secondary' : 'primary'}">Save limit</button></div>
          </form>
        </div>
        <div class="stack">
          <h2 class="h">What used it</h2>
          ${u.by_category.length ? html`<dl class="figures">${u.by_category.map((r) => html`<div><dt>${r.category === 'reply_generation' ? 'Replies to simulated customers' : 'Test chat questions'} · ${r.n}</dt><dd>${money(r.cost)}</dd></div>`)}</dl>` : html`<p class="page-lede" style="margin: 0">Nothing generated yet.</p>`}
        </div>
      </div>`
  }))

  // ---------------------------------------------------------------- Explicitly unfinished
  add('GET', '/w/:w/not-built', page('not-built', 'Not built yet', async () => html`
    <h1 class="page-title">Not built yet</h1>
    <p class="page-lede">These are part of the product and are not in this prototype. They are listed so nothing looks finished that isn’t.</p>
    <ul class="src" style="max-width: 720px; margin-top: var(--space-24)">
      ${[
        ['Team and roles', 'Inviting teammates, changing roles, delegated permissions and removing access from a screen. Roles and immediate revocation work underneath but can only be set directly in the database.'],
        ['Staff notifications', 'Telling your staff when a customer is waiting. Today a handoff only appears in the inbox and on Home, and the assistant does not claim anyone was told.'],
        ['Operator screens', 'Platform support tools: fleet health, failed jobs, scoped and time-limited support access.'],
        ['Real WhatsApp and real AI', 'Both WhatsApp routes and all AI providers are mocks. Activation for real customers is refused.'],
        ['Reading web pages', 'Addresses are saved but not fetched. Paste the text instead.'],
        ['Privacy tools', 'Export, closing a workspace, retention settings and audit summaries.'],
      ].map(([t, d]) => html`<li><span><b>${t}</b><br><span class="meta">${d}</span></span>${status('idle', 'clock', 'Not built')}</li>`)}
    </ul>`))
}
