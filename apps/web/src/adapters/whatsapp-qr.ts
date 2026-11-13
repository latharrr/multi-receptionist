// Unofficial QR route: one linked-device session per connection, held by the gateway process.
// NOT an official WhatsApp integration. WhatsApp can restrict or disconnect an account used
// this way; the owner accepts that in writing before a session is ever started.
//
// Isolation: each connection has its own session folder (mode 0700) under the gateway's data
// directory and its own socket. Session files never leave the server and are deleted when the
// connection ends. shortcut: session files are not encrypted at rest; put the data directory on
// an encrypted volume, and move the key store into the database before more than a pilot.
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withTenant, type Db } from '@lathar/database'
import { receiveInbound, type Messaging } from '../worker.ts'

/** The part of the linked-device library this gateway uses. Tests substitute a fake. */
export interface QrSocket {
  ev: { on(event: string, handler: (arg: never) => void): void }
  user?: { id: string; phoneNumber?: string } | undefined
  sendMessage(jid: string, content: { text: string }): Promise<{ key: { id?: string | null } } | undefined>
  logout(): Promise<void>
  end(error: Error | undefined): unknown
}
export type SocketFactory = (sessionDir: string) => Promise<{ sock: QrSocket; saveCreds: () => Promise<void> }>

interface Row { id: string; workspace_id: string; state: string; authorized_number: string }
interface Session { row: Row; sock: QrSocket | null; open: boolean; number: string | null; failures: number; closing: boolean }
interface Update { connection?: string; qr?: string; lastDisconnect?: { error?: { output?: { statusCode?: number } } } }
interface Incoming { key: { remoteJid?: string | null; remoteJidAlt?: string; fromMe?: boolean | null; id?: string | null }; message?: { conversation?: string | null; extendedTextMessage?: { text?: string | null } | null } | null; pushName?: string | null }

// From the library's own enums: closed for good (logged out, replaced by another session, bad session).
const FINAL_CLOSE = new Set([401, 440, 500])
const MAX_FAILURES = 5
const digits = (jid: string | undefined | null) => jid?.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') ?? ''
// Delivery states the library reports for our own messages (proto WebMessageInfo.Status).
const STATUS: Record<number, string> = { 0: 'failed', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read' }

export function createGateway(o: { worker: Db; callback: Db; dataDir: string; factory: SocketFactory }) {
  const sessions = new Map<string, Session>()
  const dir = (id: string) => join(o.dataDir, 'qr', id)
  const setState = (s: Session, sql: string, params: unknown[] = []) =>
    withTenant(o.worker, s.row.workspace_id, (tx) => tx.query(`UPDATE connections SET ${sql}, version = version + 1 WHERE id = $1`, [s.row.id, ...params]))

  /** Ends a session and removes its files. `unlink` also removes the linked device from the phone. */
  async function close(s: Session, unlink: boolean) {
    s.closing = true
    sessions.delete(s.row.id)
    try {
      if (unlink && s.open) await s.sock?.logout()
      else s.sock?.end(undefined)
    } catch { /* the socket may already be gone */ }
    await rm(dir(s.row.id), { recursive: true, force: true })
  }

  async function open(s: Session) {
    await mkdir(dir(s.row.id), { recursive: true, mode: 0o700 })
    const { sock, saveCreds } = await o.factory(dir(s.row.id))
    s.sock = sock
    sock.ev.on('creds.update', (() => void saveCreds()) as never)

    sock.ev.on('connection.update', (async (u: Update) => {
      if (s.closing) return
      try {
        if (u.qr) {
          // Shown only while the owner's setup step is still open; an expired step ends the session.
          const r = await withTenant(o.worker, s.row.workspace_id, (tx) =>
            tx.query(`UPDATE connections SET link_artifact = $2 WHERE id = $1 AND state = 'pending_auth' AND link_expires_at > now() RETURNING id`, [s.row.id, u.qr]))
          if (!r.rows[0]) await close(s, false)
        }
        if (u.connection === 'open') {
          const number = digits(sock.user?.phoneNumber ?? sock.user?.id)
          s.failures = 0
          if (!number || number !== s.row.authorized_number) {
            // Never accept a different number silently: unlink it at once.
            await setState(s, `state = 'needs_action', last_health = 'number_mismatch', last_error = 'number_mismatch', last_health_at = now(), link_artifact = NULL`)
            s.open = true
            return close(s, true)
          }
          try {
            await setState(s, `state = 'connected', verified_number_id = $2, masked_number = $3, last_health = 'ready', last_health_at = now(), last_error = NULL, link_artifact = NULL, link_expires_at = NULL`, [number, `••• ${number.slice(-4)}`])
            s.open = true
            s.number = number
          } catch {
            await setState(s, `state = 'needs_action', last_health = 'number_already_connected_elsewhere', last_error = 'number_already_connected_elsewhere', last_health_at = now(), link_artifact = NULL`)
            s.open = true
            await close(s, true)
          }
        }
        if (u.connection === 'close') {
          s.open = false
          const code = u.lastDisconnect?.error?.output?.statusCode ?? 0
          if (FINAL_CLOSE.has(code) || ++s.failures >= MAX_FAILURES) {
            // Stops automated sends at once. Reconnecting needs the owner to start again.
            await setState(s, `state = 'disconnected', last_health = $2, last_error = $2, last_health_at = now(), link_artifact = NULL`, [code === 401 ? 'logged_out_from_phone' : code === 440 ? 'replaced_by_another_session' : 'gateway_could_not_stay_connected'])
            return close(s, false)
          }
          // A restart is expected right after pairing, and after brief network drops. Bounded, with a growing wait.
          setTimeout(() => void (sessions.get(s.row.id) === s && open(s).catch(() => {})), 2000 * s.failures).unref()
        }
      } catch (e) {
        console.error(`qr ${s.row.id}:`, e instanceof Error ? e.message : 'unknown')
      }
    }) as never)

    sock.ev.on('messages.upsert', (async (up: { type: string; messages: Incoming[] }) => {
      if (up.type !== 'notify' || !s.number) return // history and backfill are never replayed
      for (const m of up.messages) {
        const jid = m.key.remoteJidAlt?.endsWith('@s.whatsapp.net') ? m.key.remoteJidAlt : m.key.remoteJid
        // One-to-one chats only: no groups, broadcasts, status updates or our own messages.
        if (m.key.fromMe || !m.key.id || !jid || !/@(s\.whatsapp\.net|lid)$/.test(jid)) continue
        const from = jid.endsWith('@lid') ? `lid:${jid.split('@')[0]}` : digits(jid)
        await receiveInbound(o.callback, {
          route: 'unofficial_qr', numberId: s.number, eventKey: m.key.id, from, name: m.pushName?.slice(0, 80) ?? null,
          text: (m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? null)?.slice(0, 4000) ?? null,
        }).catch((e) => console.error(`qr ${s.row.id} inbound:`, e instanceof Error ? e.message : 'unknown'))
      }
    }) as never)

    sock.ev.on('messages.update', (async (updates: { key: { fromMe?: boolean | null; id?: string | null }; update: { status?: number | null } }[]) => {
      for (const { key, update } of updates) {
        const status = STATUS[update.status ?? -1]
        if (key.fromMe && key.id && status && s.number)
          await o.callback.query('SELECT record_receipt($1, $2, $3, $4, NULL, NULL, NULL)', ['unofficial_qr', s.number, key.id, status]).catch(() => {})
      }
    }) as never)
  }

  return {
    /** Brings the set of live sessions in line with the database. Called on a timer. */
    async sync() {
      const rows = (await o.worker.query<Row>('SELECT * FROM qr_connections()')).rows
      const wanted = new Map(rows.map((r) => [r.id, r]))
      // Disconnected, cancelled or mismatched in the app: unlink the device and delete the session.
      for (const s of [...sessions.values()]) if (!wanted.has(s.row.id)) await close(s, true)
      for (const row of rows) {
        if (sessions.has(row.id)) continue
        const s: Session = { row, sock: null, open: false, number: null, failures: 0, closing: false }
        sessions.set(row.id, s)
        await open(s).catch(async (e) => {
          console.error(`qr ${row.id} could not start:`, e instanceof Error ? e.message : 'unknown')
          sessions.delete(row.id)
        })
      }
      return sessions.size
    },
    /** Sends through the session that owns this connection, and only that one. */
    messaging: {
      async send({ text, target }) {
        const s = sessions.get(target.connectionId)
        if (!s?.open || !s.sock) return { state: 'failed', errorCode: 'session_not_connected' }
        const jid = target.to.startsWith('lid:') ? `${target.to.slice(4)}@lid` : `${target.to}@s.whatsapp.net`
        const sent = await s.sock.sendMessage(jid, { text })
        if (!sent?.key.id) throw new Error('unreadable_provider_answer')
        return { state: 'accepted', providerMessageId: sent.key.id }
      },
    } satisfies Messaging,
    async stop() {
      for (const s of [...sessions.values()]) {
        s.closing = true
        s.sock?.end(undefined)
      }
      sessions.clear()
    },
  }
}
