// Spending limit and usage. The limit is enforced by database CHECKs, so concurrent work can
// never reserve past it. Money is held in micro-dollars (1 USD = 1,000,000): one AI reply
// costs a fraction of a cent.
import { audit, type Tx, type WorkspaceContext } from '@lathar/database'
import { AppError, invalid } from './http.ts'

/** SYNTHETIC: what the development mock "costs" per reply (1 cent), so limits can be exercised. Not a price. */
export const SYNTHETIC_COST_MICROS = 10_000

export interface Limit {
  hard_limit_micros: number
  reserved_micros: number
  settled_micros: number
  currency: string
  period: 'month'
  period_start: string // YYYY-MM-DD, first day of the month being counted
  resets_on: string
  /** Outbound WhatsApp messages allowed per month. Meta's per-message rates are not known here, so this is a count. */
  message_cap: number | null
  messages_used: number
}

/**
 * Starts a new count when the calendar month has changed in the workspace's timezone. Runs before
 * every read and reservation, so no scheduler is needed. Replies still in progress keep their
 * reservation; earlier months stay in usage_events.
 */
const rollover = (tx: Tx) =>
  tx.query(
    `UPDATE budget_limits b SET settled_micros = 0, messages_used = 0, period_start = m.start
     FROM (SELECT date_trunc('month', now() AT TIME ZONE timezone)::date AS start FROM workspaces WHERE id = app_workspace_id()) m
     WHERE b.period = 'month' AND b.period_start < m.start`)

export const getLimit = async (tx: Tx): Promise<Limit | null> => {
  await rollover(tx)
  return (await tx.query<Limit>(
    `SELECT hard_limit_micros::float8, reserved_micros::float8, settled_micros::float8, currency, period,
            period_start::text, (period_start + interval '1 month')::date::text AS resets_on, message_cap, messages_used FROM budget_limits`)).rows[0] ?? null
}

export async function setLimit(tx: Tx, w: WorkspaceContext, userId: string, body: Record<string, unknown>) {
  const amount = Number(body.amount)
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000) throw invalid('amount', 'Enter an amount in dollars, for example 20.')
  const cap = body.message_cap === undefined || body.message_cap === '' ? null : Number(body.message_cap)
  if (cap !== null && (!Number.isInteger(cap) || cap < 0 || cap > 1_000_000)) throw invalid('message_cap', 'Enter a whole number of messages, for example 500.')
  // It is the owner's money: no other role changes it in either direction, for now.
  if (w.role !== 'owner') throw new AppError(403, 'FORBIDDEN', 'Only the workspace owner can change the spending limit.')
  await rollover(tx)
  try {
    await tx.query(
      `INSERT INTO budget_limits (workspace_id, funding_source, provider, period, currency, hard_limit_micros, message_cap, approved_by)
       VALUES (app_workspace_id(), 'byok', 'any', 'month', 'USD', $1, $2, $3)
       ON CONFLICT (workspace_id) DO UPDATE SET hard_limit_micros = EXCLUDED.hard_limit_micros,
         message_cap = COALESCE(EXCLUDED.message_cap, budget_limits.message_cap), approved_by = EXCLUDED.approved_by, approved_at = now()`,
      [Math.round(amount * 1e6), cap, userId],
    )
  } catch (e) {
    const c = (e as { constraint?: string }).constraint
    if (c === 'budget_cap') throw invalid('amount', 'That is below what has already been used this month.')
    if (c === 'message_cap_check') throw invalid('message_cap', 'That is below the number of messages already sent this month.')
    throw e
  }
  await audit(tx, 'limits.set')
  return getLimit(tx)
}

/** Atomic reservation before a provider call. `micros` must be an upper bound on what the call can cost. */
export async function reserve(tx: Tx, micros = SYNTHETIC_COST_MICROS): Promise<'ok' | 'no_spending_limit' | 'spending_limit_reached'> {
  await rollover(tx)
  await tx.query('SAVEPOINT reserve')
  try {
    const r = await tx.query('UPDATE budget_limits SET reserved_micros = reserved_micros + $1 RETURNING id', [micros])
    return r.rows[0] ? 'ok' : 'no_spending_limit'
  } catch (e) {
    if ((e as { constraint?: string }).constraint !== 'budget_cap') throw e
    await tx.query('ROLLBACK TO SAVEPOINT reserve')
    return 'spending_limit_reached'
  }
}
export const release = (tx: Tx, micros = SYNTHETIC_COST_MICROS) => tx.query('UPDATE budget_limits SET reserved_micros = greatest(reserved_micros - $1, 0)', [micros])

export interface Measured {
  costMicros: number
  provider: string
  model: string | null
  /** Integer counts as the provider reported them (tokens), or {requests: 1} for the mock. */
  quantities: Record<string, number>
  /** How the cost figure was produced, shown next to it. */
  provenance: string
}
export const SYNTHETIC: Measured = { costMicros: SYNTHETIC_COST_MICROS, provider: 'mock', model: null, quantities: { requests: 1 }, provenance: 'synthetic' }

/** Turns a reservation into recorded usage. The attribution key makes a re-run a no-op. */
export async function settle(tx: Tx, category: string, attributionKey: string, reserved = SYNTHETIC_COST_MICROS, used: Measured = SYNTHETIC) {
  const u = await tx.query(
    `INSERT INTO usage_events (workspace_id, provider, model_id, category, quantities, cost_micros, currency, is_estimate, attribution_key, provenance)
     VALUES (app_workspace_id(), $1, $2, $3, $4, $5, 'USD', true, $6, $7)
     ON CONFLICT (workspace_id, attribution_key) DO NOTHING RETURNING id`,
    [used.provider, used.model, category, JSON.stringify(used.quantities), used.costMicros, attributionKey, used.provenance],
  )
  // The reservation was an upper bound, so the real cost always fits inside it.
  await tx.query(
    u.rows[0] ? 'UPDATE budget_limits SET reserved_micros = greatest(reserved_micros - $1, 0), settled_micros = settled_micros + least($2, $1)'
      : 'UPDATE budget_limits SET reserved_micros = greatest(reserved_micros - $1, 0)',
    u.rows[0] ? [reserved, used.costMicros] : [reserved],
  )
}

/** Counts one outbound message against the monthly cap, atomically. No limit row means no cap is enforced. */
export async function countMessage(tx: Tx): Promise<'ok' | 'message_cap_reached'> {
  await rollover(tx)
  await tx.query('SAVEPOINT message')
  try {
    await tx.query('UPDATE budget_limits SET messages_used = messages_used + 1')
    return 'ok'
  } catch (e) {
    if ((e as { constraint?: string }).constraint !== 'message_cap_check') throw e
    await tx.query('ROLLBACK TO SAVEPOINT message')
    return 'message_cap_reached'
  }
}

export async function usageSummary(tx: Tx) {
  const limit = await getLimit(tx)
  // This month only, matching the limit. Earlier months stay stored but are not shown yet.
  const rows = (await tx.query<{ category: string; provenance: string; n: number; cost: number | null; input_tokens: number; output_tokens: number; billable: number }>(
    `SELECT category, provenance, count(*)::int AS n, sum(cost_micros)::float8 AS cost,
            COALESCE(sum((quantities->>'input_tokens')::bigint), 0)::float8 AS input_tokens,
            COALESCE(sum((quantities->>'output_tokens')::bigint), 0)::float8 AS output_tokens,
            count(*) FILTER (WHERE quantities->>'billable' = 'true')::int AS billable
     FROM usage_events
     WHERE measured_at >= (SELECT b.period_start::timestamp AT TIME ZONE w.timezone FROM budget_limits b JOIN workspaces w ON w.id = b.workspace_id)
     GROUP BY category, provenance ORDER BY category, provenance`)).rows
  return { limit, by_category: rows }
}
