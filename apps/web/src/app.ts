// Request plumbing: routing, sessions, CSRF, the §8 response envelope and static files.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AccessError, type Db } from '@lathar/database'
import type { AiAdapter } from './ai.ts'
import { apiRoutes } from './api.ts'
import type { Auth, User } from './auth.ts'
import { AppError, Raw, UUID } from './http.ts'
import { pageRoutes } from './views.ts'
import type { Messaging, Notifier } from './worker.ts'

export interface Deps {
  db: Db // web role
  /** Null when jobs are run by a separate worker process; this process then holds no worker role. */
  worker: Db | null
  callback: Db
  /** Reads the operator diagnostics function and nothing else. */
  operator: Db
  /** Verified sign-in emails allowed to open the operator screen. Empty means nobody. */
  operatorEmails: string[]
  /** Invitations and staff notices. SIMULATED in this build (local mailbox). */
  notifier: Notifier
  auth: Auth
  masterKey: Buffer
  storageDir: string
  baseUrl: string
  ai: AiAdapter
  messaging: Messaging
  /** Development only. When false there is no mailbox page and no way to deliver a sign-in link. */
  localMailbox: boolean
}
export interface Ctx {
  deps: Deps
  param(name: string): string
  query: URLSearchParams
  headers: IncomingMessage['headers']
  body: Record<string, unknown>
  raw: Buffer
  user: User
}
export class Redirect {
  to: string
  constructor(to: string) {
    this.to = to
  }
}
export type Handler = (c: Ctx) => Promise<unknown>
export type Add = (method: string, path: string, handler: Handler, open?: boolean) => void

const MAX_BODY = 2 * 1024 * 1024 + 64 * 1024
const STATIC = new URL('../', import.meta.url)
const TYPES: Record<string, string> = { css: 'text/css', js: 'text/javascript', woff2: 'font/woff2', txt: 'text/plain' }

export function createApp(deps: Deps) {
  const routes: { method: string; re: RegExp; keys: string[]; handler: Handler; open: boolean }[] = []
  const add: Add = (method, path, handler, open = false) => {
    const keys = [...path.matchAll(/:(\w+)/g)].map((m) => m[1] ?? '')
    routes.push({ method, re: new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`), keys, handler, open })
  }
  apiRoutes(add)
  pageRoutes(add, deps.localMailbox)

  return async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = randomUUID()
    const url = new URL(req.url ?? '/', 'http://local')
    const api = url.pathname.startsWith('/api/')
    const method = req.method ?? 'GET'
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'")

    const fail = (status: number, code: string, message: string, fields?: Record<string, string>) => {
      if (!api && status === 401) return res.writeHead(303, { Location: '/signin' }).end()
      res.statusCode = status
      res.setHeader('Cache-Control', 'no-store')
      if (api) {
        res.setHeader('Content-Type', 'application/json')
        return res.end(JSON.stringify({ error: { code, message, retryable: status >= 500 || status === 429, request_id: requestId, field_errors: fields } }))
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${status}</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/styles/tokens.css"><link rel="stylesheet" href="/styles/ui.css"><main style="padding:48px 24px;max-width:480px;margin:auto"><h1 style="font:var(--text-title)">${status === 404 ? 'Page not found' : 'That didn’t work'}</h1><p style="margin:12px 0">${status === 404 ? 'It may belong to a workspace you are not a member of.' : 'Go back and try again.'}</p><a class="btn secondary" href="/">Back to start</a></main></html>`)
    }

    try {
      // Sign-in, sign-out and session endpoints belong to the auth library.
      if (url.pathname.startsWith('/api/auth/')) return await deps.auth.handle(req, res)

      const file = /^\/(styles|public)\/([\w-]+\/)?[\w-]+\.(css|js|woff2|txt)$/.exec(url.pathname)
      if (method === 'GET' && file) {
        const data = await readFile(new URL(`.${url.pathname}`, STATIC)).catch(() => null)
        if (!data) return fail(404, 'NOT_FOUND', 'Not found.')
        return res.writeHead(200, { 'Content-Type': TYPES[file[3] ?? ''] ?? 'application/octet-stream' }).end(data)
      }

      let params: Record<string, string> = {}
      const route = routes.find((r) => {
        const m = r.method === method && r.re.exec(url.pathname)
        if (m) params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1] ?? '']))
        return Boolean(m)
      })
      // Malformed IDs are just "not found"; they never reach SQL.
      if (!route || Object.values(params).some((v) => !UUID.test(v))) return fail(404, 'NOT_FOUND', 'Not found.')

      let raw = Buffer.alloc(0)
      let body: Record<string, unknown> = {}
      if (method !== 'GET') {
        // CSRF: the session cookie is SameSite=Lax, and state changes must come from this origin.
        const origin = req.headers.origin
        const site = req.headers['sec-fetch-site']
        if ((origin && URL.parse(origin)?.host !== req.headers.host) || (site && site !== 'same-origin' && site !== 'none')) return fail(403, 'CROSS_SITE', 'Cross-site requests are not accepted.')
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > MAX_BODY) return fail(413, 'TOO_LARGE', 'That is larger than the 2 MB limit.')
          chunks.push(chunk)
        }
        raw = Buffer.concat(chunks)
        if (!url.pathname.endsWith('/uploads')) {
          const type = req.headers['content-type']
          if ((raw.length || type) && !type?.startsWith('application/json')) return fail(415, 'UNSUPPORTED', 'Send JSON.')
          try {
            body = raw.length ? JSON.parse(raw.toString()) : {}
          } catch {
            return fail(400, 'BAD_JSON', 'The request body is not valid JSON.')
          }
          if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(400, 'BAD_JSON', 'Send a JSON object.')
        }
      }

      const user = await deps.auth.user(deps.db, req.headers)
      if (!user && !route.open) return fail(401, 'UNAUTHENTICATED', 'Sign in first.')

      const param = (name: string) => {
        const v = params[name]
        if (!v) throw new AccessError('NOT_FOUND')
        return v
      }
      // Open routes handle a missing user themselves; every other route is guaranteed one above.
      const out = await route.handler({ deps, param, query: url.searchParams, headers: req.headers, body, raw, user: user as User })
      res.setHeader('Cache-Control', 'no-store')
      if (out instanceof Redirect) return res.writeHead(303, { Location: out.to }).end()
      if (out instanceof Raw) return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(out.s)
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: out ?? null }))
    } catch (e) {
      // A non-member gets the same 404 as a missing record, so other tenants' IDs reveal nothing.
      if (e instanceof AccessError) return e.code === 'NOT_FOUND' ? fail(404, 'NOT_FOUND', 'Not found.') : fail(403, 'FORBIDDEN', 'Your role does not allow this.')
      if (e instanceof AppError) return fail(e.status, e.code, e.message, e.fields)
      console.error(requestId, e instanceof Error ? e.message : 'unknown error') // message only: never bodies or secrets
      fail(500, 'INTERNAL', 'Something went wrong on our side.')
    }
  }
}
