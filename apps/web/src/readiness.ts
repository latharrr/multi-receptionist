// One honest answer to "what is done, what is only mocked, what blocks going live".
import { one, type Tx } from '@lathar/database'
import { getBehavior } from './assistant.ts'
import { getLimit } from './usage.ts'
import { getConfig, PROVIDERS } from './ai.ts'
import { getDraft } from './knowledge.ts'
import { currentConnection, ROUTES } from './whatsapp.ts'

export interface Check {
  key: 'business' | 'knowledge' | 'assistant' | 'ai' | 'limit' | 'whatsapp' | 'test' | 'activate'
  title: string
  state: 'done' | 'mock' | 'blocked' | 'todo'
  detail: string
}

export async function readiness(tx: Tx) {
  const sources = one(await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM sources WHERE status = 'imported'`)).n
  const draft = await getDraft(tx)
  const ai = await getConfig(tx)
  const conn = await currentConnection(tx)
  const chats = one(await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM test_runs WHERE type = 'sample_chat'
       AND knowledge_version_id = (SELECT id FROM knowledge_versions WHERE status = 'published')`)).n
  const behavior = await getBehavior(tx)
  const limit = await getLimit(tx)
  const unpublished = draft.facts.some((f) => f.diff === 'new' || f.diff === 'changed') || draft.removed.length > 0

  // Mock results never appear here as satisfied (spec §6, §11).
  const blockers = [
    !draft.published && 'No knowledge is published.',
    ai ? `${PROVIDERS[ai.provider]} has not passed a live check; the live adapter is not built.` : 'No AI provider is set up.',
    conn ? ROUTES[conn.route].liveBlocker : 'No WhatsApp route is connected.',
    !limit && 'No spending limit is set.',
    'Real costs are not measured yet; the limit is only exercised with mock estimates.',
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
      key: 'ai', title: 'AI provider', state: ai ? 'mock' : 'todo',
      detail: ai ? `${PROVIDERS[ai.provider]} · ${ai.key ? 'key saved' : 'no key saved'} · ${ai.last_test ? 'mock check passed' : 'not checked'} · live check not built` : 'Choose a provider and save your API key',
    },
    {
      key: 'limit', title: 'Spending limit', state: limit ? 'mock' : 'todo',
      detail: limit ? `$${(limit.hard_limit_minor / 100).toFixed(2)} limit set · usage is mock estimates only` : 'Nothing is generated until a limit is set',
    },
    {
      key: 'whatsapp', title: 'WhatsApp connection',
      state: !conn ? 'todo' : conn.state === 'connected' ? 'mock' : conn.state === 'needs_action' ? 'blocked' : 'todo',
      detail: !conn ? 'Choose a route' : conn.state === 'connected' ? `${ROUTES[conn.route].name} · mock connection on ${conn.masked_number}`
        : conn.state === 'needs_action' ? 'The linked number is not the one you authorised' : `${ROUTES[conn.route].name} · setup started`,
    },
    { key: 'test', title: 'Test chat', state: chats ? 'mock' : 'todo', detail: chats ? `${chats} mock question${chats === 1 ? '' : 's'} asked against the published version` : 'Ask it what your customers ask' },
    { key: 'activate', title: 'Switch on for real customers', state: 'blocked', detail: 'Not available in this prototype' },
  ]
  return { can_activate: false, blockers, checks, test_mode_ready: Boolean(draft.published && limit && conn?.state === 'connected') }
}
