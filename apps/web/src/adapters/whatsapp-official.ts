// Official WhatsApp Cloud API adapter. Request and webhook shapes follow Meta's documentation as
// read on 2026-11-13 (Graph API webhooks "getting started", Cloud API "send messages", webhook
// "components", phone-number reference, pricing). The Graph version and host come from config.
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { InboundEvent, Messaging } from '../worker.ts'

export interface OfficialConfig {
  /** e.g. https://graph.facebook.com */
  graphBase: string
  /** e.g. v27.0 */
  graphVersion: string
}

const call = async (c: OfficialConfig, path: string, token: string | null, init: RequestInit = {}) => {
  if (!token) throw new Error('credentials_missing')
  return fetch(`${c.graphBase}/${c.graphVersion}/${path}`, { ...init, redirect: 'error', headers: { ...init.headers, Authorization: `Bearer ${token}` } })
}
/** Meta's numeric error code only; never the message, which can echo request content. */
const code = async (res: Response) => {
  const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null
  return typeof body?.error?.code === 'number' ? `meta_error_${body.error.code}` : `http_${res.status}`
}

export const officialMessaging = (c: OfficialConfig): Messaging => ({
  async send({ text, target, signal }) {
    const res = await call(c, `${encodeURIComponent(target.numberId)}/messages`, target.token, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: target.to, type: 'text', text: { preview_url: false, body: text } }),
    })
    // A 5xx does not say whether the message was taken: throwing leaves the send `uncertain`.
    if (res.status >= 500) throw new Error('provider_unavailable')
    if (!res.ok) return { state: 'failed', errorCode: await code(res) }
    const body = (await res.json().catch(() => null)) as { messages?: { id?: unknown }[] } | null
    const id = body?.messages?.[0]?.id
    // Accepted by the API is not delivered; delivery arrives later as a status webhook.
    if (typeof id !== 'string') throw new Error('unreadable_provider_answer')
    return { state: 'accepted', providerMessageId: id }
  },

  async identify(target) {
    let res: Response
    try {
      res = await call(c, encodeURIComponent(target.numberId), target.token, { signal: AbortSignal.timeout(15_000) })
    } catch (e) {
      throw new Error(e instanceof Error && e.message === 'credentials_missing' ? e.message : 'provider_unreachable')
    }
    if (res.status === 401 || res.status === 403) throw new Error('credentials_rejected')
    if (!res.ok) throw new Error(res.status === 404 || res.status === 400 ? 'phone_number_id_not_found' : 'provider_unavailable')
    const body = (await res.json().catch(() => null)) as { display_phone_number?: unknown } | null
    if (typeof body?.display_phone_number !== 'string') throw new Error('unreadable_provider_answer')
    return { displayNumber: body.display_phone_number }
  },
})

// ---------------------------------------------------------------- webhooks

/** `X-Hub-Signature-256: sha256=<hex>` over the raw request body, keyed with the app secret. */
export function validSignature(appSecret: string, raw: Buffer, header: string | undefined): boolean {
  if (!appSecret || !header?.startsWith('sha256=')) return false
  const given = Buffer.from(header.slice(7), 'hex')
  const want = createHmac('sha256', appSecret).update(raw).digest()
  return given.length === want.length && timingSafeEqual(given, want)
}

export interface Receipt {
  numberId: string
  providerMessageId: string
  status: string
  billable: boolean | null
  category: string | null
  error: string | null
}
const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** Turns one verified webhook body into our own events. Anything unrecognised is dropped, not guessed at. */
export function parseWebhook(body: unknown): { inbound: InboundEvent[]; receipts: Receipt[] } {
  const inbound: InboundEvent[] = []
  const receipts: Receipt[] = []
  const root = rec(body)
  if (root.object !== 'whatsapp_business_account') return { inbound, receipts }
  for (const entry of list(root.entry)) for (const change of list(rec(entry).changes)) {
    if (rec(change).field !== 'messages') continue
    const value = rec(rec(change).value)
    const numberId = str(rec(value.metadata).phone_number_id)
    if (!numberId) continue
    const names = new Map(list(value.contacts).map((k) => [str(rec(k).wa_id), str(rec(rec(k).profile).name)]))
    for (const m of list(value.messages)) {
      const msg = rec(m)
      const from = str(msg.from)
      const id = str(msg.id)
      // A sender without a phone number cannot be replied to through this adapter yet.
      if (!from || !id) continue
      inbound.push({ route: 'official_cloud_api', numberId, eventKey: id, from, name: names.get(from)?.slice(0, 80) ?? null, text: msg.type === 'text' ? (str(rec(msg.text).body)?.slice(0, 4000) ?? null) : null })
    }
    for (const s of list(value.statuses)) {
      const st = rec(s)
      const id = str(st.id)
      const status = str(st.status)
      if (!id || !status) continue
      const pricing = rec(st.pricing)
      const err = rec(list(st.errors)[0]).code
      receipts.push({
        numberId, providerMessageId: id, status,
        billable: typeof pricing.billable === 'boolean' ? pricing.billable : null, category: str(pricing.category),
        error: typeof err === 'number' ? `meta_error_${err}` : null,
      })
    }
  }
  return { inbound, receipts }
}
