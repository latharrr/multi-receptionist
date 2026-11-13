// Conversation screens and staff controls. Sending itself happens in worker.ts.
import { canTransition } from '@lathar/contracts'
import { audit, type Tx } from '@lathar/database'
import { AppError, invalid, str } from './http.ts'
import { enqueue, sendQueue } from './worker.ts'

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
  /** A reply the assistant wrote that is waiting for a person to approve it. */
  has_draft: boolean
}

export async function listConversations(tx: Tx, id?: string): Promise<ConversationRow[]> {
  return (
    await tx.query<ConversationRow>(
      `SELECT c.id, c.mode, k.name, right(k.provider_customer_id, 4) AS number, k.provider_customer_id AS full_number, c.connection_id, c.last_message_at,
              COALESCE(c.assigned_user_id = app_user_id(), false) AS assigned_to_me,
              (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id LIMIT 1) AS preview,
              h.reason AS handoff_reason, h.notice_state,
              EXISTS (SELECT 1 FROM messages d WHERE d.conversation_id = c.id AND d.state = 'draft') AS has_draft,
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
  const c = (await tx.query<{ mode: string; connection_id: string; control_version: number; state: string; route: string; conn_mode: string }>(
    `SELECT c.mode, c.connection_id, c.control_version, n.state, n.route, n.mode AS conn_mode FROM conversations c JOIN connections n ON n.id = c.connection_id AND n.workspace_id = c.workspace_id
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
  await enqueue(tx, 'submit_message', sendKey, { message_id: messageId, control_version: c.control_version }, sendQueue(c.route, c.conn_mode))
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

// ---------------------------------------------------------------- supervised drafts

/**
 * A member of staff approves the assistant's draft, optionally after editing it. Only then does
 * a send intent exist. A draft overtaken by a newer customer message can no longer be approved.
 */
export async function approveDraft(tx: Tx, userId: string, conversationId: string, messageId: string, body: Record<string, unknown>) {
  const c = (await tx.query<{ mode: string; connection_id: string; state: string; route: string; conn_mode: string }>(
    `SELECT c.mode, c.connection_id, n.state, n.route, n.mode AS conn_mode FROM conversations c JOIN connections n ON n.id = c.connection_id AND n.workspace_id = c.workspace_id
     WHERE c.id = $1 FOR UPDATE OF c`, [conversationId])).rows[0]
  if (!c) throw new AppError(404, 'NOT_FOUND', 'Not found.')
  const draft = (await tx.query<{ body: string; outdated: boolean }>(
    `SELECT m.body, EXISTS (SELECT 1 FROM messages n WHERE n.conversation_id = m.conversation_id AND n.direction = 'inbound' AND (n.created_at, n.id) > (m.created_at, m.id)) AS outdated
     FROM messages m WHERE m.id = $2 AND m.conversation_id = $1 AND m.state = 'draft' FOR UPDATE`, [conversationId, messageId])).rows[0]
  if (!draft) throw new AppError(409, 'DRAFT_GONE', 'That draft is no longer waiting. It was already sent, discarded or replaced.')
  // The worker discards the draft when it processes the newer message; this covers the moment before it has.
  if (draft.outdated) throw new AppError(409, 'DRAFT_OUTDATED', 'The customer has written again since this draft. It cannot be sent; a new draft will follow.')
  if (c.state !== 'connected') throw new AppError(409, 'CONNECTION_NOT_READY', 'WhatsApp is not connected, so this cannot be sent.')
  if (!canTransition('conversation', c.mode, 'bot') && c.mode !== 'bot') throw new AppError(409, 'INVALID_STATE', 'A teammate has taken over this conversation. Reply there instead.')
  const edited = typeof body.text === 'string' && body.text.trim() ? str(body, 'text', 2000) : draft.body
  const v = await tx.query<{ control_version: number }>(`UPDATE conversations SET mode = 'bot', assigned_user_id = NULL, control_version = control_version + 1, last_message_at = now() WHERE id = $1 RETURNING control_version`, [conversationId])
  await tx.query(`UPDATE handoffs SET acknowledged_at = COALESCE(acknowledged_at, now()), assignee_user_id = $2, resolved_at = now(), resolution = 'draft_approved' WHERE conversation_id = $1 AND resolved_at IS NULL`, [conversationId, userId])
  await tx.query(`UPDATE messages SET state = 'reserved', body = $2, approved_by = $3 WHERE id = $1`, [messageId, edited, userId])
  const sendKey = `draft:${messageId}`
  await tx.query(`INSERT INTO delivery_attempts (workspace_id, message_id, logical_send_key) VALUES (app_workspace_id(), $1, $2)`, [messageId, sendKey])
  await enqueue(tx, 'submit_message', sendKey, { message_id: messageId, control_version: v.rows[0]?.control_version ?? 0, approved: true }, sendQueue(c.route, c.conn_mode))
  await audit(tx, edited === draft.body ? 'draft.approve' : 'draft.approve_edited', { conversation_id: conversationId, message_id: messageId })
  return { message_id: messageId, send_key: sendKey }
}

/** Rejects the draft and puts the member of staff in charge of the chat. Nothing is sent. */
export async function discardDraft(tx: Tx, userId: string, conversationId: string, messageId: string) {
  const r = await tx.query(`UPDATE messages SET state = 'discarded' WHERE id = $2 AND conversation_id = $1 AND state = 'draft' RETURNING id`, [conversationId, messageId])
  if (!r.rows[0]) throw new AppError(409, 'DRAFT_GONE', 'That draft is no longer waiting.')
  await audit(tx, 'draft.discard', { conversation_id: conversationId, message_id: messageId })
  await takeover(tx, userId, conversationId)
}

// ---------------------------------------------------------------- deleting a customer's data

/**
 * Removes one customer's conversation, messages, enquiries and contact record on request.
 * Backups keep it until they expire; the audit entry holds counts only.
 */
export async function deleteCustomer(tx: Tx, conversationId: string) {
  const c = (await tx.query<{ contact_id: string }>('SELECT contact_id FROM conversations WHERE id = $1 FOR UPDATE', [conversationId])).rows[0]
  if (!c) throw new AppError(404, 'NOT_FOUND', 'Not found.')
  await tx.query('DELETE FROM notifications WHERE handoff_id IN (SELECT id FROM handoffs WHERE conversation_id = $1)', [conversationId])
  await tx.query('DELETE FROM handoffs WHERE conversation_id = $1', [conversationId])
  await tx.query('DELETE FROM enquiries WHERE conversation_id = $1', [conversationId])
  await tx.query('DELETE FROM reply_runs WHERE conversation_id = $1', [conversationId])
  await tx.query('DELETE FROM delivery_attempts WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = $1)', [conversationId])
  const m = await tx.query('DELETE FROM messages WHERE conversation_id = $1 RETURNING id', [conversationId])
  // Work still queued for this chat must not bring any of it back.
  await tx.query(`DELETE FROM jobs WHERE payload_ref->>'conversation_id' = $1 AND state IN ('queued', 'retry_wait')`, [conversationId])
  await tx.query(`UPDATE jobs SET payload_ref = payload_ref - '{text,message,name,from}'::text[] WHERE payload_ref->>'conversation_id' = $1`, [conversationId])
  await tx.query('DELETE FROM conversations WHERE id = $1', [conversationId])
  await tx.query('DELETE FROM contacts WHERE id = $1', [c.contact_id])
  await tx.query(`INSERT INTO audit_events (workspace_id, actor_user_id, action, target, metadata) VALUES (app_workspace_id(), app_user_id(), 'customer.delete', '{}', $1)`, [JSON.stringify({ messages: m.rows.length })])
  return { deleted: true, messages: m.rows.length }
}

// ---------------------------------------------------------------- workspace settings

export async function getSettings(tx: Tx) {
  const w = (await tx.query<{ id: string; reply_mode: string; retention_days: number | null; state: string; live_allowed: boolean }>(
    'SELECT id, reply_mode, retention_days, state, live_allowed_at IS NOT NULL AS live_allowed FROM workspaces WHERE id = app_workspace_id()')).rows[0]
  if (!w) throw new AppError(404, 'NOT_FOUND', 'Not found.')
  return w
}
export async function saveSettings(tx: Tx, allowAutonomous: boolean, body: Record<string, unknown>) {
  if (body.reply_mode !== undefined) {
    if (body.reply_mode !== 'supervised' && body.reply_mode !== 'autonomous') throw invalid('reply_mode', 'Choose how replies are sent.')
    // Sending without a person's approval stays off until its safety gates have been passed.
    if (body.reply_mode === 'autonomous' && !allowAutonomous) throw new AppError(409, 'AUTONOMOUS_NOT_AVAILABLE', 'Sending replies without staff approval is not available yet. Every reply is approved by a person first.')
    await tx.query('UPDATE workspaces SET reply_mode = $1, lock_version = lock_version + 1 WHERE id = app_workspace_id()', [body.reply_mode])
  }
  if (body.retention_days !== undefined) {
    const days = Number(body.retention_days)
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw invalid('retention_days', 'Enter a whole number of days between 1 and 3650.')
    await tx.query('UPDATE workspaces SET retention_days = $1 WHERE id = app_workspace_id()', [days])
  }
  await audit(tx, 'workspace.settings')
  return getSettings(tx)
}
