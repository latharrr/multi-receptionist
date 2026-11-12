// Local prototype server. Binds to this machine only; refuses to run as production.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { connect, migrate } from '@lathar/database'
import { openPools, roleUrl } from '@lathar/database/testing'
import { mockAi } from './ai.ts'
import { createApp } from './app.ts'
import { createAuth } from './auth.ts'
import { drain, mockMessaging } from './worker.ts'

if (process.env.NODE_ENV === 'production') throw new Error('This prototype uses mock adapters and a development mailbox. It must not be deployed.')

const dataDir = process.env.DATA_DIR ?? join(import.meta.dirname, '../../../.data')
mkdirSync(join(dataDir, 'uploads'), { recursive: true, mode: 0o700 })
// Keys live in files beside, not inside, the database (spec §3).
const keyFile = (name: string) => {
  const file = join(dataDir, name)
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 })
  return readFileSync(file, 'utf8')
}

// Development database on the local PostgreSQL container (infra/docker-compose.yml).
const database = process.env.DATABASE_NAME ?? 'receptionist_dev'
const root = connect(roleUrl('admin', 'postgres'), 1)
if (!(await root.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rows[0]) await root.query(`CREATE DATABASE ${database}`)
await root.end()
const pools = await openPools(database)
await migrate(pools.admin)
await pools.admin.end() // the running app keeps no owner connection

const port = Number(process.env.PORT ?? 3000)
const baseUrl = `http://127.0.0.1:${port}`
const auth = await createAuth({
  authDatabaseUrl: roleUrl('app_auth', database),
  secret: keyFile('auth.secret'),
  baseUrl,
  sendLink: async (email, url) => void (await pools.web.query('INSERT INTO local_mail (to_email, subject, body) VALUES ($1, $2, $3)', [email, 'Your sign-in link', url])),
})
const deps = { db: pools.web, worker: pools.worker, callback: pools.callback, auth, masterKey: Buffer.from(keyFile('master.key'), 'base64'), storageDir: join(dataDir, 'uploads'), baseUrl, ai: mockAi, messaging: mockMessaging, localMailbox: true }

// Picks up retries and leases left by an earlier run.
setInterval(() => drain(deps).catch((e) => console.error('worker:', e instanceof Error ? e.message : 'unknown')), 2000).unref()
createServer(createApp(deps)).listen(port, '127.0.0.1', () => console.log(`Local prototype (mock WhatsApp, mock AI, local mailbox): ${baseUrl}`))
