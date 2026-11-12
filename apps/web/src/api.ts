// Control API, spec §8. Every workspace route goes through withWorkspace: membership, capability
// and the tenant context are checked before any handler code runs.
import { setTimeout as sleep } from 'node:timers/promises'
import type { Capability } from '@lathar/contracts'
import { createWorkspace, withUser, withWorkspace, type Tx, type WorkspaceContext } from '@lathar/database'
import { deleteSecret, getConfig, sampleChat, saveConfig, saveSecret, testConfig } from './ai.ts'
import type { Add, Ctx, Handler } from './app.ts'
import { getBehavior, listEnquiries, publishBehavior, saveBehaviorDraft, setEnquiryStatus } from './assistant.ts'
import { AppError, invalid, normalizeNumber, str } from './http.ts'
import { listConversations, listMessages, resume, setPaused, staffReply, takeover } from './inbox.ts'
import { addSource, answerQuestion, getDraft, listSources, nextQuestion, patchDraft, publish, published } from './knowledge.ts'
import { readiness } from './readiness.ts'
import { setLimit, usageSummary } from './usage.ts'
import { createConnection, currentConnection, disconnect, linkArtifact, mockLink, startConnection } from './whatsapp.ts'
import { drain, receiveInbound } from './worker.ts'

const inWs = <T>(c: Ctx, capability: Capability | undefined, fn: (tx: Tx, w: WorkspaceContext) => Promise<T>) =>
  withWorkspace(c.deps.db, { userId: c.user.id, workspaceId: c.param('w'), capability }, fn)
export const ws =
  <T>(capability: Capability | undefined, fn: (tx: Tx, c: Ctx, w: WorkspaceContext) => Promise<T>): Handler =>
  (c) =>
    inWs(c, capability, (tx, w) => fn(tx, c, w))

/** Runs queued work now and waits until the named jobs have finished (or gives up after 5 seconds). */
async function settleJobs(c: Ctx, keys: string[]) {
  for (let i = 0; i < 100; i++) {
    await drain(c.deps)
    const jobs = await inWs(c, undefined, async (tx) => (await tx.query<{ kind: string; state: string; result: Record<string, unknown> | null }>('SELECT kind, state, result FROM jobs WHERE dedupe_key = ANY($1)', [keys])).rows)
    if (jobs.every((j) => j.state !== 'queued' && j.state !== 'leased')) return Object.fromEntries(jobs.map((j) => [j.kind, j.result ?? { state: j.state }]))
    await sleep(50)
  }
  return {}
}

export function apiRoutes(add: Add) {
  const W = '/api/v1/workspaces/:w'

  add('POST', '/api/v1/workspaces', async (c) => ({ id: await createWorkspace(c.deps.db, c.user.id, str(c.body, 'name', 200)) }))
  add('GET', '/api/v1/workspaces', (c) =>
    withUser(c.deps.db, c.user.id, async (tx) =>
      (await tx.query(`SELECT w.id, w.name, w.state, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
                       WHERE m.user_id = app_user_id() AND m.status = 'active' ORDER BY w.created_at`)).rows))

  // --- business inputs
  add('POST', `${W}/sources`, ws('knowledge.edit', async (tx, c) => {
    const type = c.body.type
    if (type === 'url') return addSource(tx, c.deps.storageDir, { type, url: str(c.body, 'url', 2000) })
    if (type !== 'text' && type !== 'faq') throw invalid('type', 'Unknown source type.')
    return addSource(tx, c.deps.storageDir, { type, bytes: Buffer.from(str(c.body, 'text', 2 * 1024 * 1024)) })
  }))
  add('POST', `${W}/uploads`, ws('knowledge.edit', async (tx, c) => {
    let filename = ''
    try { filename = decodeURIComponent(String(c.headers['x-filename'] ?? '')).split(/[\\/]/).pop()?.slice(0, 200) ?? '' } catch { /* rejected below */ }
    // Text only: no executables, archives, documents with macros, or HTML.
    if (!/^[^\0]+\.(md|txt)$/i.test(filename)) throw invalid('file', 'Only .md and .txt files are accepted.')
    return addSource(tx, c.deps.storageDir, { type: 'file', bytes: c.raw, filename })
  }))
  add('GET', `${W}/sources`, ws(undefined, (tx) => listSources(tx)))

  // --- knowledge
  add('GET', `${W}/knowledge/draft`, ws(undefined, (tx) => getDraft(tx)))
  add('PATCH', `${W}/knowledge/draft`, ws('knowledge.edit', async (tx, c) => {
    await patchDraft(tx, c.body)
    return getDraft(tx)
  }))
  add('GET', `${W}/questions/next`, ws('knowledge.edit', (tx) => nextQuestion(tx)))
  add('POST', `${W}/questions/:id/answer`, ws('knowledge.edit', (tx, c) =>
    answerQuestion(tx, c.param('id'), c.body.skip ? null : str(c.body, 'answer', 600))))
  add('POST', `${W}/knowledge/publish`, ws('knowledge.publish', (tx, c, w) => publish(tx, c.user.id, w.workspaceState)))

  // --- assistant settings
  add('GET', `${W}/behavior/draft`, ws(undefined, (tx) => getBehavior(tx)))
  add('PATCH', `${W}/behavior/draft`, ws('knowledge.edit', (tx, c) => saveBehaviorDraft(tx, c.body)))
  add('POST', `${W}/behavior/publish`, ws('knowledge.publish', (tx, c) => publishBehavior(tx, c.user.id)))

  // --- AI provider (customer-owned key)
  add('GET', `${W}/ai-configs`, ws(undefined, async (tx) => [await getConfig(tx)].filter(Boolean)))
  add('POST', `${W}/ai-configs`, ws('secret.manage', (tx, c) => saveConfig(tx, c.body)))
  add('POST', `${W}/ai-configs/:id/secret`, ws('secret.manage', (tx, c) => saveSecret(tx, c.deps.masterKey, c.param('id'), c.body)))
  add('DELETE', `${W}/ai-configs/:id/secret`, ws('secret.manage', (tx, c) => deleteSecret(tx, c.param('id'))))
  add('POST', `${W}/ai-configs/:id/tests`, ws('secret.manage', (tx, c) => testConfig(tx, c.param('id'), c.body.mode)))

  // --- usage and spending limit
  add('GET', `${W}/usage`, ws(undefined, (tx) => usageSummary(tx)))
  add('PATCH', `${W}/limits`, ws('limits.lower', (tx, c, w) => setLimit(tx, w, c.user.id, c.body)))

  // --- WhatsApp routes
  add('GET', `${W}/connections`, ws(undefined, async (tx) => [await currentConnection(tx)].filter(Boolean)))
  add('POST', `${W}/connections`, ws('connection.manage', (tx, c) => createConnection(tx, c.body)))
  add('POST', `${W}/connections/:id/start`, ws('connection.manage', (tx, c) => startConnection(tx, c.user.id, c.param('id'), c.body)))
  add('GET', `${W}/connections/:id/link-artifact`, ws('connection.manage', (tx, c) => linkArtifact(tx, c.param('id'))))
  add('POST', `${W}/connections/:id/mock-link`, ws('connection.manage', (tx, c) => mockLink(tx, c.param('id'), c.body)))
  add('POST', `${W}/connections/:id/disconnect`, ws('connection.manage', (tx, c) => disconnect(tx, c.param('id'))))

  // MOCK ONLY: a signed-in member plays the provider for a mock connection. The event then takes
  // the same path a real callback would: callback role, tenant resolved from the number mapping.
  add('POST', `${W}/connections/:id/mock-inbound`, async (c) => {
    const text = str(c.body, 'text', 2000)
    const from = normalizeNumber(str(c.body, 'from', 20), 'from')
    const conn = await inWs(c, 'conversation.reply', async (tx) =>
      (await tx.query<{ route: string; verified_number_id: string }>(`SELECT route, verified_number_id FROM connections WHERE id = $1 AND mode = 'mock' AND state = 'connected'`, [c.param('id')])).rows[0])
    if (!conn) throw new AppError(409, 'CONNECTION_NOT_READY', 'Connect a mock WhatsApp route first.')
    const received = await receiveInbound(c.deps.callback, {
      route: conn.route, numberId: conn.verified_number_id, from, text,
      name: typeof c.body.name === 'string' && c.body.name.trim() ? c.body.name.trim().slice(0, 80) : null,
      eventKey: typeof c.body.event_key === 'string' && c.body.event_key ? c.body.event_key.slice(0, 100) : crypto.randomUUID(),
    })
    if (received.status !== 'queued') return { duplicate: received.status === 'duplicate', replied: false, reason: received.status }
    const jobs = await settleJobs(c, [`event:${received.eventId}`, `reply:${received.eventId}`])
    return { duplicate: false, replied: false, ...jobs.generate_reply, conversation_id: jobs.process_inbound?.conversation_id, send: jobs.submit_message?.state }
  })

  // --- testing and readiness
  add('POST', `${W}/sample-chats`, ws(undefined, async (tx, c) => {
    if (c.body.mode === 'live') throw new AppError(409, 'LIVE_TEST_NOT_AVAILABLE', 'Live test chats are not built yet. Nothing was sent and nothing was charged.')
    const k = await published(tx)
    if (!k) throw new AppError(409, 'NO_PUBLISHED_KNOWLEDGE', 'Publish your knowledge first. The assistant only answers from published facts.')
    return sampleChat(tx, c.deps.ai, k, str(c.body, 'message', 2000))
  }))
  add('GET', `${W}/readiness`, ws(undefined, (tx) => readiness(tx)))
  add('POST', `${W}/activate`, ws('workspace.activate', async (tx) => {
    const r = await readiness(tx)
    // No request field can stand in for a live check; in this build the gates can never all pass.
    throw new AppError(409, 'ACTIVATION_BLOCKED', `Replies to real customers cannot be switched on yet: ${r.blockers.join(' ')}`)
  }))
  add('POST', `${W}/pause`, ws('conversation.reply', (tx) => setPaused(tx, true)))
  add('POST', `${W}/resume-replies`, ws('workspace.activate', (tx) => setPaused(tx, false)))

  // --- inbox and enquiries
  add('GET', `${W}/conversations`, ws(undefined, (tx) => listConversations(tx)))
  add('GET', `${W}/conversations/:id/messages`, ws(undefined, (tx, c) => listMessages(tx, c.param('id'))))
  add('POST', `${W}/conversations/:id/takeover`, ws('conversation.reply', (tx, c) => takeover(tx, c.user.id, c.param('id'))))
  add('POST', `${W}/conversations/:id/reply`, async (c) => {
    const r = await inWs(c, 'conversation.reply', (tx) => staffReply(tx, c.param('id'), c.body))
    const jobs = await settleJobs(c, [r.send_key])
    return { message_id: r.message_id, duplicate: r.duplicate, send: jobs.submit_message?.state }
  })
  add('POST', `${W}/conversations/:id/resume`, ws('conversation.reply', (tx, c) => resume(tx, c.user.id, c.param('id'))))
  add('GET', `${W}/enquiries`, ws(undefined, (tx) => listEnquiries(tx)))
  add('PATCH', `${W}/enquiries/:id`, ws('conversation.reply', (tx, c) => setEnquiryStatus(tx, c.param('id'), c.body.status)))
}
