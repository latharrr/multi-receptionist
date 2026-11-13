// Web process: screens, control API, sign-in and provider webhooks. In development it also
// creates its database, migrates and runs jobs itself so one command gives a working demo;
// in production those are separate steps and separate processes.
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { connect, migrate } from '@lathar/database'
import { createApp, type Deps } from './app.ts'
import { createAuth } from './auth.ts'
import { boot, log } from './runtime.ts'
import { beat, drain } from './worker.ts'

const rt = await boot(['DATABASE_URL_WEB', 'DATABASE_URL_CALLBACK', 'DATABASE_URL_AUTH', 'DATABASE_URL_OPERATOR', 'MASTER_KEY', 'AUTH_SECRET', 'PUBLIC_URL', 'SUPPORT_EMAIL', 'SMTP_URL', 'MAIL_FROM'])
const { config } = rt

// Never takes a port from another process. In development, without PORT set, it moves to the next free one.
const listen = (port: number) =>
  new Promise<ReturnType<typeof createServer> | null>((resolve, reject) => {
    const s = createServer()
    s.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' ? resolve(null) : reject(e)))
    s.listen(port, config.production ? '0.0.0.0' : '127.0.0.1', () => resolve(s))
  })
const wanted = config.PORT ?? 3000
let port = wanted
let server = await listen(port)
if (!server) {
  let holder = ''
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${wanted}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8' })
    holder = `process ${/^p(\d+)$/m.exec(out)?.[1] ?? '?'} (${/^c(.+)$/m.exec(out)?.[1] ?? 'unknown'})`
  } catch { /* lsof missing: the message just names the port */ }
  if (config.PORT || config.production) {
    console.error(`Port ${wanted} is already in use${holder && ` by ${holder}`}. It was left alone. Stop it yourself or choose another PORT.`)
    process.exit(1)
  }
  while (!server && port < wanted + 20) server = await listen(++port)
  if (!server) throw new Error(`No free port between ${wanted} and ${port}.`)
  console.log(`Port ${wanted} is already in use${holder && ` by ${holder}`}. It was left running; this server uses ${port} instead.`)
}

if (!config.production) {
  // Local PostgreSQL container (infra/docker-compose.yml). Migrations only add; nothing is reset.
  const root = connect(process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:dev@127.0.0.1:54329/postgres', 1)
  try {
    if (!(await root.query('SELECT 1 FROM pg_database WHERE datname = $1', [rt.database])).rows[0]) await root.query(`CREATE DATABASE ${rt.database}`)
  } catch (e) {
    console.error(`PostgreSQL is not reachable. Start it with: pnpm db  (${e instanceof Error ? e.message : e})`)
    process.exit(1)
  }
  await root.end()
  const owner = rt.pool('migrate', 1)
  await migrate(owner)
  await owner.end() // the running app keeps no owner connection
}

const web = rt.pool('web')
// WORKER=external (always, in production): jobs are run by a separate worker process and this one holds no worker role.
const external = config.production || process.env.WORKER === 'external'
const worker = external ? null : rt.pool('worker')
const baseUrl = config.PUBLIC_URL ?? `http://127.0.0.1:${port}`
const mail = rt.notifier(web)
const auth = await createAuth({
  authDatabaseUrl: rt.dbUrl('auth'), secret: rt.authSecret(), baseUrl,
  sendLink: (email, url) => mail.notifier.send({ to: email, subject: 'Your sign-in link', body: `Open this link to sign in. It works once and expires in 15 minutes.\n${url}` }),
})
// The worker and gateway read the public address from here, so their links always match this process.
await web.query(`INSERT INTO runtime_info (key, value) VALUES ('base_url', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [baseUrl])

const deps: Deps = {
  db: web, worker, callback: rt.pool('callback', 3), operator: rt.pool('operator', 1), auth,
  masterKey: rt.masterKey, storageDir: `${rt.dataDir}/uploads`, baseUrl,
  ai: rt.ai, aiLive: rt.aiLive, messaging: rt.messaging(), notifier: mail.notifier, localMailbox: mail.localMailbox,
  support: rt.support, official: rt.official, allowAutonomous: !config.production, supportEmail: config.SUPPORT_EMAIL ?? null,
  operatorEmails: config.operatorEmails,
}

// Picks up retries and leases left by an earlier run.
const jobs = deps.worker ? { ...deps, worker: deps.worker } : null
if (jobs)
  setInterval(() => beat(jobs.worker, 'in-process').then(() => drain(jobs)).catch((e) => console.error('worker:', e instanceof Error ? e.message : 'unknown')), 2000).unref()
server.on('request', createApp(deps))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server?.close(() => process.exit(0)))
log('web.started', { port, production: config.production, ai: rt.aiLive ? 'live' : 'mock', email: mail.localMailbox ? 'local-mailbox' : config.SMTP_URL ? 'smtp' : 'none', official_route: rt.support.official, qr_route: rt.support.qr, jobs: external ? 'separate-worker' : 'in-process' })
if (!config.production) console.log(`Receptionist: ${baseUrl}\n  database ${rt.database} · data folder ${rt.dataDir}`)
