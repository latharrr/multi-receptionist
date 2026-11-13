// The contract every AI provider adapter implements (spec §11), and the server-side checks on
// what a model returns. The model never chooses a recipient, a provider or a key, and nothing it
// writes is executed: its whole output is one of three fixed shapes.
import type { Knowledge } from '../knowledge.ts'
import type { Measured } from '../usage.ts'

export interface AiConfigRef {
  provider: string
  model: string
  endpoint: string | null
  /** Decrypted only inside the worker, for the duration of one call. Never logged. */
  apiKey: string | null
}
export interface Turn {
  from: 'customer' | 'business'
  text: string
}
export interface AiRequest {
  config: AiConfigRef
  businessName: string
  knowledge: Knowledge
  /** The owner's published instructions: tone and house rules. They cannot unlock facts or actions. */
  instructions: string
  /** Bounded recent history, oldest first. The last turn is the customer's newest message. */
  history: Turn[]
  message: string
}
export type Generated = (
  | { kind: 'answer'; text: string; factPath: string }
  | { kind: 'clarify'; text: string }
  | { kind: 'handoff'; reason: string }
) & { usage?: Measured }

export type AiErrorKind = 'auth' | 'rate_limit' | 'unavailable' | 'invalid' | 'refused' | 'unknown'
export class AiError extends Error {
  kind: AiErrorKind
  /** Seconds the provider asked us to wait, when it said. */
  retryAfter: number | null
  constructor(kind: AiErrorKind, message: string, retryAfter: number | null = null) {
    super(message) // a safe summary: never a key, a prompt or a raw provider body
    this.kind = kind
    this.retryAfter = retryAfter
  }
}

export interface AiAdapter {
  /** True when `generate` calls a real provider with the tenant's key and costs real money. */
  live?: boolean
  /** Upper bound, in micro-dollars, on what `generate` can cost. Reserved before the call. */
  bound?(req: AiRequest): number
  generate(req: AiRequest): Promise<Generated>
  /** Checks the key and model without generating anything billable. Throws AiError. */
  check?(config: AiConfigRef): Promise<void>
}

const numbers = (s: string) => s.match(/\d+(?:[.,:]\d+)*/g) ?? []

/**
 * What the model said is only sent if it stays inside the published facts:
 *  - an answer must name published facts, and every number in it must appear in those facts
 *    or in what the customer wrote (no invented prices, times, dates or quantities);
 *  - a clarifying question may not state any new number at all;
 *  - anything else becomes a handoff to staff.
 */
export function vet(g: Generated, req: AiRequest): Generated {
  if (g.kind === 'handoff') return g
  const fail = (reason: string): Generated => ({ kind: 'handoff', reason, usage: g.usage })
  const text = g.text.trim()
  if (!text || text.length > 1200) return fail('The assistant’s reply was empty or too long')
  const said = new Set(req.history.flatMap((t) => numbers(t.text)).concat(numbers(req.message)))
  if (g.kind === 'clarify') return numbers(text).every((n) => said.has(n)) ? { ...g, text } : fail('The assistant asked a question containing details that are not in your facts')
  const paths = g.factPath.split(',').map((p) => p.trim()).filter(Boolean)
  const facts = paths.map((p) => req.knowledge.facts.find((f) => f.path === p))
  if (!paths.length || facts.some((f) => !f)) return fail('The assistant’s reply was not based on a published fact')
  const allowed = new Set([...said, ...facts.flatMap((f) => numbers(`${f?.label} ${f?.text}`))])
  if (!numbers(text).every((n) => allowed.has(n))) return fail('The assistant’s reply contained a detail that is not in your published facts')
  return { ...g, text, factPath: paths.join(',') }
}
