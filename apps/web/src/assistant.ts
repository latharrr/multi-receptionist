// Assistant settings (versioned behaviour) and enquiry capture.
import { audit, type Tx } from '@lathar/database'
import { AppError, invalid } from './http.ts'

export const ENQUIRY_FIELDS = { name: 'Name', email: 'Email address' } as const
export type EnquiryField = keyof typeof ENQUIRY_FIELDS

export interface Behavior {
  sequence: number // 0 = built-in defaults, nothing published yet
  instructions: string
  handoff_message: string
  enquiry_fields: EnquiryField[]
}
// Staff notices are only simulated, so the default must not claim anyone was told.
export const DEFAULTS: Behavior = { sequence: 0, instructions: '', handoff_message: 'I don’t have that information. A member of staff will need to answer this.', enquiry_fields: ['name'] }

interface Row {
  sequence: number
  instructions: string
  allowed: { enquiry_fields?: EnquiryField[] }
  handoff_policy: { message?: string }
}
const shape = (r: Row): Behavior => ({ sequence: r.sequence, instructions: r.instructions, handoff_message: r.handoff_policy.message ?? DEFAULTS.handoff_message, enquiry_fields: r.allowed.enquiry_fields ?? [] })
const load = async (tx: Tx, status: string) => (await tx.query<Row>('SELECT sequence, instructions, allowed, handoff_policy FROM behavior_versions WHERE status = $1', [status])).rows[0]

/** What replies use: the published version, or the defaults. Never the draft. */
export const publishedBehavior = async (tx: Tx): Promise<Behavior> => {
  const r = await load(tx, 'published')
  return r ? shape(r) : DEFAULTS
}
export async function getBehavior(tx: Tx) {
  const draft = await load(tx, 'draft')
  const live = await publishedBehavior(tx)
  return { published: live, draft: draft ? shape(draft) : null }
}

export async function saveBehaviorDraft(tx: Tx, body: Record<string, unknown>) {
  const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : ''
  const message = typeof body.handoff_message === 'string' ? body.handoff_message.trim() : ''
  if (instructions.length > 2000) throw invalid('instructions', 'Keep this under 2000 characters.')
  if (!message || message.length > 300) throw invalid('handoff_message', 'Write a short message, up to 300 characters.')
  // A promise that staff were told would be false while notices are only simulated.
  if (/\b(notified|have told|has been told|alerted)\b/i.test(message)) throw invalid('handoff_message', 'Don’t say staff have been notified. Staff notices are only simulated in this prototype, so that would not be true.')
  const fields = (Object.keys(ENQUIRY_FIELDS) as EnquiryField[]).filter((f) => body[`field_${f}`] === 'on' || body[`field_${f}`] === true)
  await tx.query(
    `INSERT INTO behavior_versions (workspace_id, sequence, instructions, allowed, handoff_policy)
     VALUES (app_workspace_id(), (SELECT COALESCE(max(sequence), 0) + 1 FROM behavior_versions), $1, $2, $3)
     ON CONFLICT (workspace_id) WHERE status = 'draft'
     DO UPDATE SET instructions = EXCLUDED.instructions, allowed = EXCLUDED.allowed, handoff_policy = EXCLUDED.handoff_policy`,
    [instructions, JSON.stringify({ enquiry_fields: fields }), JSON.stringify({ message })],
  )
  return getBehavior(tx)
}

export async function publishBehavior(tx: Tx, userId: string) {
  if (!(await load(tx, 'draft'))) throw new AppError(409, 'NO_CHANGES', 'Save your changes first; there is no draft to publish.')
  await tx.query(`UPDATE behavior_versions SET status = 'superseded' WHERE status = 'published'`)
  const v = await tx.query<{ id: string }>(`UPDATE behavior_versions SET status = 'published', approved_by = $1, approved_at = now() WHERE status = 'draft' RETURNING id`, [userId])
  // Replies being generated under the old settings must not be sent after this.
  await tx.query('UPDATE workspaces SET lock_version = lock_version + 1 WHERE id = app_workspace_id()')
  await audit(tx, 'behavior.publish', { behavior_version_id: v.rows[0]?.id ?? '' })
  return getBehavior(tx)
}

// ---------------------------------------------------------------- enquiries

/** MOCK extraction by fixed patterns. Only fields the published settings allow are kept. */
export function extractEnquiry(text: string, allowed: EnquiryField[]) {
  const found: Partial<Record<EnquiryField, string>> = {}
  const name = /\b(?:[Mm]y name is|[Ii] am|[Ii]'m|[Tt]his is)\s+([A-Z][\p{L}'-]+(?:\s[A-Z][\p{L}'-]+)?)/u.exec(text)?.[1]
  const email = /[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}/i.exec(text)?.[0]
  if (name && allowed.includes('name')) found.name = name
  if (email && allowed.includes('email')) found.email = email
  return found
}

/** One open enquiry per conversation; later messages add fields, each with the message it came from. */
export async function captureEnquiry(tx: Tx, conversationId: string, messageId: string, text: string, allowed: EnquiryField[]) {
  const fields = { wants: text.slice(0, 300), ...extractEnquiry(text, allowed) }
  const provenance = Object.fromEntries(Object.keys(fields).map((k) => [k, messageId]))
  const open = await tx.query<{ id: string }>(`SELECT id FROM enquiries WHERE conversation_id = $1 AND status <> 'closed' FOR UPDATE`, [conversationId])
  if (open.rows[0]) {
    const { wants: _first, ...extra } = fields // keep the original request
    const { wants: _p, ...extraFrom } = provenance
    await tx.query('UPDATE enquiries SET fields = fields || $2, provenance = provenance || $3 WHERE id = $1', [open.rows[0].id, JSON.stringify(extra), JSON.stringify(extraFrom)])
  } else {
    await tx.query(`INSERT INTO enquiries (workspace_id, conversation_id, fields, provenance) VALUES (app_workspace_id(), $1, $2, $3)`, [conversationId, JSON.stringify(fields), JSON.stringify(provenance)])
  }
}

export interface Enquiry {
  id: string
  conversation_id: string
  fields: { wants: string; name?: string; email?: string }
  status: string
  number: string
  created_at: Date
}
export const listEnquiries = async (tx: Tx) =>
  (await tx.query<Enquiry>(
    `SELECT e.id, e.conversation_id, e.fields, e.status, e.created_at, right(k.provider_customer_id, 4) AS number
     FROM enquiries e JOIN conversations c ON c.id = e.conversation_id AND c.workspace_id = e.workspace_id
     JOIN contacts k ON k.id = c.contact_id AND k.workspace_id = c.workspace_id ORDER BY e.created_at DESC LIMIT 100`)).rows

export async function setEnquiryStatus(tx: Tx, id: string, status: unknown) {
  if (status !== 'new' && status !== 'open' && status !== 'closed') throw invalid('status', 'Choose a status.')
  const r = await tx.query('UPDATE enquiries SET status = $2 WHERE id = $1 RETURNING id', [id, status])
  if (!r.rows[0]) throw new AppError(404, 'NOT_FOUND', 'Not found.')
  await audit(tx, 'enquiry.status', { enquiry_id: id }) // a label change; nothing is sent to the customer
}
