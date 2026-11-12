import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { can, type Capability, type Role } from '@lathar/contracts'
import pg from 'pg'

export interface Tx {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
}
export interface Db extends Tx {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
  end(): Promise<void>
}

/** One pool per process role. The URL's user decides what the process can do, not the code. */
export function connect(url: string, max = 5): Db {
  const pool = new pg.Pool({ connectionString: url, max })
  // An idle connection dropped by the server must not take the process down.
  pool.on('error', (e) => console.error('database connection lost:', e.message))
  const wrap = (c: pg.Pool | pg.PoolClient): Tx => ({ query: (sql, params) => c.query(sql, params) as never })
  return {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await fn(wrap(client))
        await client.query('COMMIT')
        return result
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        client.release()
      }
    },
    end: () => pool.end(),
  }
}

/** First row or a thrown error; for queries that must return exactly what was just written. */
export function one<R>(result: { rows: R[] }): R {
  const row = result.rows[0]
  if (row === undefined) throw new Error('expected a row')
  return row
}

const MIGRATIONS = new URL('../migrations/', import.meta.url)

/** Run with the owning role, as its own deploy step. Serialised by an advisory lock. */
export async function migrate(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(7426001)')
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
    const applied = new Set((await tx.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name))
    for (const name of (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()) {
      if (applied.has(name)) continue
      await tx.query(await readFile(new URL(name, MIGRATIONS), 'utf8'))
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name])
    }
  })
}

export class AccessError extends Error {
  code: 'NOT_FOUND' | 'FORBIDDEN'
  constructor(code: 'NOT_FOUND' | 'FORBIDDEN') {
    super(code)
    this.code = code
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Pins tenant and user for this transaction only; row-level security does the rest. */
async function enter(tx: Tx, userId: string, workspaceId: string): Promise<void> {
  if ((userId && !UUID.test(userId)) || (workspaceId && !UUID.test(workspaceId))) throw new AccessError('NOT_FOUND')
  await tx.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true)`, [workspaceId, userId])
}

/** For the few queries that span a user's workspaces (list memberships). Tenant tables stay invisible. */
export function withUser<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await enter(tx, userId, '')
    return fn(tx)
  })
}

/**
 * For the worker and callback roles: no user, and the tenant comes from a server-owned record
 * (a leased job row or the connection mapping), never from a payload.
 */
export function withTenant<T>(db: Db, workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await enter(tx, '', workspaceId)
    return fn(tx)
  })
}

export interface WorkspaceContext {
  role: Role
  workspaceState: string
  can(capability: Capability): boolean
}

/**
 * Spec §4 request boundary, steps 2-5. `userId` must come from the authenticated session and
 * `workspaceId` from the route — never from a body, query, filename, model result or message.
 * A non-member gets NOT_FOUND so another tenant's existence is not revealed.
 */
export async function withWorkspace<T>(
  db: Db,
  auth: { userId: string; workspaceId: string; capability?: Capability },
  fn: (tx: Tx, ctx: WorkspaceContext) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await enter(tx, auth.userId, auth.workspaceId)
    const { rows } = await tx.query<{ role: Role; state: string; grants: string[] }>(
      `SELECT m.role, w.state,
              ARRAY(SELECT g.capability FROM permission_grants g
                    WHERE g.grantee_user_id = m.user_id AND g.revoked_at IS NULL
                      AND (g.expires_at IS NULL OR g.expires_at > now())) AS grants
       FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.workspace_id = app_workspace_id() AND m.user_id = app_user_id() AND m.status = 'active'`,
    )
    const m = rows[0]
    if (!m) throw new AccessError('NOT_FOUND')
    if (auth.capability && !can(m.role, m.grants, auth.capability)) throw new AccessError('FORBIDDEN')
    return fn(tx, { role: m.role, workspaceState: m.state, can: (c) => can(m.role, m.grants, c) })
  })
}

/** §4 step 6. Targets are IDs only; never pass bodies or secrets. */
export async function audit(tx: Tx, action: string, target: Record<string, string> = {}, outcome = 'ok') {
  await tx.query(
    `INSERT INTO audit_events (workspace_id, actor_user_id, action, target, outcome)
     VALUES (app_workspace_id(), app_user_id(), $1, $2, $3)`,
    [action, JSON.stringify(target), outcome],
  )
}

/** POST /workspaces: verified user creates the workspace and owner membership atomically. */
export async function createWorkspace(db: Db, userId: string, name: string): Promise<string> {
  const id = randomUUID()
  return db.transaction(async (tx) => {
    await enter(tx, userId, id)
    const { rows } = await tx.query(`SELECT 1 FROM users WHERE id = app_user_id() AND verified_at IS NOT NULL AND status = 'active'`)
    if (!rows[0]) throw new AccessError('FORBIDDEN')
    await tx.query('INSERT INTO workspaces (id, name, owner_user_id) VALUES ($1, $2, $3)', [id, name, userId])
    await tx.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, userId])
    await audit(tx, 'workspace.create')
    return id
  })
}
