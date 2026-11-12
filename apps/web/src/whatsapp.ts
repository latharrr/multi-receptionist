// WhatsApp routes. Both are represented; neither has a live adapter yet, so every connection
// made here is mode = 'mock' and is labelled that way everywhere it is shown.
import { canTransition } from '@lathar/contracts'
import { audit, one, type Tx } from '@lathar/database'
import { AppError, invalid, maskNumber, normalizeNumber } from './http.ts'

export const ROUTES = {
  official_cloud_api: {
    name: 'Official Cloud API',
    disclosure: 'official-cloud-v1',
    liveBlocker: 'The official adapter is not built, and Meta App Review for this product has not been submitted.',
  },
  unofficial_qr: {
    name: 'Unofficial QR link',
    disclosure: 'unofficial-qr-v1',
    liveBlocker: 'The unofficial gateway adapter is not built.',
  },
} as const
export type Route = keyof typeof ROUTES

const LINK_TTL_SECONDS = 60

export interface Connection {
  id: string
  route: Route
  mode: 'mock' | 'live'
  state: string
  masked_number: string | null
  last_health: string | null
  last_health_at: Date | null
  link_expires_at: Date | null
}
const COLS = 'id, route, mode, state, masked_number, last_health, last_health_at, link_expires_at'
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

export async function createConnection(tx: Tx, body: Record<string, unknown>) {
  const route = body.route as Route
  if (!(route in ROUTES)) throw invalid('route', 'Choose a route.')
  if (body.mode !== 'mock') throw new AppError(409, 'ROUTE_NOT_AVAILABLE', `${ROUTES[route].name} cannot be connected for real yet. ${ROUTES[route].liveBlocker}`)
  if (await currentConnection(tx)) throw new AppError(409, 'ROUTE_ALREADY_OPEN', 'Disconnect the current route before choosing another. Two routes are never open at once.')
  const r = await tx.query<{ id: string }>(`INSERT INTO connections (workspace_id, route, mode) VALUES (app_workspace_id(), $1, 'mock') RETURNING id`, [route])
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
  }
  await move(tx, c, 'pending_auth', `, link_expires_at = now() + interval '${LINK_TTL_SECONDS} seconds'`)
  await audit(tx, 'connection.start', { connection_id: id })
  return load(tx, id)
}

const linkOpen = (c: Connection) => c.state === 'pending_auth' && c.link_expires_at !== null && c.link_expires_at > new Date()

/** Short-lived artifact for the QR route. The mock one is deliberately not a scannable code. */
export async function linkArtifact(tx: Tx, id: string) {
  const c = await load(tx, id)
  if (c.route !== 'unofficial_qr' || c.state !== 'pending_auth') throw new AppError(409, 'INVALID_STATE', 'There is no link code for this connection right now.')
  if (!linkOpen(c)) throw new AppError(410, 'LINK_EXPIRED', 'That code expired. Start again to get a new one.')
  return { mock: true, payload: 'MOCK-CODE-NOT-SCANNABLE', expires_at: c.link_expires_at }
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
  await move(tx, c, canTransition('connection', c.state, 'disconnected') ? 'disconnected' : 'revoked', `, last_health = NULL, link_expires_at = NULL`)
  await audit(tx, 'connection.disconnect', { connection_id: id })
  return c
}
