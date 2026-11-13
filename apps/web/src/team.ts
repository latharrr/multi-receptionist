// Team roles: invite, change role, remove. Capability `member.manage` is checked at the route;
// the rules here decide who may manage whom. Invitation emails are SIMULATED (local mailbox).
import type { Role } from '@lathar/contracts'
import { audit, type Tx, type WorkspaceContext } from '@lathar/database'
import { AppError, invalid } from './http.ts'
import type { Notifier } from './worker.ts'

export const ROLE_NAMES: Record<Role, string> = { owner: 'Owner', admin: 'Admin', support_agent: 'Support agent' }
export const ROLE_CAN: Record<Role, string> = {
  owner: 'Everything, including publishing, API keys, WhatsApp, the spending limit and the team.',
  admin: 'Edit knowledge drafts, reply to customers, and invite or remove support agents. Cannot publish, change keys, WhatsApp or the spending limit.',
  support_agent: 'Reply to customers, take over and hand back chats, pause automation, and suggest knowledge changes.',
}

/** Owners manage admins and agents. Admins manage agents only. Nobody manages an owner. */
export const canManage = (actor: Role, target: string) => target !== 'owner' && (actor === 'owner' || (actor === 'admin' && target === 'support_agent'))

export interface Member {
  id: string
  email: string
  role: Role
  status: 'invited' | 'active' | 'revoked'
  is_me: boolean
}
// The workspace filter is explicit: row-level security also lets a user see their own
// memberships elsewhere, and those must not appear in this list.
export const listMembers = async (tx: Tx) =>
  (await tx.query<Member>(
    `SELECT m.id, u.email, m.role, m.status, (m.user_id = app_user_id()) AS is_me
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = app_workspace_id() AND m.status <> 'revoked'
     ORDER BY (m.role = 'owner') DESC, m.created_at`)).rows

const role = (body: Record<string, unknown>): 'admin' | 'support_agent' => {
  if (body.role !== 'admin' && body.role !== 'support_agent') throw invalid('role', 'Choose a role.')
  return body.role
}
const FORBIDDEN = new AppError(403, 'FORBIDDEN', 'Your role does not allow this for that person.')

export async function invite(tx: Tx, w: WorkspaceContext, notifier: Notifier, baseUrl: string, body: Record<string, unknown>) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw invalid('email', 'Enter an email address.')
  const as = role(body)
  if (!canManage(w.role, as)) throw FORBIDDEN
  const id = (await tx.query<{ id: string | null }>('SELECT invite_member($1, $2) AS id', [email, as])).rows[0]?.id
  if (!id) throw new AppError(409, 'ALREADY_MEMBER', 'That person is already on the team or already invited.')
  await audit(tx, 'member.invite', { membership_id: id })
  const name = (await tx.query<{ name: string }>('SELECT name FROM workspaces WHERE id = app_workspace_id()')).rows[0]?.name ?? ''
  // The invitation stands even if the notice fails; they will see it after signing in.
  const told = await notifier
    .send({ to: email, subject: `You’ve been invited to ${name}`, body: `You’ve been invited to join ${name} as ${ROLE_NAMES[as].toLowerCase()}. Sign in with this email address to accept.\n${baseUrl}/signin` })
    .then(() => true, () => false)
  return { id, status: 'invited' as const, notice: told ? ('simulated' as const) : ('failed' as const) }
}

async function target(tx: Tx, w: WorkspaceContext, id: string) {
  const m = (await tx.query<{ role: Role; is_me: boolean; user_id: string }>(
    `SELECT role, (user_id = app_user_id()) AS is_me, user_id FROM memberships WHERE id = $1 AND workspace_id = app_workspace_id() AND status <> 'revoked' FOR UPDATE`, [id])).rows[0]
  if (!m) throw new AppError(404, 'NOT_FOUND', 'Not found.')
  if (m.is_me || !canManage(w.role, m.role)) throw FORBIDDEN
  return m
}
// Delegated permissions belong to a role; they never survive a role change or removal.
const dropGrants = (tx: Tx, userId: string) => tx.query('UPDATE permission_grants SET revoked_at = now() WHERE grantee_user_id = $1 AND revoked_at IS NULL', [userId])

export async function setRole(tx: Tx, w: WorkspaceContext, id: string, body: Record<string, unknown>) {
  const to = role(body)
  const m = await target(tx, w, id)
  if (!canManage(w.role, to)) throw FORBIDDEN
  await tx.query('UPDATE memberships SET role = $2 WHERE id = $1', [id, to])
  await dropGrants(tx, m.user_id)
  await audit(tx, 'member.role', { membership_id: id })
  return { id, role: to }
}

/** Takes effect on the person's next request: every request re-reads the membership. */
export async function removeMember(tx: Tx, w: WorkspaceContext, id: string) {
  const m = await target(tx, w, id)
  await tx.query(`UPDATE memberships SET status = 'revoked' WHERE id = $1`, [id])
  await dropGrants(tx, m.user_id)
  await tx.query('UPDATE conversations SET assigned_user_id = NULL WHERE assigned_user_id = $1', [m.user_id])
  await audit(tx, 'member.remove', { membership_id: id })
  return { id, status: 'revoked' as const }
}
