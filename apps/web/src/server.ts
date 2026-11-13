// Local prototype server. Binds to this machine only; refuses to run as production.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { connect, migrate } from '@lathar/database'
import { openPools, roleUrl } from '@lathar/database/testing'
import { mockAi } from './ai.ts'
import { createApp, type Deps } from './app.ts'
import { createAuth } from './auth.ts'
import { beat, drain, mailboxNotifier, mockMessaging } from './worker.ts'

if (process.env.NODE_ENV === 'production') throw new Error('This prototype uses mock adapters and a development mailbox. It must not be deployed.')

// The demo keeps its own database and its own folder for keys and uploads, so it never touches
// data from an earlier build (for example .data/pg) or another database on the same server.
const database = process.env.DATABASE_NAME ?? 'receptionist_demo'
const dataDir = process.env.DATA_DIR ?? join(import.meta.dirname, '../../../.data', database)
mkdirSync(join(dataDir, 'uploads'), { recursive: true, mode: 0o700 })
// Keys live in files beside, not inside, the database (spec §3).
const keyFile = (name: string) => {
  const file = join(dataDir, name)
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 })
  return readFileSync(file, 'utf8')
}

// Never takes a port from another process. Without PORT set, it moves to the next free one.
const listen = (port: number) =>
  new Promise<ReturnType<typeof createServer> | null>((resolve, reject) => {
    const s = createServer()
    s.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' ? resolve(null) : reject(e)))
    s.listen(port, '127.0.0.1', () => resolve(s))
  })
const wanted = Number(process.env.PORT ?? 3000)
let port = wanted
let server = await listen(port)
if (!server) {
  let holder = ''
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${wanted}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8' })
    holder = `process ${/^p(\d+)$/m.exec(out)?.[1] ?? '?'} (${/^c(.+)$/m.exec(out)?.[1] ?? 'unknown'})`
  } catch { /* lsof missing: the message just names the port */ }
  if (process.env.PORT) {
    console.error(`Port ${wanted} is already in use${holder && ` by ${holder}`}. It was left alone. Stop it yourself or choose another PORT.`)
    process.exit(1)
  }
  while (!server && port < wanted + 20) server = await listen(++port)
  if (!server) throw new Error(`No free port between ${wanted} and ${port}.`)
  console.log(`Port ${wanted} is already in use${holder && ` by ${holder}`}. It was left running; this server uses ${port} instead.`)
}

// Local PostgreSQL container (infra/docker-compose.yml). Migrations only add; nothing is reset.
const root = connect(roleUrl('admin', 'postgres'), 1)
try {
  if (!(await root.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rows[0]) await root.query(`CREATE DATABASE ${database}`)
} catch (e) {
  console.error(`PostgreSQL is not reachable. Start it with: pnpm db  (${e instanceof Error ? e.message : e})`)
  process.exit(1)
}
await root.end()
const pools = await openPools(database)
await migrate(pools.admin)
await pools.admin.end() // the running app keeps no owner connection

// WORKER=external: jobs are run by a separate `pnpm worker` process and this one drops the worker role.
const external = process.env.WORKER === 'external'
if (external) await pools.worker.end()
const baseUrl = `http://127.0.0.1:${port}`
const auth = await createAuth({
  authDatabaseUrl: roleUrl('app_auth', database),
  secret: keyFile('auth.secret'),
  baseUrl,
  sendLink: (email, url) => mailboxNotifier(pools.web).send({ to: email, subject: 'Your sign-in link', body: url }),
})
const deps: Deps = {
  db: pools.web, worker: external ? null : pools.worker, callback: pools.callback, operator: pools.operator, auth,
  masterKey: Buffer.from(keyFile('master.key'), 'base64'), storageDir: join(dataDir, 'uploads'), baseUrl,
  ai: mockAi, messaging: mockMessaging, notifier: mailboxNotifier(pools.web), localMailbox: true,
  operatorEmails: (process.env.OPERATOR_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
}

// Picks up retries and leases left by an earlier run.
const jobs = deps.worker ? { ...deps, worker: deps.worker } : null
if (jobs)
  setInterval(() => beat(jobs.worker, 'in-process').then(() => drain(jobs)).catch((e) => console.error('worker:', e instanceof Error ? e.message : 'unknown')), 2000).unref()
server.on('request', createApp(deps))
console.log(`Local prototype (mock WhatsApp, mock AI, simulated email): ${baseUrl}
  database ${database} · data folder ${dataDir} · jobs run ${external ? 'by a separate `pnpm worker`' : 'inside this process'}`)
