// Sign-in is handled by better-auth (maintained library): single-use expiring email links and
// database-backed sessions in its own `auth` schema, reached through its own login role.
// This file only configures it and maps its identity to our users table.
import type { IncomingMessage } from 'node:http'
import type { Db } from '@lathar/database'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node'
import { magicLink } from 'better-auth/plugins/magic-link'
import pg from 'pg'

export interface AuthOptions {
  authDatabaseUrl: string
  secret: string
  baseUrl: string
  /** Delivers the sign-in link. Development uses the local mailbox; there is no real sender yet. */
  sendLink: (email: string, url: string) => Promise<void>
  linksPerMinute?: number
}

export async function createAuth(o: AuthOptions) {
  const pool = new pg.Pool({ connectionString: o.authDatabaseUrl, max: 3, options: '-c search_path=auth' })
  pool.on('error', (e) => console.error('auth database connection lost:', e.message))
  const auth = betterAuth({
    database: pool,
    secret: o.secret,
    baseURL: o.baseUrl,
    basePath: '/api/auth',
    trustedOrigins: [o.baseUrl, o.baseUrl.replace('127.0.0.1', 'localhost')],
    // No cookie cache: every request re-reads the session row, so revocation is immediate.
    session: { expiresIn: 7 * 86400, updateAge: 86400 },
    rateLimit: { enabled: true },
    advanced: { useSecureCookies: o.baseUrl.startsWith('https:'), ipAddress: { ipAddressHeaders: ['x-socket-address'] } },
    plugins: [
      magicLink({
        expiresIn: 15 * 60,
        storeToken: 'hashed',
        rateLimit: { window: 60, max: o.linksPerMinute ?? 5 },
        sendMagicLink: ({ email, url }) => o.sendLink(email, url),
      }),
    ],
  })
  await (await getMigrations(auth.options)).runMigrations()
  const handler = toNodeHandler(auth)
  return {
    /** Serves /api/auth/*. The client address comes from the socket, never from a request header. */
    handle(req: IncomingMessage, res: Parameters<typeof handler>[1]) {
      req.headers['x-socket-address'] = req.socket.remoteAddress ?? ''
      return handler(req, res)
    },
    async user(db: Db, headers: IncomingMessage['headers']): Promise<User | null> {
      const s = await auth.api.getSession({ headers: fromNodeHeaders(headers) })
      if (!s?.user.emailVerified) return null
      const r = await db.query<{ id: string | null }>('SELECT user_for_identity($1, $2) AS id', [s.user.id, s.user.email])
      const id = r.rows[0]?.id
      return id ? { id, email: s.user.email } : null
    },
    end: () => pool.end(),
  }
}
export type Auth = Awaited<ReturnType<typeof createAuth>>

export interface User {
  id: string
  email: string
}
