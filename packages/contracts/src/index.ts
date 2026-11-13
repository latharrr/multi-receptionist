// Internal product contracts (spec §4, §6, §8). These are not vendor API shapes.

// §8 error envelope.
export interface ApiError {
  code: string
  message: string
  retryable: boolean
  request_id: string
  field_errors?: Record<string, string>
}

// --- §4 permissions ---------------------------------------------------------

export type Role = 'owner' | 'admin' | 'support_agent'

export const CAPABILITIES = [
  'knowledge.edit',
  'knowledge.propose',
  'knowledge.publish',
  'workspace.activate',
  'connection.manage',
  'secret.manage',
  'conversation.reply',
  'member.manage',
  'limits.lower',
  'workspace.export',
  'workspace.close',
] as const
export type Capability = (typeof CAPABILITIES)[number]

const ROLE_DEFAULTS: Record<Role, readonly Capability[]> = {
  owner: CAPABILITIES,
  admin: ['knowledge.edit', 'knowledge.propose', 'conversation.reply', 'member.manage'],
  support_agent: ['knowledge.propose', 'conversation.reply'],
}

// Only admins can hold delegated grants, and only for these. Export/close stay owner-only.
export const DELEGABLE: readonly Capability[] = [
  'knowledge.publish',
  'workspace.activate',
  'connection.manage',
  'secret.manage',
]

export function can(role: Role, activeGrants: readonly string[], capability: Capability): boolean {
  return (
    ROLE_DEFAULTS[role].includes(capability) ||
    (role === 'admin' && DELEGABLE.includes(capability) && activeGrants.includes(capability))
  )
}

// --- §6 state machines ------------------------------------------------------
// Edges marked "assumed" are not drawn in the spec diagram but are needed for the
// described behavior (resume, reconnect, retest). Review before relying on them.

export const MACHINES = {
  workspace: {
    draft: ['configuring'],
    configuring: ['testing'],
    testing: ['ready', 'configuring'], // back-edge assumed
    ready: ['active', 'configuring'], // back-edge assumed
    active: ['paused', 'suspended', 'closing'],
    paused: ['active', 'closing'], // assumed
    suspended: ['paused', 'closing'], // assumed
    closing: [],
  },
  connection: {
    unconfigured: ['pending_auth', 'revoked'], // revoked assumed: owner cancels before starting
    pending_auth: ['pending_auth', 'connecting', 'needs_action', 'revoked'], // self-edge assumed: refresh an expired link
    connecting: ['connected', 'needs_action', 'disconnected', 'revoked'],
    connected: ['needs_action', 'disconnected', 'revoked'],
    needs_action: ['pending_auth', 'connecting', 'connected', 'disconnected', 'revoked'], // assumed
    disconnected: ['pending_auth', 'revoked'], // assumed
    revoked: [],
  },
  // Also used for behavior versions.
  knowledge: {
    draft: ['approved'],
    approved: ['published'],
    published: ['superseded'],
    superseded: [],
  },
  aiConfig: {
    draft: ['validating', 'revoked'], // revoked assumed: replaced before validation
    validating: ['valid', 'invalid'],
    valid: ['active', 'revoked'],
    active: ['revoked'],
    invalid: ['validating'], // assumed
    revoked: [],
  },
  conversation: {
    bot: ['handoff_requested', 'human'], // direct takeover per §8
    handoff_requested: ['human', 'resolved', 'bot'], // bot: staff approved the assistant's draft
    human: ['bot', 'resolved'], // explicit resume per §8
    resolved: ['bot'], // assumed: new inbound reopens
  },
  job: {
    queued: ['leased'],
    leased: ['complete', 'retry_wait', 'dead_letter', 'leased'], // leased->leased: expired-lease recovery
    retry_wait: ['leased'],
    complete: [],
    dead_letter: [],
  },
} as const satisfies Record<string, Record<string, readonly string[]>>

export type Machine = keyof typeof MACHINES

export function canTransition(machine: Machine, from: string, to: string): boolean {
  const edges = (MACHINES[machine] as Record<string, readonly string[]>)[from]
  return edges?.includes(to) ?? false
}

// Message state is reduced from provider events that may skip or reorder, so it is a
// ranking, not an edge list.
const DELIVERY = ['received', 'queued', 'generated', 'reserved', 'submitting', 'accepted', 'delivered', 'read'] as const
export type MessageState = (typeof DELIVERY)[number] | 'failed' | 'uncertain'

export function reduceMessageState(current: MessageState, incoming: MessageState): MessageState {
  const rank = (s: MessageState) => DELIVERY.indexOf(s as (typeof DELIVERY)[number])
  const c = rank(current)
  const i = rank(incoming)
  const accepted = rank('accepted')
  // failed/uncertain never overwrite proven delivery.
  if (i === -1) return c > accepted ? current : incoming
  // failed/uncertain is only resolved by provider evidence, never by local requeue.
  if (c === -1) return i >= accepted ? incoming : current
  return i > c ? incoming : current
}
