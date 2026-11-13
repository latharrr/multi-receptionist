// Test and local-development helper: a fresh, migrated database on the local PostgreSQL
// container, with one pool per restricted role. Never used by the running app.
import { randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { connect, migrate, type Db } from './index.ts'

const ADMIN = process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:dev@127.0.0.1:54329/postgres'
export const roleUrl = (role: string, database: string) => {
  const u = new URL(ADMIN)
  if (role !== 'admin') u.username = role
  u.pathname = `/${database}`
  return u.href
}

export interface Pools {
  name: string
  admin: Db
  web: Db
  worker: Db
  callback: Db
  operator: Db
  drop(): Promise<void>
}

export async function openPools(name: string): Promise<Omit<Pools, 'drop'>> {
  return { name, admin: connect(roleUrl('admin', name), 2), web: connect(roleUrl('app_user', name)), worker: connect(roleUrl('app_worker', name)), callback: connect(roleUrl('app_callback', name), 2), operator: connect(roleUrl('app_operator', name), 1) }
}

export async function createTestDatabase(): Promise<Pools> {
  const name = `test_${randomBytes(6).toString('hex')}`
  const root = connect(ADMIN, 1)
  try {
    await root.query(`CREATE DATABASE ${name}`)
  } catch (e) {
    throw new Error(`PostgreSQL is not reachable. Start it with: pnpm db (${e instanceof Error ? e.message : e})`)
  }
  const pools = await openPools(name)
  await migrate(pools.admin)
  return {
    ...pools,
    async drop() {
      await Promise.all([pools.admin.end(), pools.web.end(), pools.worker.end(), pools.callback.end(), pools.operator.end()])
      // pool.end() resolves before its sockets have closed. Dropping at once would kill those
      // sessions mid-close and surface as a stray "terminating connection" error after the tests.
      for (let i = 0; i < 100; i++) {
        const open = await root.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [name])
        if (!open.rows[0]?.n) break
        await sleep(20)
      }
      await root.query(`DROP DATABASE ${name} WITH (FORCE)`)
      await root.end()
    },
  }
}
