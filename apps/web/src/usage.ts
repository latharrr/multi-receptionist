// Spending limit and usage. The limit is enforced by a database CHECK, so concurrent work
// can never reserve past it. All costs in this build are MOCK estimates; nothing is charged.
import { audit, type Tx, type WorkspaceContext } from '@lathar/database'
import { AppError, invalid } from './http.ts'

/** MOCK: a flat pretend cost per generated reply, in minor units, so limits can be exercised. */
export const MOCK_COST_MINOR = 1

export interface Limit {
  hard_limit_minor: number
  reserved_minor: number
  settled_minor: number
  currency: string
}
export const getLimit = async (tx: Tx): Promise<Limit | null> =>
  (await tx.query<Limit>('SELECT hard_limit_minor::int, reserved_minor::int, settled_minor::int, currency FROM budget_limits')).rows[0] ?? null

export async function setLimit(tx: Tx, w: WorkspaceContext, userId: string, body: Record<string, unknown>) {
  const amount = Number(body.amount)
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000) throw invalid('amount', 'Enter an amount in dollars, for example 20.')
  const minor = Math.round(amount * 100)
  const current = await getLimit(tx)
  // Lowering is a safe direction; setting or raising commits the owner's own money.
  if ((!current || minor > current.hard_limit_minor) && w.role !== 'owner') throw new AppError(403, 'FORBIDDEN', 'Only the workspace owner can set or raise the spending limit.')
  try {
    await tx.query(
      `INSERT INTO budget_limits (workspace_id, funding_source, provider, period, currency, hard_limit_minor, approved_by)
       VALUES (app_workspace_id(), 'byok', 'any', 'total', 'USD', $1, $2)
       ON CONFLICT (workspace_id) DO UPDATE SET hard_limit_minor = EXCLUDED.hard_limit_minor, approved_by = EXCLUDED.approved_by, approved_at = now()`,
      [minor, userId],
    )
  } catch (e) {
    if ((e as { constraint?: string }).constraint === 'budget_cap') throw invalid('amount', 'That is below what has already been used.')
    throw e
  }
  await audit(tx, 'limits.set')
  return getLimit(tx)
}

/** Atomic reservation before a generation. False means no limit is set or it would be exceeded. */
export async function reserve(tx: Tx, minor = MOCK_COST_MINOR): Promise<'ok' | 'no_spending_limit' | 'spending_limit_reached'> {
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
  const rows = (await tx.query<{ category: string; n: number; cost: number }>(
    `SELECT category, count(*)::int AS n, COALESCE(sum(cost_minor), 0)::int AS cost FROM usage_events GROUP BY category ORDER BY category`)).rows
  return { limit: await getLimit(tx), by_category: rows, all_estimates: true, source: 'mock' }
}
