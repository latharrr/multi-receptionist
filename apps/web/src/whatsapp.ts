// WhatsApp routes. Both have a live adapter. A live connection is only offered when the platform
// is configured for that route; a mock connection only exists in development and is labelled
// as a mock everywhere it is shown.
import { canTransition } from '@lathar/contracts'
import { audit, one, type Tx } from '@lathar/database'
import QRCode from 'qrcode'
import { AppError, invalid, maskNumber, normalizeNumber, str } from './http.ts'
import { sealSecret } from './secrets.ts'
import { enqueue } from './worker.ts'

/** What this installation can actually do, from its configuration. */
export interface RouteSupport {
  mock: boolean
  official: boolean
  qr: boolean
}

export const ROUTES = {
  official_cloud_api: {
    name: 'Official Cloud API',
    disclosure: 'official-cloud-v1',
    liveBlocker: 'Needs this platform’s Meta app secret and webhook verify token, and a WhatsApp Business phone number ID with an access token from your own Meta business account. Meta decides which numbers and businesses are eligible.',
  },
  unofficial_qr: {
    name: 'Unofficial QR link',
    disclosure: 'unofficial-qr-v1',
    liveBlocker: 'Needs the QR gateway process to be switched on for this platform. It is not an official WhatsApp integration.',
  },
} as const
export type Route = keyof typeof ROUTES

const LINK_TTL_SECONDS = 120

export interface Connection {
  id: string
  route: Route
  mode: 'mock' | 'live'
  state: string
  masked_number: string | null
  last_health: string | null
  last_health_at: Date | null
  link_expires_at: Date | null
  last_error: string | null
}
const COLS = 'id, route, mode, state, masked_number, last_health, last_health_at, link_expires_at, last_error'
const OPEN = `state IN ('unconfigured', 'pending_auth', 'connecting', 'connected', 'needs_action')`

export const currentConnection = async (tx: Tx) => (await tx.query<Connection>(`SELECT ${COLS} FROM connections WHERE ${OPEN}`)).rows[0] ?? null

async function load(tx: Tx, id: string) {
  const c = (await tx.query<Connection>(`SELECT ${COLS} FROM connections WHERE id = $1 FOR UPDATE`, [id])).rows[0]
  if (!c) throw new AppError(404, 'NOT_FOUND', 'Not found.')
  return c
}
async function move(tx: Tx, c: Connection, to: string, extra = '') {
  if (!canTransition('connection', c.state, to)) throw new AppError(409, 'INVALID_STATE', `This connection is ${c.state.replace('_', ' ')}; that step is not available now.`)
  await tx.query(`UPDATE connections SET state = $2, version = version + 1 ${extra} WHERE id = $1`, [c.id, to])
  c.state = to
}

export async function createConnection(tx: Tx, support: RouteSupport, body: Record<string, unknown>) {
  const route = body.route as Route
  if (!(route in ROUTES)) throw invalid('route', 'Choose a route.')
  const mode = body.mode === 'mock' ? 'mock' : 'live'
  if (mode === 'mock' && !support.mock) throw new AppError(409, 'MOCK_NOT_AVAILABLE', 'Mock connections only exist in development.')
  // Missing platform setup is stated, never papered over with a pretend connection.
  if (mode === 'live' && !(route === 'official_cloud_api' ? support.official : support.qr))
    throw new AppError(409, 'ROUTE_NOT_AVAILABLE', `${ROUTES[route].name} is not set up on this platform yet. ${ROUTES[route].liveBlocker}`)
  if (await currentConnection(tx)) throw new AppError(409, 'ROUTE_ALREADY_OPEN', 'Disconnect the current route before choosing another. Two routes are never open at once.')
  const r = await tx.query<{ id: string }>(`INSERT INTO connections (workspace_id, route, mode) VALUES (app_workspace_id(), $1, $2) RETURNING id`, [route, mode])
  const { id } = one(r)
  await audit(tx, 'connection.create', { connection_id: id })
  return load(tx, id)
}

/** Route-specific setup. Records the owner's consent and the number they mean to connect. Not activation. */
export async function startConnection(tx: Tx, userId: string, id: string, body: Record<string, unknown>) {
  const c = await load(tx, id)
  if (c.state === 'unconfigured') {
    const number = normalizeNumber(typeof body.authorized_number === 'string' ? body.authorized_number : '', 'authorized_number')
    if (body.accept !== true && body.accept !== 'on')
      throw invalid('accept', c.route === 'unofficial_qr' ? 'Confirm you have read and accept the risks of the unofficial route.' : 'Confirm you have read the conditions for the official route.')
    await tx.query(
      `INSERT INTO connection_consents (workspace_id, connection_id, owner_user_id, disclosure_version, route, authorized_number)
       VALUES (app_workspace_id(), $1, $2, $3, $4, $5)`,
      [id, userId, ROUTES[c.route].disclosure, c.route, number],
    )
    await tx.query('UPDATE connections SET authorized_number = $2 WHERE id = $1', [id, number])
  }
  await move(tx, c, 'pending_auth', `, link_artifact = NULL, last_error = NULL, link_expires_at = now() + interval '${LINK_TTL_SECONDS} seconds'`)
  await audit(tx, 'connection.start', { connection_id: id })
  return load(tx, id)
}

const linkOpen = (c: Connection) => c.state === 'pending_auth' && c.link_expires_at !== null && c.link_expires_at > new Date()

/**
 * Short-lived artifact for the QR route: authenticated, never cached, cleared on link or expiry.
 * The mock one is deliberately not a scannable code. The live one is the code WhatsApp issued to
 * the gateway for this connection only; `svg` is null until the gateway has it.
 */
export async function linkArtifact(tx: Tx, id: string) {
  const c = await load(tx, id)
  if (c.route !== 'unofficial_qr' || c.state !== 'pending_auth') throw new AppError(409, 'INVALID_STATE', 'There is no link code for this connection right now.')
  if (!linkOpen(c)) throw new AppError(410, 'LINK_EXPIRED', 'That code expired. Start again to get a new one.')
  if (c.mode === 'mock') return { mock: true, payload: 'MOCK-CODE-NOT-SCANNABLE', svg: null, expires_at: c.link_expires_at }
  const code = (await tx.query<{ link_artifact: string | null }>('SELECT link_artifact FROM connections WHERE id = $1', [id])).rows[0]?.link_artifact
  return { mock: false, payload: null, svg: code ? await QRCode.toString(code, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }) : null, expires_at: c.link_expires_at }
}

/**
 * Official route: the owner's own Cloud API credentials. The token is sealed at once and only
 * the worker can open it; a background check then asks Meta which number they belong to.
 */
export async function saveCredentials(tx: Tx, master: Buffer, id: string, body: Record<string, unknown>) {
  const c = await load(tx, id)
  if (c.route !== 'official_cloud_api' || c.mode !== 'live') throw new AppError(409, 'INVALID_STATE', 'Credentials are only used by a live official connection.')
  if (c.state !== 'pending_auth' && c.state !== 'needs_action') throw new AppError(409, 'INVALID_STATE', 'Start the connection first.')
  const numberId = str(body, 'phone_number_id', 40)
  if (!/^\d{5,40}$/.test(numberId)) throw invalid('phone_number_id', 'Enter the phone number ID from Meta: digits only.')
  const token = str(body, 'access_token', 1000, 20)
  if (/\s/.test(token)) throw invalid('access_token', 'Paste the token without spaces or line breaks.')
  const ws = one(await tx.query<{ id: string }>('SELECT app_workspace_id() AS id')).id
  await tx.query('UPDATE secret_refs SET revoked_at = now(), rotated_at = now() WHERE id = (SELECT secret_ref_id FROM connections WHERE id = $1)', [id])
  const s = await tx.query<{ id: string }>(
    `INSERT INTO secret_refs (workspace_id, kind, ciphertext, key_version, masked_label) VALUES (app_workspace_id(), 'whatsapp_token', $1, 'local-1', $2) RETURNING id`,
    [sealSecret(master, `${ws}:whatsapp_token:${c.route}`, token), `••••••••${token.slice(-4)}`])
  await move(tx, c, 'connecting', `, secret_ref_id = '${one(s).id}', last_error = NULL, link_expires_at = NULL`)
  await tx.query('UPDATE connections SET provider_account = $2 WHERE id = $1', [id, JSON.stringify({ phone_number_id: numberId })])
  const key = `verify:${id}:${one(s).id}`
  await enqueue(tx, 'verify_connection', key, { connection_id: id })
  await audit(tx, 'connection.credentials', { connection_id: id })
  return key
}

/** MOCK ONLY: plays the provider's part, reporting which number was linked. */
export async function mockLink(tx: Tx, id: string, body: Record<string, unknown>) {
  const c = await load(tx, id)
  if (c.mode !== 'mock') throw new AppError(409, 'NOT_A_MOCK', 'Only mock connections can be simulated.')
  if (c.state !== 'pending_auth') throw new AppError(409, 'INVALID_STATE', 'Start the connection first.')
  if (!linkOpen(c)) throw new AppError(410, 'LINK_EXPIRED', 'The setup step expired. Start again.')
  const consent = one(await tx.query<{ authorized_number: string }>('SELECT authorized_number FROM connection_consents WHERE connection_id = $1 ORDER BY accepted_at DESC LIMIT 1', [id]))
  const linked = typeof body.linked_number === 'string' && body.linked_number ? normalizeNumber(body.linked_number, 'linked_number') : consent.authorized_number
  if (linked !== consent.authorized_number) {
    // Never accept a different number silently.
    await move(tx, c, 'needs_action', `, last_health = 'number_mismatch', last_health_at = now(), link_expires_at = NULL`)
    return load(tx, id)
  }
  await move(tx, c, 'connecting')
  await tx.query(
    `UPDATE connections SET state = 'connected', masked_number = $2, verified_number_id = $3,
            last_health = 'ready', last_health_at = now(), link_expires_at = NULL WHERE id = $1`,
    [id, maskNumber(linked), `mock:${id}`],
  )
  return load(tx, id)
}

export async function disconnect(tx: Tx, id: string) {
  const c = await load(tx, id)
  await move(tx, c, canTransition('connection', c.state, 'disconnected') ? 'disconnected' : 'revoked', `, last_health = NULL, link_expires_at = NULL, link_artifact = NULL`)
  // Stops local use at once. It does not revoke the token with Meta or unlink the device in WhatsApp.
  await tx.query('UPDATE secret_refs SET revoked_at = now() WHERE id = (SELECT secret_ref_id FROM connections WHERE id = $1) AND revoked_at IS NULL', [id])
  await audit(tx, 'connection.disconnect', { connection_id: id })
  return c
}
