// Durable work (spec §9): persisted jobs with leases, and a send ledger where the intent is
// committed before the network call. Runs in-process here; the adapters it calls are MOCKS.
// shortcut: TypeScript, single process. The spec's separate Python worker is not built.
import { createHash, randomUUID } from 'node:crypto'
import { withTenant, type Db, type Tx } from '@lathar/database'
import type { AiAdapter } from './ai.ts'
import { captureEnquiry, publishedBehavior } from './assistant.ts'
import { published } from './knowledge.ts'
import { release, reserve, settle } from './usage.ts'

export interface Messaging {
  /** Resolves when the provider answered. Throwing means the outcome is unknown. */
  send(intent: { messageId: string; connectionId: string; text: string }): Promise<{ state: 'accepted' | 'failed'; providerMessageId?: string; errorCode?: string }>
}
/** MOCK: stands in for a provider accepting a message. Accepted is not delivered. */
export const mockMessaging: Messaging = { send: async () => ({ state: 'accepted', providerMessageId: `mock-${randomUUID()}` }) }

export interface WorkerDeps {
  worker: Db
  callback: Db
  ai: AiAdapter
  messaging: Messaging
}

export const enqueue = (tx: Tx, kind: string, dedupeKey: string, payload: object) =>
  tx.query(
    `INSERT INTO jobs (workspace_id, kind, dedupe_key, payload_ref) VALUES (app_workspace_id(), $1, $2, $3)
     ON CONFLICT (workspace_id, kind, dedupe_key) DO NOTHING`,
    [kind, dedupeKey, JSON.stringify(payload)],
  )

// ---------------------------------------------------------------- callback path

export interface InboundEvent {
  route: string
  numberId: string // the provider's identifier for the receiving number
  eventKey: string
  from: string
  name: string | null
  text: string
}

/**
 * Runs as the callback role. The tenant is derived from the server-owned number mapping;
 * an unknown number records nothing and triggers nothing.
 */
export async function receiveInbound(callback: Db, ev: InboundEvent): Promise<{ status: 'unknown_number' | 'duplicate' | 'queued'; eventId?: string }> {
  const target = (await callback.query<{ workspace_id: string; connection_id: string }>('SELECT * FROM resolve_connection($1, $2)', [ev.route, ev.numberId])).rows[0]
  if (!target) return { status: 'unknown_number' }
  return withTenant(callback, target.workspace_id, async (tx) => {
    const event = await tx.query<{ id: string }>(
      `INSERT INTO inbound_events (workspace_id, connection_id, external_event_key, kind, payload_hash)
       VALUES (app_workspace_id(), $1, $2, 'message', $3)
       ON CONFLICT (connection_id, external_event_key) DO NOTHING RETURNING id`,
      [target.connection_id, ev.eventKey, createHash('sha256').update(ev.text).digest('hex')],
    )
    const eventId = event.rows[0]?.id
    if (!eventId) return { status: 'duplicate' as const }
    // Event and job commit together, so an acknowledged event always has work queued for it.
    await tx.query(`INSERT INTO jobs (workspace_id, kind, dedupe_key, payload_ref) VALUES (app_workspace_id(), 'process_inbound', $1, $2)`, [
      `event:${eventId}`,
      JSON.stringify({ event_id: eventId, connection_id: target.connection_id, event_key: ev.eventKey, from: ev.from, name: ev.name, text: ev.text }),
    ])
    return { status: 'queued' as const, eventId }
  })
}

// ---------------------------------------------------------------- job handlers

interface Job {
  id: string
  workspace_id: string // from the leased row; the only source of tenant for a job
  kind: string
  payload_ref: Record<string, string | number | null>
  attempts: number
  max_attempts: number
}
type Result = Record<string, unknown>
const control = async (tx: Tx, conversationId: string, lock = false) => {
  const c = (await tx.query<{ mode: string; control_version: number; connection_id: string }>(`SELECT mode, control_version, connection_id FROM conversations WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [conversationId])).rows[0]
  const w = (await tx.query<{ paused: boolean; lock_version: number }>('SELECT replies_paused_at IS NOT NULL AS paused, lock_version FROM workspaces WHERE id = app_workspace_id()')).rows[0]
  if (!c || !w) throw new Error('conversation or workspace missing')
  return { ...c, ...w }
}

const handlers: Record<string, (d: WorkerDeps, job: Job) => Promise<Result>> = {
  // Creates the contact, conversation and inbound message. Safe to run twice.
  async process_inbound(d, job) {
    const p = job.payload_ref
    return withTenant(d.worker, job.workspace_id, async (tx) => {
      const contact = await tx.query<{ id: string }>(
        `INSERT INTO contacts (workspace_id, connection_id, provider_customer_id, name) VALUES (app_workspace_id(), $1, $2, $3)
         ON CONFLICT (connection_id, provider_customer_id) DO UPDATE SET name = COALESCE(EXCLUDED.name, contacts.name) RETURNING id`,
        [p.connection_id, p.from, p.name],
      )
      const conv = await tx.query<{ id: string }>(
        `INSERT INTO conversations (workspace_id, connection_id, contact_id, last_message_at) VALUES (app_workspace_id(), $1, $2, now())
         ON CONFLICT (workspace_id, contact_id) DO UPDATE SET last_message_at = now() RETURNING id`,
        [p.connection_id, contact.rows[0]?.id],
      )
      const conversationId = conv.rows[0]?.id ?? ''
      const msg = await tx.query<{ id: string }>(
        `INSERT INTO messages (workspace_id, conversation_id, connection_id, direction, sender, external_message_id, body, state, received_at)
         VALUES (app_workspace_id(), $1, $2, 'inbound', 'customer', $3, $4, 'received', now())
         ON CONFLICT (connection_id, external_message_id) WHERE external_message_id IS NOT NULL DO UPDATE SET body = messages.body RETURNING id`,
        [conversationId, p.connection_id, p.event_key, p.text],
      )
      await enqueue(tx, 'generate_reply', `event:${p.event_id}`, { event_id: p.event_id, conversation_id: conversationId, message_id: msg.rows[0]?.id, text: p.text })
      return { conversation_id: conversationId }
    })
  },

  async generate_reply(d, job) {
    const p = job.payload_ref
    const conversationId = String(p.conversation_id)
    const text = String(p.text)
    const stop = (tx: Tx, reason: string) => tx.query(`UPDATE inbound_events SET state = 'ignored' WHERE id = $1`, [p.event_id]).then(() => ({ replied: false, reason }))

    const snap = await withTenant(d.worker, job.workspace_id, async (tx) => {
      const c = await control(tx, conversationId, true)
      const knowledge = await published(tx)
      const reason = c.paused ? 'paused' : c.mode !== 'bot' ? 'staff_mode' : !knowledge ? 'no_published_knowledge' : undefined
      if (reason || !knowledge) return { done: await stop(tx, reason ?? 'no_published_knowledge') }
      // Budget is reserved atomically before generating. Without room, hand to staff; never spend elsewhere.
      const budget = await reserve(tx)
      if (budget !== 'ok') {
        await tx.query(`UPDATE conversations SET mode = 'handoff_requested', control_version = control_version + 1 WHERE id = $1`, [conversationId])
        await tx.query(`INSERT INTO handoffs (workspace_id, conversation_id, reason) VALUES (app_workspace_id(), $1, $2)`, [conversationId, budget === 'no_spending_limit' ? 'No spending limit is set' : 'Spending limit reached'])
        return { done: await stop(tx, budget) }
      }
      return { c, knowledge: knowledge.content, behavior: await publishedBehavior(tx) }
    })
    if (snap.done) return snap.done

    // Generation runs outside any transaction; pause, takeover or a publish can land meanwhile.
    // shortcut: a crash right here leaves the reservation held; add a sweeper with the real worker.
    let g: Awaited<ReturnType<AiAdapter['generate']>>
    try {
      g = await d.ai.generate({ knowledge: snap.knowledge, message: text })
    } catch (e) {
      await withTenant(d.worker, job.workspace_id, (tx) => release(tx))
      throw e
    }

    return withTenant(d.worker, job.workspace_id, async (tx) => {
      const now = await control(tx, conversationId, true)
      // Re-check immediately before creating the send intent: any control change wins over the reply.
      if (now.paused || now.lock_version !== snap.c.lock_version || now.mode !== 'bot' || now.control_version !== snap.c.control_version) {
        await release(tx)
        return stop(tx, 'control_changed')
      }
      let controlVersion = now.control_version
      if (g.kind === 'handoff') {
        controlVersion++
        await tx.query(`UPDATE conversations SET mode = 'handoff_requested', control_version = $2 WHERE id = $1`, [conversationId, controlVersion])
        await tx.query(`INSERT INTO handoffs (workspace_id, conversation_id, reason) VALUES (app_workspace_id(), $1, $2)`, [conversationId, g.reason])
        await captureEnquiry(tx, conversationId, String(p.message_id), text, snap.behavior.enquiry_fields)
      }
      const sendKey = `reply:${p.event_id}`
      await settle(tx, 'reply_generation', sendKey)
      const body = g.kind === 'answer' ? g.text : snap.behavior.handoff_message
      const m = await tx.query<{ id: string }>(
        `INSERT INTO messages (workspace_id, conversation_id, connection_id, direction, sender, body, state, fact_path)
         SELECT app_workspace_id(), $1, $2, 'outbound', 'bot', $3, 'reserved', $4
         WHERE NOT EXISTS (SELECT 1 FROM delivery_attempts WHERE logical_send_key = $5) RETURNING id`,
        [conversationId, now.connection_id, body, g.kind === 'answer' ? g.factPath : null, sendKey],
      )
      if (m.rows[0]) {
        // The unique logical send key is what makes a re-run a no-op instead of a second message.
        await tx.query(`INSERT INTO delivery_attempts (workspace_id, message_id, logical_send_key) VALUES (app_workspace_id(), $1, $2)`, [m.rows[0].id, sendKey])
        await enqueue(tx, 'submit_message', sendKey, { message_id: m.rows[0].id, control_version: controlVersion, lock_version: now.lock_version })
      }
      await tx.query(`UPDATE inbound_events SET state = 'processed' WHERE id = $1`, [p.event_id])
      return { replied: true, reason: g.kind }
    })
  },

  // The only place anything is sent. Never retried: an unknown outcome stays `uncertain`.
  async submit_message(d, job) {
    const p = job.payload_ref
    const finish = async (tx: Tx, state: string, providerId: string | null, errorCode: string | null) => {
      await tx.query('UPDATE messages SET state = $2, external_message_id = COALESCE($3, external_message_id) WHERE id = $1', [p.message_id, state, providerId])
      await tx.query('UPDATE delivery_attempts SET state = $2, provider_message_id = $3, error_code = $4, submitted_at = COALESCE(submitted_at, now()) WHERE message_id = $1', [p.message_id, state, providerId, errorCode])
      return { state, error_code: errorCode }
    }

    const intent = await withTenant(d.worker, job.workspace_id, async (tx) => {
      const a = (await tx.query<{ state: string; sender: string; body: string; conversation_id: string }>(
        `SELECT d.state, m.sender, m.body, m.conversation_id FROM delivery_attempts d JOIN messages m ON m.id = d.message_id AND m.workspace_id = d.workspace_id
         WHERE d.message_id = $1 FOR UPDATE OF d`, [p.message_id])).rows[0]
      if (!a) throw new Error('send intent missing')
      if (a.state !== 'reserved' && a.state !== 'submitting') return { done: { state: a.state } }
      // Found mid-send after a restart: it may or may not have gone out. Never send it again.
      if (a.state === 'submitting') return { done: await finish(tx, 'uncertain', null, 'interrupted_during_send') }
      const c = await control(tx, a.conversation_id, true)
      const connected = (await tx.query(`SELECT 1 FROM connections WHERE id = $1 AND state = 'connected'`, [c.connection_id])).rows[0]
      // Every send path re-checks control here, immediately before submission.
      const blocked = !connected ? 'connection_not_ready'
        : c.control_version !== p.control_version ? 'stopped_by_takeover'
        : a.sender === 'staff' ? (c.mode !== 'human' ? 'stopped_by_takeover' : null)
        : c.paused || c.lock_version !== p.lock_version ? 'stopped_by_pause' : null
      if (blocked) return { done: await finish(tx, 'failed', null, blocked) }
      await finish(tx, 'submitting', null, null)
      return { text: a.body, connectionId: c.connection_id }
    }) // the intent is committed here, before the network call

    if (intent.done) return intent.done
    let outcome: Awaited<ReturnType<Messaging['send']>> | null = null
    try {
      outcome = await d.messaging.send({ messageId: String(p.message_id), connectionId: intent.connectionId, text: intent.text })
    } catch {
      // Timeout or dropped connection after the request may have left: unknown, not failed.
    }
    return withTenant(d.worker, job.workspace_id, (tx) =>
      outcome ? finish(tx, outcome.state, outcome.providerMessageId ?? null, outcome.errorCode ?? null) : finish(tx, 'uncertain', null, 'no_answer_from_provider'))
  },
}

// ---------------------------------------------------------------- leasing

const LEASE_SECONDS = 30

/** Takes one job, or an expired lease left by a dead worker. Committed at once so no one else takes it. */
export async function lease(worker: Db, kinds: string[] | null = null): Promise<Job | null> {
  const r = await worker.query<Job>(
    `UPDATE jobs SET state = 'leased', lease_until = now() + interval '${LEASE_SECONDS} seconds', attempts = attempts + 1
     WHERE id = (SELECT id FROM jobs
                 WHERE ((state IN ('queued', 'retry_wait') AND available_at <= now()) OR (state = 'leased' AND lease_until < now()))
                   AND ($1::text[] IS NULL OR kind = ANY($1))
                 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, workspace_id, kind, payload_ref, attempts, max_attempts`,
    [kinds],
  )
  return r.rows[0] ?? null
}

/** Runs every job that is ready now. Called after enqueueing and on a timer. */
export async function drain(d: WorkerDeps, kinds: string[] | null = null): Promise<number> {
  let n = 0
  for (let job = await lease(d.worker, kinds); job; job = await lease(d.worker, kinds)) {
    n++
    const handler = handlers[job.kind]
    try {
      if (!handler) throw new Error('unknown job kind')
      if (job.attempts > job.max_attempts) throw new Error('attempts exhausted')
      const result = await handler(d, job)
      await d.worker.query(`UPDATE jobs SET state = 'complete', lease_until = NULL, result = $2 WHERE id = $1 AND state = 'leased'`, [job.id, JSON.stringify(result)])
    } catch (e) {
      const dead = job.attempts >= job.max_attempts
      console.error(`job ${job.id} ${job.kind} failed:`, e instanceof Error ? e.message : 'unknown') // safe summary only
      await d.worker.query(
        `UPDATE jobs SET state = $2, lease_until = NULL, error_code = 'handler_error', available_at = now() + ($3 || ' seconds')::interval WHERE id = $1`,
        [job.id, dead ? 'dead_letter' : 'retry_wait', String(2 ** job.attempts)],
      )
    }
  }
  return n
}
