// Durable work (spec §9): persisted jobs with fenced, renewable leases, and a send ledger where
// the intent is committed before any network call.
//
// What this does and does not guarantee:
//  - A job is owned through a lease token. Every database write a handler makes re-checks the
//    token, so a worker that stalled and lost its lease cannot change anything afterwards.
//  - A message is submitted to a provider at most once: only the worker that moved the intent
//    from `reserved` to `submitting` may call the provider, and nobody ever sends a `submitting`
//    intent again. If the outcome is unknown it stays `uncertain` and is not resent.
//  - This is not exactly-once delivery. A provider may accept a message whose acknowledgement
//    we never see; that shows as `uncertain` until a receipt or a person resolves it.
import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { withTenant, type Db, type Tx } from '@lathar/database'
import { AiError, vet, type AiAdapter, type AiRequest, type Generated, type Turn } from './adapters/ai.ts'
import { captureEnquiry, publishedBehavior } from './assistant.ts'
import { published } from './knowledge.ts'
import { openSecret } from './secrets.ts'
import { countMessage, release, reserve, settle, SYNTHETIC_COST_MICROS } from './usage.ts'

export interface SendTarget {
  route: string
  mode: string
  connectionId: string
  /** The provider's ID for the business number (Cloud API phone number ID, or the linked number). */
  numberId: string
  /** Decrypted tenant credential for this connection, when the route uses one. Never logged. */
  token: string | null
  /** The customer's address as the provider gave it to us. */
  to: string
}
export interface Messaging {
  /**
   * Resolves when the provider answered: `accepted` or a definite `failed`. Throwing means the
   * outcome is unknown and the message must not be sent again.
   */
  send(intent: { messageId: string; text: string; target: SendTarget; signal?: AbortSignal }): Promise<{ state: 'accepted' | 'failed'; providerMessageId?: string; errorCode?: string }>
  /** Reads the number behind the credentials. Throws a short safe reason when it cannot. */
  identify?(target: Omit<SendTarget, 'to'>): Promise<{ displayNumber: string }>
}
export interface Notifier {
  /** Delivers one notice to one person. Throwing means it was not delivered. */
  send(n: { to: string; subject: string; body: string }): Promise<void>
}

export interface WorkerDeps {
  worker: Db
  ai: AiAdapter
  messaging: Messaging
  notifier: Notifier
  /** Where staff notices link to. Null: read what the web process published about itself. */
  baseUrl: string | null
  /** Opens tenant secrets. Held only in server memory. */
  masterKey: Buffer
}

export const enqueue = (tx: Tx, kind: string, dedupeKey: string, payload: object, queue = 'default') =>
  tx.query(
    `INSERT INTO jobs (workspace_id, kind, dedupe_key, payload_ref, queue) VALUES (app_workspace_id(), $1, $2, $3, $4)
     ON CONFLICT (workspace_id, kind, dedupe_key) DO NOTHING`,
    [kind, dedupeKey, JSON.stringify(payload), queue],
  )
/** Sends for a live QR connection can only be made by the gateway process holding its session. */
export const sendQueue = (route: string, mode: string) => (route === 'unofficial_qr' && mode === 'live' ? 'qr' : 'default')

// ---------------------------------------------------------------- callback path

export interface InboundEvent {
  route: string
  numberId: string // the provider's identifier for the receiving number
  eventKey: string
  from: string
  name: string | null
  /** Null for anything that is not plain text (image, audio, location…). */
  text: string | null
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
      [target.connection_id, ev.eventKey, createHash('sha256').update(ev.text ?? '').digest('hex')],
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

// ---------------------------------------------------------------- leases and fencing

const LEASE_SECONDS = 30
/** A provider call must finish well inside one lease. */
const SEND_TIMEOUT_MS = 15_000

interface Job {
  id: string
  workspace_id: string // from the leased row; the only source of tenant for a job
  kind: string
  payload_ref: Record<string, string | number | boolean | null>
  attempts: number
  max_attempts: number
  lease_token: string
  reserved: number // micro-dollars an earlier attempt of this job died holding
}
type Result = Record<string, unknown>

class LeaseLost extends Error {}
/** Stop retrying now and hand the customer to staff with this reason. */
class GiveUp extends Error {}
/** Try again after this many seconds (counts as an attempt). */
class RetryAfter extends Error {
  seconds: number
  constructor(seconds: number, message: string) {
    super(message)
    this.seconds = seconds
  }
}
/** Not this job's turn yet; come back shortly without using up an attempt. */
class Defer extends Error {}

/** Takes one job, or an expired lease left by a stalled or dead worker, under a fresh token. */
export async function lease(worker: Db, kinds: string[] | null = null, queue = 'default'): Promise<Job | null> {
  const r = await worker.query<Job>(
    `UPDATE jobs SET state = 'leased', lease_until = now() + interval '${LEASE_SECONDS} seconds', attempts = attempts + 1, lease_token = gen_random_uuid()
     WHERE id = (SELECT id FROM jobs
                 WHERE ((state IN ('queued', 'retry_wait') AND available_at <= now()) OR (state = 'leased' AND lease_until < now()))
                   AND ($1::text[] IS NULL OR kind = ANY($1)) AND queue = $2
                 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, workspace_id, kind, payload_ref, attempts, max_attempts, lease_token, COALESCE((result->>'reserved')::float8, 0) AS reserved`,
    [kinds, queue],
  )
  return r.rows[0] ?? null
}

/**
 * A transaction that only proceeds while this worker still owns the job. Locking the job row
 * also stops another worker taking it over until this transaction commits.
 */
function fenced<T>(d: WorkerDeps, job: Job, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant(d.worker, job.workspace_id, async (tx) => {
    const own = await tx.query(`SELECT 1 FROM jobs WHERE id = $1 AND lease_token = $2 AND state = 'leased' FOR UPDATE`, [job.id, job.lease_token])
    if (!own.rows[0]) throw new LeaseLost('lease lost')
    return fn(tx)
  })
}

const control = async (tx: Tx, conversationId: string) => {
  const c = (await tx.query<{ mode: string; control_version: number; connection_id: string; last_inbound_at: Date | null }>(
    'SELECT mode, control_version, connection_id, last_inbound_at FROM conversations WHERE id = $1 FOR UPDATE', [conversationId])).rows[0]
  const w = (await tx.query<{ paused: boolean; lock_version: number; state: string; reply_mode: string; name: string; stopped: boolean }>(
    `SELECT replies_paused_at IS NOT NULL AS paused, lock_version, state, reply_mode, name,
            (SELECT value = 'true' FROM platform_controls WHERE key = 'sending_stopped') AS stopped
     FROM workspaces WHERE id = app_workspace_id()`)).rows[0]
  if (!c || !w) throw new Error('conversation or workspace missing')
  return { ...c, ...w }
}

/** Hands the conversation to staff and queues their notice. Returns the new control version. */
async function requestHandoff(tx: Tx, conversationId: string, reason: string): Promise<number> {
  const c = await tx.query<{ control_version: number }>(`UPDATE conversations SET mode = 'handoff_requested', control_version = control_version + 1 WHERE id = $1 RETURNING control_version`, [conversationId])
  const h = await tx.query<{ id: string }>(`INSERT INTO handoffs (workspace_id, conversation_id, reason) VALUES (app_workspace_id(), $1, $2) RETURNING id`, [conversationId, reason.slice(0, 200)])
  const id = h.rows[0]?.id ?? ''
  await enqueue(tx, 'send_handoff_notice', `handoff:${id}`, { handoff_id: id })
  return c.rows[0]?.control_version ?? 0
}
// The job row remembers a held reservation, so a re-run after a crash neither leaks it nor reserves twice.
const hold = (tx: Tx, jobId: string, micros: number) => tx.query('UPDATE jobs SET result = $2 WHERE id = $1', [jobId, micros ? JSON.stringify({ reserved: micros }) : null])
const letGo = async (tx: Tx, jobId: string, micros: number) => {
  if (micros) await release(tx, micros)
  await hold(tx, jobId, 0)
}
const newerInbound = async (tx: Tx, conversationId: string, messageId: unknown) =>
  (await tx.query(
    `SELECT 1 FROM messages n, messages m WHERE m.id = $2 AND n.conversation_id = $1 AND n.direction = 'inbound'
       AND (n.created_at, n.id) > (m.created_at, m.id) LIMIT 1`, [conversationId, messageId])).rows.length > 0

// ---------------------------------------------------------------- job handlers

const handlers: Record<string, (d: WorkerDeps, job: Job) => Promise<Result>> = {
  // Creates the contact, conversation and inbound message. Safe to run twice.
  async process_inbound(d, job) {
    const p = job.payload_ref
    return fenced(d, job, async (tx) => {
      const contact = await tx.query<{ id: string }>(
        `INSERT INTO contacts (workspace_id, connection_id, provider_customer_id, name) VALUES (app_workspace_id(), $1, $2, $3)
         ON CONFLICT (connection_id, provider_customer_id) DO UPDATE SET name = COALESCE(EXCLUDED.name, contacts.name) RETURNING id`,
        [p.connection_id, p.from, p.name],
      )
      const conv = await tx.query<{ id: string }>(
        `INSERT INTO conversations (workspace_id, connection_id, contact_id, last_message_at, last_inbound_at) VALUES (app_workspace_id(), $1, $2, now(), now())
         ON CONFLICT (workspace_id, contact_id) DO UPDATE SET last_message_at = now(), last_inbound_at = now() RETURNING id`,
        [p.connection_id, contact.rows[0]?.id],
      )
      const conversationId = conv.rows[0]?.id ?? ''
      const msg = await tx.query<{ id: string }>(
        `INSERT INTO messages (workspace_id, conversation_id, connection_id, direction, sender, external_message_id, type, body, state, received_at)
         VALUES (app_workspace_id(), $1, $2, 'inbound', 'customer', $3, $4, $5, 'received', now())
         ON CONFLICT (connection_id, external_message_id) WHERE external_message_id IS NOT NULL DO UPDATE SET body = messages.body RETURNING id`,
        [conversationId, p.connection_id, p.event_key, p.text === null ? 'other' : 'text', p.text ?? '[The customer sent something that is not text]'],
      )
      // A draft written for an older message no longer answers the conversation.
      const stale = await tx.query(`UPDATE messages SET state = 'discarded' WHERE conversation_id = $1 AND state = 'draft' RETURNING id`, [conversationId])
      if (stale.rows.length) {
        // The chat was only waiting for that draft's approval, so the assistant drafts again for the newer message.
        await tx.query(`UPDATE conversations SET mode = 'bot', control_version = control_version + 1 WHERE id = $1 AND mode = 'handoff_requested'`, [conversationId])
        await tx.query(`UPDATE handoffs SET resolved_at = now(), resolution = 'draft_superseded' WHERE conversation_id = $1 AND resolved_at IS NULL`, [conversationId])
      }
      await enqueue(tx, 'generate_reply', `event:${p.event_id}`, { event_id: p.event_id, conversation_id: conversationId, message_id: msg.rows[0]?.id, text: p.text })
      return { conversation_id: conversationId }
    })
  },

  async generate_reply(d, job) {
    const p = job.payload_ref
    const conversationId = String(p.conversation_id)
    const sendKey = `reply:${p.event_id}`
    const stop = (tx: Tx, reason: string) => tx.query(`UPDATE inbound_events SET state = 'ignored' WHERE id = $1`, [p.event_id]).then(() => ({ replied: false, reason }))

    const snap = await fenced(d, job, async (tx) => {
      const c = await control(tx, conversationId)
      const knowledge = await published(tx)
      const conn = (await tx.query<{ mode: string }>('SELECT mode FROM connections WHERE id = $1', [c.connection_id])).rows[0]
      const reason = c.paused ? 'paused' : c.mode !== 'bot' ? 'staff_mode' : !knowledge ? 'no_published_knowledge'
        : conn?.mode === 'live' && c.state !== 'active' ? 'workspace_not_active'
        : (await newerInbound(tx, conversationId, p.message_id)) ? 'superseded' : undefined
      if (reason || !knowledge) {
        await letGo(tx, job.id, job.reserved)
        return { done: await stop(tx, reason ?? 'no_published_knowledge') }
      }
      const handoff = async (why: string, code: string) => {
        await letGo(tx, job.id, job.reserved)
        await requestHandoff(tx, conversationId, why)
        return { done: await stop(tx, code) }
      }
      if (p.text === null) return handoff('The customer sent something that is not text', 'not_text')

      const cfg = (await tx.query<{ provider: string; model_id: string; endpoint: string | null; ciphertext: Buffer | null }>(
        `SELECT a.provider, a.model_id, a.endpoint, s.ciphertext FROM ai_configs a
         LEFT JOIN secret_refs s ON s.id = a.secret_ref_id AND s.workspace_id = a.workspace_id AND s.revoked_at IS NULL
         WHERE a.state <> 'revoked'`)).rows[0]
      const behavior = await publishedBehavior(tx)
      const history = (await tx.query<Turn>(
        `SELECT CASE direction WHEN 'inbound' THEN 'customer' ELSE 'business' END AS "from", body AS text FROM (
           SELECT direction, body, created_at, id FROM messages
           WHERE conversation_id = $1 AND type = 'text' AND state NOT IN ('draft', 'discarded', 'failed')
           ORDER BY created_at DESC, id DESC LIMIT 12) m ORDER BY created_at, id`, [conversationId])).rows
      const req: AiRequest = {
        config: {
          provider: cfg?.provider ?? '', model: cfg?.model_id ?? '', endpoint: cfg?.endpoint ?? null,
          apiKey: cfg?.ciphertext ? openSecret(d.masterKey, `${job.workspace_id}:ai_api_key:${cfg.provider}:${cfg.endpoint ?? ''}`, cfg.ciphertext) : null,
        },
        businessName: c.name, knowledge: knowledge.content, instructions: behavior.instructions, history, message: String(p.text),
      }
      // The reservation is an upper bound on this one call, taken atomically before it is made.
      let bound: number
      try {
        bound = d.ai.bound?.(req) ?? SYNTHETIC_COST_MICROS
      } catch (e) {
        return handoff(e instanceof AiError ? e.message : 'The AI provider is not set up', 'ai_not_ready')
      }
      const budget = job.reserved ? 'ok' : await reserve(tx, bound)
      if (budget !== 'ok') return handoff(budget === 'no_spending_limit' ? 'No spending limit is set' : 'Spending limit reached', budget)
      const reserved = job.reserved || bound
      await hold(tx, job.id, reserved)
      return { c, req, behavior, reserved, live: conn?.mode === 'live' }
    })
    if (snap.done) return snap.done

    // Generation runs outside any transaction; pause, takeover or a publish can land meanwhile.
    let raw: Generated
    try {
      raw = await d.ai.generate(snap.req)
    } catch (e) {
      const err = e instanceof AiError ? e : null
      await fenced(d, job, async (tx) => {
        await letGo(tx, job.id, snap.reserved)
        if (err?.kind === 'auth') await tx.query(`UPDATE ai_configs SET state = 'invalid', last_error = 'key_rejected' WHERE state <> 'revoked'`)
      })
      if (err?.kind === 'auth') throw new GiveUp('The AI provider rejected your API key')
      if (err?.kind === 'invalid' || err?.kind === 'refused') throw new GiveUp(err.message)
      if (err?.kind === 'rate_limit') throw new RetryAfter(err.retryAfter ?? backoffSeconds(job.attempts), err.message)
      throw e
    }
    const g = vet(raw, snap.req)

    return fenced(d, job, async (tx) => {
      const now = await control(tx, conversationId)
      const already = (await tx.query('SELECT 1 FROM usage_events WHERE attribution_key = $1', [sendKey])).rows.length > 0
      // What the provider charged is recorded even if the reply is then dropped.
      await settle(tx, 'reply_generation', sendKey, snap.reserved, raw.usage)
      await hold(tx, job.id, 0)
      if (already) return { replied: false, reason: 'already_handled' }
      // Re-check immediately before creating the send intent: any control change wins over the reply.
      if (now.paused || now.stopped || now.lock_version !== snap.c.lock_version || now.mode !== 'bot' || now.control_version !== snap.c.control_version) return stop(tx, 'control_changed')
      if (await newerInbound(tx, conversationId, p.message_id)) return stop(tx, 'superseded')

      const supervised = now.reply_mode !== 'autonomous'
      const text = String(p.text)
      let controlVersion = now.control_version
      if (g.kind === 'handoff') {
        controlVersion = await requestHandoff(tx, conversationId, g.reason)
        await captureEnquiry(tx, conversationId, String(p.message_id), text, snap.behavior.enquiry_fields)
      }
      await tx.query(`UPDATE inbound_events SET state = 'processed' WHERE id = $1`, [p.event_id])

      if (supervised) {
        // Nothing is sent without a person. A reply becomes a draft; a handoff just waits for staff.
        if (g.kind === 'handoff') return { replied: false, reason: 'handoff' }
        await tx.query(`UPDATE messages SET state = 'discarded' WHERE conversation_id = $1 AND state = 'draft'`, [conversationId])
        await tx.query(
          `INSERT INTO messages (workspace_id, conversation_id, connection_id, direction, sender, body, state, fact_path)
           VALUES (app_workspace_id(), $1, $2, 'outbound', 'bot', $3, 'draft', $4)`,
          [conversationId, now.connection_id, g.text, g.kind === 'answer' ? g.factPath : null])
        await requestHandoff(tx, conversationId, 'A drafted reply is waiting for your approval')
        return { replied: false, reason: 'draft' }
      }

      const body = g.kind === 'handoff' ? snap.behavior.handoff_message : g.text
      const m = await tx.query<{ id: string }>(
        `INSERT INTO messages (workspace_id, conversation_id, connection_id, direction, sender, body, state, fact_path)
         VALUES (app_workspace_id(), $1, $2, 'outbound', 'bot', $3, 'reserved', $4) RETURNING id`,
        [conversationId, now.connection_id, body, g.kind === 'answer' ? g.factPath : null])
      const messageId = m.rows[0]?.id ?? ''
      // The unique logical send key is what makes a re-run a no-op instead of a second message.
      await tx.query(`INSERT INTO delivery_attempts (workspace_id, message_id, logical_send_key) VALUES (app_workspace_id(), $1, $2)`, [messageId, sendKey])
      const conn = (await tx.query<{ route: string; mode: string }>('SELECT route, mode FROM connections WHERE id = $1', [now.connection_id])).rows[0]
      await enqueue(tx, 'submit_message', sendKey, { message_id: messageId, control_version: controlVersion, lock_version: now.lock_version }, sendQueue(conn?.route ?? '', conn?.mode ?? ''))
      return { replied: true, reason: g.kind }
    })
  },

  // The only place anything is sent, for every route and every sender.
  async submit_message(d, job) {
    const p = job.payload_ref
    const finish = async (tx: Tx, state: string, providerId: string | null, errorCode: string | null) => {
      await tx.query('UPDATE messages SET state = $2, external_message_id = COALESCE($3, external_message_id) WHERE id = $1', [p.message_id, state, providerId])
      await tx.query('UPDATE delivery_attempts SET state = $2, provider_message_id = $3, error_code = $4, submitted_at = COALESCE(submitted_at, now()) WHERE message_id = $1', [p.message_id, state, providerId, errorCode])
      return { state, error_code: errorCode }
    }

    const intent = await fenced(d, job, async (tx) => {
      const a = (await tx.query<{ state: string; sender: string; body: string; conversation_id: string; created_at: Date }>(
        `SELECT d.state, m.sender, m.body, m.conversation_id, m.created_at FROM delivery_attempts d JOIN messages m ON m.id = d.message_id AND m.workspace_id = d.workspace_id
         WHERE d.message_id = $1 FOR UPDATE OF d`, [p.message_id])).rows[0]
      if (!a) throw new Error('send intent missing')
      if (a.state !== 'reserved' && a.state !== 'submitting') return { done: { state: a.state } }
      // Found mid-send after a stall or restart: it may or may not have gone out. Never send it again.
      if (a.state === 'submitting') return { done: await finish(tx, 'uncertain', null, 'interrupted_during_send') }
      const c = await control(tx, a.conversation_id)
      const conn = (await tx.query<{ route: string; mode: string; state: string; verified_number_id: string; ciphertext: Buffer | null; to: string }>(
        `SELECT n.route, n.mode, n.state, n.verified_number_id, s.ciphertext,
                (SELECT k.provider_customer_id FROM conversations v JOIN contacts k ON k.id = v.contact_id AND k.workspace_id = v.workspace_id WHERE v.id = $2) AS "to"
         FROM connections n LEFT JOIN secret_refs s ON s.id = n.secret_ref_id AND s.workspace_id = n.workspace_id AND s.revoked_at IS NULL
         WHERE n.id = $1`, [c.connection_id, a.conversation_id])).rows[0]
      const live = conn?.mode === 'live'
      // Every send path re-checks control here, immediately before dispatch.
      const blocked = c.stopped ? 'stopped_by_operator'
        : conn?.state !== 'connected' ? 'connection_not_ready'
        : live && c.state !== 'active' ? 'workspace_not_active'
        : c.control_version !== p.control_version ? 'stopped_by_takeover'
        : a.sender === 'staff' ? (c.mode !== 'human' ? 'stopped_by_takeover' : null)
        : p.approved ? null // a person approved this exact text
        : c.paused || c.lock_version !== p.lock_version ? 'stopped_by_pause'
        : c.reply_mode !== 'autonomous' ? 'needs_approval'
        // Free-form replies are only allowed for 24 hours after the customer's last message (Cloud API).
        : null
      const late = live && conn?.route === 'official_cloud_api' && (!c.last_inbound_at || Date.now() - c.last_inbound_at.getTime() > 24 * 3600_000 - 5 * 60_000)
      if (blocked || late) return { done: await finish(tx, 'failed', null, blocked ?? 'outside_reply_window') }

      // Conversation order: wait for any earlier message in this chat that is still on its way out.
      const earlier = await tx.query(
        `SELECT 1 FROM delivery_attempts e JOIN messages m ON m.id = e.message_id AND m.workspace_id = e.workspace_id
         WHERE m.conversation_id = $1 AND (m.created_at, m.id) < ($2, $3)
           AND (e.state = 'submitting' OR (e.state = 'reserved' AND EXISTS (
                 SELECT 1 FROM jobs j WHERE j.kind = 'submit_message' AND j.dedupe_key = e.logical_send_key AND j.state IN ('queued', 'leased', 'retry_wait')))) LIMIT 1`,
        [a.conversation_id, a.created_at, p.message_id])
      if (earlier.rows[0]) throw new Defer('an earlier message in this conversation is still being sent')

      if (live && (await countMessage(tx)) !== 'ok') return { done: await finish(tx, 'failed', null, 'message_cap_reached') }
      await finish(tx, 'submitting', null, null)
      // A full lease from now, so the provider call below cannot outlive this worker's ownership.
      await tx.query(`UPDATE jobs SET lease_until = now() + interval '${LEASE_SECONDS} seconds' WHERE id = $1`, [job.id])
      return {
        text: a.body,
        target: {
          route: conn.route, mode: conn.mode, connectionId: c.connection_id, numberId: conn.verified_number_id, to: conn.to,
          token: conn.ciphertext ? openSecret(d.masterKey, `${job.workspace_id}:whatsapp_token:${conn.route}`, conn.ciphertext) : null,
        },
      }
    }) // the intent is committed here, before the network call

    if (intent.done) return intent.done
    let outcome: Awaited<ReturnType<Messaging['send']>> | null = null
    try {
      const signal = AbortSignal.timeout(SEND_TIMEOUT_MS)
      outcome = await Promise.race([
        d.messaging.send({ messageId: String(p.message_id), text: intent.text, target: intent.target, signal }),
        new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('send timed out')))),
      ])
    } catch {
      // Timeout or dropped connection after the request may have left: unknown, not failed.
    }
    const record = (tx: Tx) => (outcome ? finish(tx, outcome.state, outcome.providerMessageId ?? null, outcome.errorCode ?? null) : finish(tx, 'uncertain', null, 'no_answer_from_provider'))
    try {
      return await fenced(d, job, record)
    } catch (e) {
      if (!(e instanceof LeaseLost) || outcome?.state !== 'accepted') throw e
      // This worker stalled and another marked the send uncertain. The provider's acceptance is
      // evidence, not a decision, so it may still be recorded; nothing else is touched.
      const id = outcome.providerMessageId ?? null
      await withTenant(d.worker, job.workspace_id, async (tx) => {
        const r = await tx.query(`UPDATE delivery_attempts SET state = 'accepted', provider_message_id = $2, error_code = NULL WHERE message_id = $1 AND state IN ('submitting', 'uncertain') RETURNING id`, [p.message_id, id])
        if (r.rows[0]) await tx.query(`UPDATE messages SET state = 'accepted', external_message_id = COALESCE($2, external_message_id) WHERE id = $1`, [p.message_id, id])
      })
      throw e
    }
  },

  // Tells every active member that a customer is waiting. One outbox row per person, with the
  // intent committed before the mail call: a notice whose outcome is unknown is not sent twice.
  async send_handoff_notice(d, job) {
    const handoffId = job.payload_ref.handoff_id
    const setNotice = (state: string) => fenced(d, job, (tx) => tx.query('UPDATE handoffs SET notice_state = $2 WHERE id = $1', [handoffId, state]))
    const plan = await fenced(d, job, async (tx) => {
      const h = (await tx.query<{ reason: string; conversation_id: string; handled: boolean; workspace: string; number: string; base: string | null }>(
        `SELECT h.reason, h.conversation_id, (h.acknowledged_at IS NOT NULL OR h.resolved_at IS NOT NULL) AS handled, w.name AS workspace,
                right(k.provider_customer_id, 4) AS number, (SELECT value FROM runtime_info WHERE key = 'base_url') AS base
         FROM handoffs h JOIN workspaces w ON w.id = h.workspace_id
         JOIN conversations c ON c.id = h.conversation_id AND c.workspace_id = h.workspace_id
         JOIN contacts k ON k.id = c.contact_id AND k.workspace_id = c.workspace_id WHERE h.id = $1`, [handoffId])).rows[0]
      if (!h) throw new Error('handoff missing')
      if (h.handled) return { h, skip: true, total: 0, due: [] }
      await tx.query(
        `INSERT INTO notifications (workspace_id, handoff_id, user_id)
         SELECT app_workspace_id(), $1, m.user_id FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = app_workspace_id() AND m.status = 'active' AND u.status = 'active'
         ON CONFLICT (handoff_id, user_id) DO NOTHING`, [handoffId])
      // Left in `sending` by a stalled or dead attempt: it may have gone out, so it is not repeated.
      await tx.query(`UPDATE notifications SET state = 'uncertain', error_code = 'interrupted_during_send' WHERE handoff_id = $1 AND state = 'sending'`, [handoffId])
      const all = (await tx.query<{ id: string; state: string; email: string }>('SELECT n.id, n.state, u.email FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.handoff_id = $1', [handoffId])).rows
      return { h, skip: false, total: all.length, due: all.filter((n) => n.state === 'queued' || n.state === 'failed') }
    })
    // Staff already took over: telling them now would only be noise.
    if (plan.skip) {
      await setNotice('skipped')
      return { notified: 0, reason: 'already_handled' }
    }
    const base = d.baseUrl ?? plan.h.base ?? ''
    let failed = 0
    for (const n of plan.due) {
      await fenced(d, job, (tx) => tx.query(`UPDATE notifications SET state = 'sending' WHERE id = $1`, [n.id]))
      // The notice carries the reason and a link, never the customer's message or full number.
      const sent = await d.notifier.send({
        to: n.email, subject: `A customer is waiting for staff · ${plan.h.workspace}`,
        body: `Customer ••• ${plan.h.number} needs a person: ${plan.h.reason}.\n${base}/w/${job.workspace_id}/inbox/${plan.h.conversation_id}`,
      }).then(() => true, () => false)
      if (!sent) failed++
      await fenced(d, job, (tx) =>
        tx.query(`UPDATE notifications SET state = $2, error_code = $3, sent_at = CASE WHEN $2 = 'sent' THEN now() END WHERE id = $1`, [n.id, sent ? 'sent' : 'failed', sent ? null : 'delivery_failed']))
    }
    if (failed || !plan.total) {
      await setNotice('failed')
      throw new Error(plan.total ? 'staff notice not delivered' : 'no one to notify') // retried with backoff; people already told are skipped
    }
    await setNotice('sent')
    return { notified: plan.total }
  },

  // Test chat: one question against the published facts, with nothing sent to anyone. With a
  // live adapter this is a real, billable call on the tenant's own key, inside their limit.
  async sample_chat(d, job) {
    const message = String(job.payload_ref.message)
    const key = `test:${job.id}`
    const snap = await fenced(d, job, async (tx) => {
      const knowledge = await published(tx)
      if (!knowledge) return { done: { error: 'NO_PUBLISHED_KNOWLEDGE' } }
      const cfg = (await tx.query<{ provider: string; model_id: string; endpoint: string | null; ciphertext: Buffer | null }>(
        `SELECT a.provider, a.model_id, a.endpoint, s.ciphertext FROM ai_configs a
         LEFT JOIN secret_refs s ON s.id = a.secret_ref_id AND s.workspace_id = a.workspace_id AND s.revoked_at IS NULL
         WHERE a.state <> 'revoked'`)).rows[0]
      const behavior = await publishedBehavior(tx)
      const name = (await tx.query<{ name: string }>('SELECT name FROM workspaces WHERE id = app_workspace_id()')).rows[0]?.name ?? ''
      const req: AiRequest = {
        config: {
          provider: cfg?.provider ?? '', model: cfg?.model_id ?? '', endpoint: cfg?.endpoint ?? null,
          apiKey: cfg?.ciphertext ? openSecret(d.masterKey, `${job.workspace_id}:ai_api_key:${cfg.provider}:${cfg.endpoint ?? ''}`, cfg.ciphertext) : null,
        },
        businessName: name, knowledge: knowledge.content, instructions: behavior.instructions, history: [{ from: 'customer', text: message }], message,
      }
      let bound: number
      try {
        bound = d.ai.bound?.(req) ?? SYNTHETIC_COST_MICROS
      } catch (e) {
        return { done: { error: 'AI_NOT_READY', message: e instanceof AiError ? e.message : 'The AI provider is not set up' } }
      }
      const budget = job.reserved ? 'ok' : await reserve(tx, bound)
      if (budget !== 'ok') return { done: { error: budget.toUpperCase() } }
      const reserved = job.reserved || bound
      await hold(tx, job.id, reserved)
      return { req, behavior, reserved, knowledge }
    })
    if (snap.done) return snap.done
    let raw: Generated
    try {
      raw = await d.ai.generate(snap.req)
    } catch (e) {
      await fenced(d, job, (tx) => letGo(tx, job.id, snap.reserved))
      // A test question is not retried: the person asking sees what went wrong.
      return { error: 'AI_FAILED', message: e instanceof AiError ? e.message : 'The AI provider call failed' }
    }
    const g = vet(raw, snap.req)
    return fenced(d, job, async (tx) => {
      const result = {
        question: message, knowledge_sequence: snap.knowledge.sequence,
        ...(g.kind === 'handoff' ? { outcome: 'handoff', reply: snap.behavior.handoff_message, reason: g.reason }
          : g.kind === 'clarify' ? { outcome: 'clarify', reply: g.text }
          : { outcome: 'answered', reply: g.text, fact_path: g.factPath }),
      }
      const mode = d.ai.live ? 'live' : 'mock'
      await tx.query(
        // A live run records who asked for it and the most it could have cost (in cents, rounded up).
        `INSERT INTO test_runs (workspace_id, type, knowledge_version_id, mode, status, results, authorized_by, cost_ceiling_minor, currency)
         VALUES (app_workspace_id(), 'sample_chat', $1, $2, 'passed', $3, $4, $5, 'USD')`,
        [snap.knowledge.id, mode, JSON.stringify(result), job.payload_ref.user_id ?? null, Math.ceil(snap.reserved / 10_000)])
      await settle(tx, 'test_chat', key, snap.reserved, raw.usage)
      await hold(tx, job.id, 0)
      return { mode, ...result }
    })
  },

  // Live check of the saved key and model. It reads model metadata and generates nothing billable.
  async validate_ai_config(d, job) {
    const cfg = await fenced(d, job, async (tx) =>
      (await tx.query<{ id: string; provider: string; model_id: string; endpoint: string | null; revision: number; ciphertext: Buffer | null }>(
        `SELECT a.id, a.provider, a.model_id, a.endpoint, a.revision, s.ciphertext FROM ai_configs a
         LEFT JOIN secret_refs s ON s.id = a.secret_ref_id AND s.workspace_id = a.workspace_id AND s.revoked_at IS NULL
         WHERE a.id = $1 AND a.state = 'validating'`, [job.payload_ref.ai_config_id])).rows[0])
    if (!cfg) return { state: 'skipped' }
    let error: string | null = null
    try {
      if (!d.ai.check) throw new AiError('invalid', 'This build has no live AI adapter')
      await d.ai.check({
        provider: cfg.provider, model: cfg.model_id, endpoint: cfg.endpoint,
        apiKey: cfg.ciphertext ? openSecret(d.masterKey, `${job.workspace_id}:ai_api_key:${cfg.provider}:${cfg.endpoint ?? ''}`, cfg.ciphertext) : null,
      })
    } catch (e) {
      if (e instanceof AiError && (e.kind === 'rate_limit' || e.kind === 'unavailable')) throw new RetryAfter(e.retryAfter ?? backoffSeconds(job.attempts), e.message)
      error = e instanceof AiError ? e.message : 'The check failed'
    }
    await fenced(d, job, async (tx) => {
      // Only if nothing changed while the check ran: a new key or model needs its own check.
      const r = await tx.query(
        `UPDATE ai_configs SET state = $3, last_error = $4, validated_at = CASE WHEN $3 = 'valid' THEN now() END WHERE id = $1 AND revision = $2 AND state = 'validating' RETURNING id`,
        [cfg.id, cfg.revision, error ? 'invalid' : 'valid', error])
      if (r.rows[0]) await tx.query(
        `INSERT INTO test_runs (workspace_id, type, ai_config_id, ai_config_revision, mode, status, results, authorized_by, cost_ceiling_minor, currency)
         VALUES (app_workspace_id(), 'ai_config', $1, $2, 'live', $3, $4, $5, 0, 'USD')`,
        [cfg.id, cfg.revision, error ? 'failed' : 'passed', JSON.stringify({ checked: 'key and model metadata; nothing was generated or charged', error }), job.payload_ref.user_id])
    })
    return { state: error ? 'invalid' : 'valid' }
  },

  // Official route: asks the provider which number the saved credentials belong to.
  async verify_connection(d, job) {
    const c = await fenced(d, job, async (tx) =>
      (await tx.query<{ id: string; route: string; mode: string; number_id: string; authorized_number: string; ciphertext: Buffer | null }>(
        `SELECT n.id, n.route, n.mode, n.provider_account->>'phone_number_id' AS number_id, n.authorized_number, s.ciphertext
         FROM connections n LEFT JOIN secret_refs s ON s.id = n.secret_ref_id AND s.workspace_id = n.workspace_id AND s.revoked_at IS NULL
         WHERE n.id = $1 AND n.state = 'connecting'`, [job.payload_ref.connection_id])).rows[0])
    if (!c) return { state: 'skipped' }
    let display: string | null = null
    let error: string | null = null
    try {
      if (!d.messaging.identify || !c.ciphertext) throw new Error('credentials_missing')
      display = (await d.messaging.identify({
        route: c.route, mode: c.mode, connectionId: c.id, numberId: c.number_id,
        token: openSecret(d.masterKey, `${job.workspace_id}:whatsapp_token:${c.route}`, c.ciphertext),
      })).displayNumber.replace(/\D/g, '')
    } catch (e) {
      error = e instanceof Error && /^[a-z_]{3,40}$/.test(e.message) ? e.message : 'could_not_verify'
    }
    // Never accept a different number silently.
    if (display && display !== c.authorized_number) error = 'number_mismatch'
    return fenced(d, job, async (tx) => {
      if (!error) {
        try {
          await tx.query('SAVEPOINT link')
          await tx.query(
            `UPDATE connections SET state = 'connected', verified_number_id = $2, masked_number = $3, last_health = 'ready', last_health_at = now(), last_error = NULL, version = version + 1
             WHERE id = $1 AND state = 'connecting'`, [c.id, c.number_id, `••• ${display?.slice(-4)}`])
          return { state: 'connected' }
        } catch (e) {
          if ((e as { constraint?: string }).constraint !== 'one_connected_number') throw e
          await tx.query('ROLLBACK TO SAVEPOINT link')
          error = 'number_already_connected_elsewhere'
        }
      }
      await tx.query(`UPDATE connections SET state = 'needs_action', last_health = $2, last_error = $2, last_health_at = now(), version = version + 1 WHERE id = $1 AND state = 'connecting'`, [c.id, error])
      return { state: 'needs_action', error }
    })
  },
}

// ---------------------------------------------------------------- running jobs

/** Wait before attempt n+1: 2s, 4s, 8s… */
export const backoffSeconds = (attempts: number) => 2 ** attempts

/** Runs every job that is ready now. Called after enqueueing and by the worker loop. */
export async function drain(d: WorkerDeps, kinds: string[] | null = null, queue = 'default'): Promise<number> {
  let n = 0
  for (let job = await lease(d.worker, kinds, queue); job; job = await lease(d.worker, kinds, queue)) {
    n++
    const j = job
    const mine = `id = $1 AND lease_token = '${j.lease_token}' AND state = 'leased'`
    // Renew while the handler runs, so a long job is not mistaken for a dead worker.
    const beatLease = setInterval(() => {
      d.worker.query(`UPDATE jobs SET lease_until = now() + interval '${LEASE_SECONDS} seconds' WHERE ${mine}`, [j.id]).catch(() => {})
    }, (LEASE_SECONDS * 1000) / 3)
    const handler = handlers[j.kind]
    try {
      if (!handler) throw new Error('unknown job kind')
      if (j.attempts > j.max_attempts) throw new GiveUp('attempts exhausted')
      const result = await handler(d, j)
      // A finished job keeps no customer text, name or number; the message itself lives in `messages`.
      await d.worker.query(`UPDATE jobs SET state = 'complete', lease_until = NULL, result = $2, payload_ref = payload_ref - '{text,message,name,from}'::text[] WHERE ${mine}`, [j.id, JSON.stringify(result)])
    } catch (e) {
      if (e instanceof LeaseLost) {
        console.error(`job ${j.id} ${j.kind}: lease lost to another worker; this worker changed nothing further`)
      } else if (e instanceof Defer) {
        await d.worker.query(`UPDATE jobs SET state = 'retry_wait', lease_until = NULL, attempts = attempts - 1, available_at = now() + interval '1 second' WHERE ${mine}`, [j.id])
      } else {
        const dead = e instanceof GiveUp || j.attempts >= j.max_attempts
        const wait = e instanceof RetryAfter ? e.seconds : backoffSeconds(j.attempts)
        console.error(`job ${j.id} ${j.kind} failed:`, e instanceof Error ? e.message : 'unknown') // safe summary only
        const r = await d.worker.query(
          `UPDATE jobs SET state = $2, lease_until = NULL, error_code = $3, available_at = now() + ($4 || ' seconds')::interval,
                  payload_ref = CASE WHEN $2 = 'dead_letter' THEN payload_ref - '{text,message,name,from}'::text[] ELSE payload_ref END WHERE ${mine} RETURNING id`,
          [j.id, dead ? 'dead_letter' : 'retry_wait', e instanceof RetryAfter ? 'provider_rate_limited' : e instanceof GiveUp ? 'gave_up' : 'handler_error', String(wait)],
        )
        if (r.rows[0] && dead && j.kind === 'generate_reply')
          await giveUp(d, j, e instanceof GiveUp && e.message !== 'attempts exhausted' ? e.message : 'The assistant could not reply').catch((x) => console.error(`job ${j.id} could not be handed to staff:`, x instanceof Error ? x.message : 'unknown'))
      }
    } finally {
      clearInterval(beatLease)
    }
  }
  return n
}

/** A reply that could not be generated: free its budget and give the customer to staff. */
async function giveUp(d: WorkerDeps, job: Job, reason: string) {
  const conversationId = String(job.payload_ref.conversation_id)
  await withTenant(d.worker, job.workspace_id, async (tx) => {
    const held = (await tx.query<{ held: number }>(`SELECT COALESCE((result->>'reserved')::float8, 0) AS held FROM jobs WHERE id = $1 FOR UPDATE`, [job.id])).rows[0]?.held
    if (held) await letGo(tx, job.id, held)
    if ((await control(tx, conversationId)).mode === 'bot') await requestHandoff(tx, conversationId, reason)
  })
}

/** Lets operators see that a worker is alive. */
export const beat = (worker: Db, name: string) =>
  worker.query('INSERT INTO worker_heartbeats (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET seen_at = now()', [name])

/** The worker process loop: run what is ready, otherwise wait briefly. Stops after the current job. */
export async function runWorker(d: WorkerDeps, o: { name: string; signal: AbortSignal; idleMs?: number; queue?: string }) {
  let purged = 0
  while (!o.signal.aborted) {
    let ran = 0
    try {
      await beat(d.worker, o.name)
      ran = await drain(d, null, o.queue ?? 'default')
      // Retention runs hourly from the main worker; it only touches workspaces that set a period.
      if (!o.queue && Date.now() - purged > 3600_000) {
        purged = Date.now()
        await d.worker.query('SELECT purge_expired_data()')
      }
    } catch (e) {
      console.error('worker:', e instanceof Error ? e.message : 'unknown') // e.g. database restarting; keep going
    }
    if (!ran) await sleep(o.idleMs ?? 250, undefined, { signal: o.signal }).catch(() => {})
  }
}
