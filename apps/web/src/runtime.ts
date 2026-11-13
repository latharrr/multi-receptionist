// Shared start-up for the web, worker and gateway processes: configuration, database roles,
// keys and adapters. Development falls back to the local container and the dev-only mocks;
// production never does.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect, type Db } from '@lathar/database'
import { routeMessaging } from './adapters/index.ts'
import type { AiAdapter } from './adapters/ai.ts'
import { anthropic } from './adapters/anthropic.ts'
import { smtpNotifier } from './adapters/email.ts'
import { officialMessaging } from './adapters/whatsapp-official.ts'
import { loadConfig, type Config } from './config.ts'
import type { Messaging, Notifier } from './worker.ts'

type Role = 'web' | 'worker' | 'callback' | 'auth' | 'operator' | 'migrate'
const LOCAL: Record<Role, string> = { web: 'app_user', worker: 'app_worker', callback: 'app_callback', auth: 'app_auth', operator: 'app_operator', migrate: 'postgres' }

export async function boot(needs: Parameters<typeof loadConfig>[1] = []) {
  let config: Config
  try {
    config = loadConfig(process.env, needs)
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }
  const database = process.env.DATABASE_NAME ?? 'receptionist_demo'
  const dataDir = config.DATA_DIR ?? join(import.meta.dirname, '../../../.data', database)
  mkdirSync(join(dataDir, 'uploads'), { recursive: true, mode: 0o700 })

  /** Each process connects as its own role. Development uses the local container's throwaway logins. */
  const dbUrl = (role: Role): string => {
    const fromEnv = config[`DATABASE_URL_${role.toUpperCase()}` as 'DATABASE_URL_WEB']
    if (fromEnv) return fromEnv
    if (config.production) throw new Error(`DATABASE_URL_${role.toUpperCase()} is required in production`)
    const u = new URL(process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:dev@127.0.0.1:54329/postgres')
    u.username = LOCAL[role]
    u.pathname = `/${database}`
    return u.href
  }
  const pool = (role: Role, max = 5): Db => connect(dbUrl(role), max)

  // Development keeps generated keys in files beside the data; production must be given them.
  const devKey = (name: string) => {
    const file = join(dataDir, name)
    if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 })
    return readFileSync(file, 'utf8')
  }
  const masterKey = Buffer.from(config.MASTER_KEY ?? devKey('master.key'), 'base64')
  const authSecret = () => config.AUTH_SECRET ?? devKey('auth.secret')

  const mocks = config.production ? null : await import('./dev/mocks.ts')
  const aiLive = config.production || config.AI === 'live'
  const ai: AiAdapter = aiLive || !mocks ? anthropic : mocks.mockAi
  const official = config.META_APP_SECRET && config.META_VERIFY_TOKEN ? { appSecret: config.META_APP_SECRET, verifyToken: config.META_VERIFY_TOKEN } : null
  const messaging = (qr?: Messaging) =>
    routeMessaging({ mock: mocks?.mockMessaging, official: officialMessaging({ graphBase: config.GRAPH_API_BASE, graphVersion: config.GRAPH_API_VERSION }), qr })

  /** Real SMTP when configured; the local mailbox in development; otherwise mail visibly fails. */
  const notifier = (db: Db): { notifier: Notifier; localMailbox: boolean } => {
    if (config.SMTP_URL && config.MAIL_FROM) return { notifier: smtpNotifier(config.SMTP_URL, config.MAIL_FROM), localMailbox: false }
    if (mocks) return { notifier: mocks.mailboxNotifier(db), localMailbox: true }
    return { notifier: { send: async () => { throw new Error('no email sender is configured') } }, localMailbox: false }
  }

  return { config, database, dataDir, dbUrl, pool, masterKey, authSecret, ai, aiLive, official, messaging, notifier, support: { mock: Boolean(mocks), official: Boolean(official), qr: config.QR_GATEWAY === 'on' } }
}

/** Structured, content-free log line: an event name and IDs or counts only. */
export const log = (event: string, fields: Record<string, string | number | boolean | null> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }))
