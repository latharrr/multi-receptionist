// Conversation screens and staff controls. Sending itself happens in worker.ts.
import { canTransition } from '@lathar/contracts'
import { audit, type Tx } from '@lathar/database'
import { AppError, invalid, str } from './http.ts'
import { enqueue } from './worker.ts'

export interface ConversationRow {
  id: string
  mode: string
  name: string | null
  number: string
  full_number: string
  connection_id: string
  last_message_at: Date
  preview: string | null
  handoff_reason: string | null
  /** Staff notice for the open handoff: pending, sent, failed or skipped. Delivery is simulated. */
  notice_state: string | null
  notified: number
  assigned_to_me: boolean
}

export async function listConversations(tx: Tx, id?: string): Promise<ConversationRow[]> {
  return (
    await tx.query<ConversationRow>(
      `SELECT c.id, c.mode, k.name, right(k.provider_customer_id, 4) AS number, k.provider_customer_id AS full_number, c.connection_id, c.last_message_at,
              COALESCE(c.assigned_user_id = app_user_id(), false) AS assigned_to_me,
              (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id LIMIT 1) AS preview,
              h.reason AS handoff_reason, h.notice_state,
              (SELECT count(*)::int FROM notifications n WHERE n.handoff_id = h.id AND n.state = 'sent') AS notified
       FROM conversations c
       LEFT JOIN LATERAL (SELECT id, reason, notice_state FROM handoffs h WHERE h.conversation_id = c.id AND h.resolved_at IS NULL ORDER BY h.requested_at DESC LIMIT 1) h ON true JOIN contacts k ON k.id = c.contact_id AND k.workspace_id = c.workspace_id
       WHERE $1::uuid IS NULL OR c.id = $1 ORDER BY c.last_message_at DESC LIMIT 100`,
      [id ?? null],
    )
  ).rows
}

export async function listMessages(tx: Tx, conversationId: string) {
  const [conversation] = await listConversations(tx, conversationId)
  if (!conversation) throw new AppError(404, 'NOT_FOUND', 'Not found.')
  const rows = (
    await tx.query<{ id: string; direction: string; sender: string; body: string; state: string; fact_path: string | null; error_code: string | null; created_at: Date }>(
      `SELECT m.id, m.direction, m.sender, m.body, m.state, m.fact_path, m.created_at,
              (SELECT error_code FROM delivery_attempts d WHERE d.message_id = m.id) AS error_code
       FROM messages m WHERE m.conversation_id = $1 ORDER BY m.created_at, m.id LIMIT 500`,
      [conversationId],
    )
  ).rows
  return { conversation, messages: rows }
}

async function setMode(tx: Tx, userId: string, id: string, to: 'human' | 'bot') {
  const c = (await tx.query<{ mode: string }>('SELECT mode FROM conversations WHERE id = $1 FOR UPDATE', [id])).rows[0]
  if (!c) throw new AppError(404, 'NOT_FOUND', 'Not found.')
  if (c.mode === to) return
  if (!canTransition('conversation', c.mode, to)) throw new AppError(409, 'INVALID_STATE', 'That is not available for this conversation right now.')
  // The version bump is what stops a reply that was already generated or queued.
  await tx.query('UPDATE conversations SET mode = $2, assigned_user_id = $3, control_version = control_version + 1 WHERE id = $1', [id, to, to === 'human' ? userId : null])
  if (to === 'human') await tx.query('UPDATE handoffs SET acknowledged_at = now(), assignee_user_id = $2 WHERE conversation_id = $1 AND acknowledged_at IS NULL', [id, userId])
  else await tx.query(`UPDATE handoffs SET resolved_at = now(), resolution = 'handed_back' WHERE conversation_id = $1 AND resolved_at IS NULL`, [id])
  await audit(tx, to === 'human' ? 'conversation.takeover' : 'conversation.resume', { conversation_id: id })
}
export const takeover = (tx: Tx, userId: string, id: string) => setMode(tx, userId, id, 'human')
export const resume = (tx: Tx, userId: string, id: string) => setMode(tx, userId, id, 'bot')

/** Records the staff message and its send intent. The worker submits it and re-checks takeover first. */
export async function staffReply(tx: Tx, id: string, body: unknown) {
  const text = str(body, 'text', 2000)
  const key = (body as Record<string, unknown>).idempotency_key
  if (typeof key !== 'string' || key.length < 8 || key.length > 100) throw invalid('idempotency_key', 'Missing request key.')
  const c = (await tx.query<{ mode: string; connection_id: string; control_version: number; state: string }>(
    `SELECT c.mode, c.connection_id, c.control_version, n.state FROM conversations c JOIN connections n ON n.id = c.connection_id AND n.workspace_id = c.workspace_id
     WHERE c.id = $1 FOR UPDATE OF c`, [id])).rows[0]
  if (!c) throw new AppError(404, 'NOT_FOUND', 'Not found.')
  if (c.mode !== 'human') throw new AppError(409, 'TAKEOVER_REQUIRED', 'Take over this conversation before replying, so the assistant and you never answer at once.')
  if (c.state !== 'connected') throw new AppError(409, 'CONNECTION_NOT_READY', 'WhatsApp is not connected, so this cannot be sent.')
  const sendKey = `staff:${id}:${key}`
  const sent = await tx.query<{ message_id: string }>('SELECT message_id FROM delivery_attempts WHERE logical_send_key = $1', [sendKey])
  if (sent.rows[0]) return { message_id: sent.rows[0].message_id, duplicate: true, send_key: sendKey }
  const m = await tx.query<{ id: string }>(
    `INSERT INTO messages (workspace_id, conversation_id, connection_id, direction, sender, body, state)
     VALUES (app_workspace_id(), $1, $2, 'outbound', 'staff', $3, 'reserved') RETURNING id`, [id, c.connection_id, text])
  const messageId = m.rows[0]?.id ?? ''
  await tx.query(`INSERT INTO delivery_attempts (workspace_id, message_id, logical_send_key) VALUES (app_workspace_id(), $1, $2)`, [messageId, sendKey])
  await enqueue(tx, 'submit_message', sendKey, { message_id: messageId, control_version: c.control_version })
  await tx.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [id])
  return { message_id: messageId, duplicate: false, send_key: sendKey }
}

/**
 * "Pause automation": no new automated reply is generated or sent. A message already submitted to
 * the provider may still arrive. Staff replies are not affected: they still need the reply
 * permission, a takeover of the conversation and a connected number (see staffReply and the worker).
 */
export async function setPaused(tx: Tx, paused: boolean) {
  await tx.query(`UPDATE workspaces SET replies_paused_at = ${paused ? 'COALESCE(replies_paused_at, now())' : 'NULL'}, lock_version = lock_version + 1 WHERE id = app_workspace_id()`)
  await audit(tx, paused ? 'workspace.pause' : 'workspace.resume_replies')
}
