// Spending limit and usage. The limit is enforced by a database CHECK, so concurrent work
// can never reserve past it. All costs in this build are SYNTHETIC; nothing is charged.
import { audit, type Tx, type WorkspaceContext } from '@lathar/database'
import { AppError, invalid } from './http.ts'

/** SYNTHETIC: a made-up flat cost per generated reply, in minor units, so limits can be exercised. Not a price. */
export const MOCK_COST_MINOR = 1

export interface Limit {
  hard_limit_minor: number
  reserved_minor: number
  settled_minor: number
  currency: string
  period: 'month'
  period_start: string // YYYY-MM-DD, first day of the month being counted
  resets_on: string
}

/**
 * Starts a new count when the calendar month has changed in the workspace's timezone. Runs before
 * every read and reservation, so no scheduler is needed. Replies still in progress keep their
 * reservation; earlier months stay in usage_events.
 */
const rollover = (tx: Tx) =>
  tx.query(
    `UPDATE budget_limits b SET settled_minor = 0, period_start = m.start
     FROM (SELECT date_trunc('month', now() AT TIME ZONE timezone)::date AS start FROM workspaces WHERE id = app_workspace_id()) m
     WHERE b.period = 'month' AND b.period_start < m.start`)

export const getLimit = async (tx: Tx): Promise<Limit | null> => {
  await rollover(tx)
  return (await tx.query<Limit>(
    `SELECT hard_limit_minor::int, reserved_minor::int, settled_minor::int, currency, period,
            period_start::text, (period_start + interval '1 month')::date::text AS resets_on FROM budget_limits`)).rows[0] ?? null
}

export async function setLimit(tx: Tx, w: WorkspaceContext, userId: string, body: Record<string, unknown>) {
  const amount = Number(body.amount)
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000) throw invalid('amount', 'Enter an amount in dollars, for example 20.')
  const minor = Math.round(amount * 100)
  // It is the owner's money: no other role changes it in either direction, for now.
  if (w.role !== 'owner') throw new AppError(403, 'FORBIDDEN', 'Only the workspace owner can change the spending limit.')
  await rollover(tx)
  try {
    await tx.query(
      `INSERT INTO budget_limits (workspace_id, funding_source, provider, period, currency, hard_limit_minor, approved_by)
       VALUES (app_workspace_id(), 'byok', 'any', 'month', 'USD', $1, $2)
       ON CONFLICT (workspace_id) DO UPDATE SET hard_limit_minor = EXCLUDED.hard_limit_minor, approved_by = EXCLUDED.approved_by, approved_at = now()`,
      [minor, userId],
    )
  } catch (e) {
    if ((e as { constraint?: string }).constraint === 'budget_cap') throw invalid('amount', 'That is below what has already been used this month.')
    throw e
  }
  await audit(tx, 'limits.set')
  return getLimit(tx)
}

/** Atomic reservation before a generation. False means no limit is set or it would be exceeded. */
export async function reserve(tx: Tx, minor = MOCK_COST_MINOR): Promise<'ok' | 'no_spending_limit' | 'spending_limit_reached'> {
  await rollover(tx)
  await tx.query('SAVEPOINT reserve')
  try {
    const r = await tx.query('UPDATE budget_limits SET reserved_minor = reserved_minor + $1 RETURNING id', [minor])
    return r.rows[0] ? 'ok' : 'no_spending_limit'
  } catch (e) {
    if ((e as { constraint?: string }).constraint !== 'budget_cap') throw e
    await tx.query('ROLLBACK TO SAVEPOINT reserve')
    return 'spending_limit_reached'
  }
}
export const release = (tx: Tx, minor = MOCK_COST_MINOR) => tx.query('UPDATE budget_limits SET reserved_minor = greatest(reserved_minor - $1, 0)', [minor])

/** Turns a reservation into recorded usage. The attribution key makes a re-run a no-op. */
export async function settle(tx: Tx, category: string, attributionKey: string, minor = MOCK_COST_MINOR) {
  const u = await tx.query(
    `INSERT INTO usage_events (workspace_id, provider, category, quantities, cost_minor, currency, is_estimate, attribution_key)
     VALUES (app_workspace_id(), 'mock', $1, '{"requests":1}', $2, 'USD', true, $3)
     ON CONFLICT (workspace_id, attribution_key) DO NOTHING RETURNING id`,
    [category, minor, attributionKey],
  )
  await tx.query(
    u.rows[0] ? 'UPDATE budget_limits SET reserved_minor = greatest(reserved_minor - $1, 0), settled_minor = settled_minor + $1' : 'UPDATE budget_limits SET reserved_minor = greatest(reserved_minor - $1, 0)',
    [minor],
  )
}

export async function usageSummary(tx: Tx) {
  const limit = await getLimit(tx)
  // This month only, matching the limit. Earlier months stay stored but are not shown yet.
  const rows = (await tx.query<{ category: string; n: number; cost: number }>(
    `SELECT category, count(*)::int AS n, COALESCE(sum(cost_minor), 0)::int AS cost FROM usage_events
     WHERE measured_at >= (SELECT b.period_start::timestamp AT TIME ZONE w.timezone FROM budget_limits b JOIN workspaces w ON w.id = b.workspace_id)
     GROUP BY category ORDER BY category`)).rows
  return { limit, by_category: rows, all_estimates: true, source: 'mock', synthetic_cost_minor: MOCK_COST_MINOR }
}
