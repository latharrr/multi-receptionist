// One honest answer to "what is done, what is only a development mock, and what still blocks
// real customers". A mock result never counts as live readiness (spec §6, §11).
import { one, type Tx } from '@lathar/database'
import { getConfig, PROVIDERS } from './ai.ts'
import { getBehavior } from './assistant.ts'
import { getSettings } from './inbox.ts'
import { getDraft } from './knowledge.ts'
import { getLimit } from './usage.ts'
import { currentConnection, ROUTES } from './whatsapp.ts'

export interface Check {
  key: 'business' | 'knowledge' | 'assistant' | 'ai' | 'limit' | 'whatsapp' | 'test' | 'privacy' | 'activate'
  title: string
  state: 'done' | 'mock' | 'blocked' | 'todo'
  detail: string
}
export interface Platform {
  aiLive: boolean
  supportEmail: string | null
}

export async function readiness(tx: Tx, platform: Platform) {
  const sources = one(await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM sources WHERE status = 'imported'`)).n
  const draft = await getDraft(tx)
  const ai = await getConfig(tx)
  const conn = await currentConnection(tx)
  const chats = one(await tx.query<{ n: number; live: number }>(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE mode = 'live')::int AS live FROM test_runs WHERE type = 'sample_chat'
       AND knowledge_version_id = (SELECT id FROM knowledge_versions WHERE status = 'published')`))
  const behavior = await getBehavior(tx)
  const limit = await getLimit(tx)
  const settings = await getSettings(tx)
  const unpublished = draft.facts.some((f) => f.diff === 'new' || f.diff === 'changed') || draft.removed.length > 0
  const liveConn = conn?.mode === 'live' && conn.state === 'connected'
  const money = (micros: number) => `$${(micros / 1e6).toFixed(2)}`

  // Each line is something that must be true before real customers are answered.
  const blockers = [
    !draft.published && 'No knowledge is published.',
    !platform.aiLive ? 'This installation is running the development mock instead of a real AI provider.'
      : !ai ? 'No AI provider is set up.' : ai.state !== 'valid' ? `${PROVIDERS[ai.provider]} has not passed a live check of your key and model.` : false,
    !conn ? 'No WhatsApp route is connected.' : conn.mode === 'mock' ? 'The WhatsApp connection is a development mock.' : !liveConn && 'The WhatsApp connection is not verified and connected.',
    !limit ? 'No monthly spending limit is set.' : liveConn && limit.message_cap === null && 'No monthly WhatsApp message cap is set.',
    settings.retention_days === null && 'No retention period is set for customer conversations.',
    !platform.supportEmail && 'This installation has no support contact configured.',
    platform.aiLive && !chats.live && 'No test question has been asked through the real AI provider with the published facts.',
    !settings.live_allowed && 'The platform operator has not enabled real customers for this workspace.',
  ].filter((b): b is string => Boolean(b))

  const checks: Check[] = [
    { key: 'business', title: 'Business information', state: sources ? 'done' : 'todo', detail: sources ? `${sources} source${sources === 1 ? '' : 's'} imported` : 'Paste text, add FAQs or upload a file' },
    {
      key: 'knowledge', title: 'Review and publish knowledge',
      state: draft.conflicts ? 'blocked' : draft.published ? 'done' : 'todo',
      detail: draft.conflicts ? `${draft.conflicts} facts disagree and need a decision`
        : draft.published ? `Version ${draft.published.sequence} published${unpublished ? ' · the draft has unpublished changes' : ''}`
        : draft.facts.length ? `${draft.facts.length} draft facts to review` : 'Nothing to review yet',
    },
    {
      key: 'assistant', title: 'Assistant settings', state: behavior.published.sequence ? 'done' : 'todo',
      detail: behavior.published.sequence ? `Version ${behavior.published.sequence} published${behavior.draft ? ' · unpublished changes saved' : ''}` : 'Using the built-in defaults until you publish your own',
    },
    {
      key: 'ai', title: 'AI provider',
      state: !ai ? 'todo' : !platform.aiLive ? 'mock' : ai.state === 'valid' ? 'done' : ai.state === 'invalid' ? 'blocked' : 'todo',
      detail: !ai ? 'Choose a model and save your API key'
        : !platform.aiLive ? `${PROVIDERS[ai.provider]} · ${ai.key ? 'key saved' : 'no key saved'} · replies come from the development mock`
        : ai.state === 'valid' ? `${PROVIDERS[ai.provider]} · ${ai.model_id} · key checked live`
        : ai.state === 'invalid' ? `${PROVIDERS[ai.provider]} · live check failed: ${ai.last_error ?? 'unknown reason'}`
        : `${PROVIDERS[ai.provider]} · ${ai.key ? 'key saved, not checked yet' : 'no key saved'}`,
    },
    {
      key: 'limit', title: 'Spending limit', state: !limit ? 'todo' : platform.aiLive ? 'done' : 'mock',
      detail: !limit ? 'Nothing is generated until a limit is set'
        : `${money(limit.hard_limit_micros)} a month${limit.message_cap === null ? '' : ` · ${limit.message_cap} WhatsApp messages a month`}${platform.aiLive ? '' : ' · usage is synthetic in development'}`,
    },
    {
      key: 'whatsapp', title: 'WhatsApp connection',
      state: !conn ? 'todo' : conn.state === 'needs_action' ? 'blocked' : conn.state !== 'connected' ? 'todo' : conn.mode === 'mock' ? 'mock' : 'done',
      detail: !conn ? 'Choose a route' : conn.state === 'connected' ? `${ROUTES[conn.route].name} · ${conn.mode === 'mock' ? 'mock connection' : 'connected'} on ${conn.masked_number}`
        : conn.state === 'needs_action' ? (conn.last_health === 'number_mismatch' ? 'The linked number is not the one you authorised' : 'The connection needs your attention') : `${ROUTES[conn.route].name} · setup started`,
    },
    {
      key: 'test', title: 'Test chat', state: !chats.n ? 'todo' : chats.live ? 'done' : 'mock',
      detail: chats.n ? `${chats.n} question${chats.n === 1 ? '' : 's'} asked against the published version${chats.live ? '' : ' (development mock)'}` : 'Ask it what your customers ask',
    },
    {
      key: 'privacy', title: 'Retention and support', state: settings.retention_days !== null && platform.supportEmail ? 'done' : 'todo',
      detail: settings.retention_days === null ? 'Choose how long customer conversations are kept' : `Conversations are deleted after ${settings.retention_days} days`,
    },
    {
      key: 'activate', title: 'Switch on for real customers',
      state: settings.state === 'active' ? 'done' : blockers.length ? 'blocked' : 'todo',
      detail: settings.state === 'active' ? 'On. Every reply is drafted for staff approval.' : blockers.length ? `${blockers.length} thing${blockers.length === 1 ? '' : 's'} to finish first` : 'Ready. Replies will be drafted for staff approval.',
    },
  ]
  return {
    can_activate: blockers.length === 0, active: settings.state === 'active', blockers, checks,
    test_mode_ready: Boolean(draft.published && limit && conn?.state === 'connected'), workspace_id: settings.id,
  }
}

/** Switching on re-checks every gate at that moment; no request field can stand in for one. */
export async function activate(tx: Tx, platform: Platform) {
  const r = await readiness(tx, platform)
  return r.can_activate
    ? one(await tx.query<{ state: string }>(`UPDATE workspaces SET state = 'active', reply_mode = 'supervised', lock_version = lock_version + 1 WHERE id = app_workspace_id() RETURNING state`))
    : r
}
