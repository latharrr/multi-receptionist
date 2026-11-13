// Response schemas for the control API. Every JSON response in the tests is checked against the
// schema for its route; objects are strict, so an unexpected field (a leaked secret, an internal
// column) fails the test. A route with no schema here also fails.
import { z } from 'zod'

const id = z.uuid()
const at = z.iso.datetime()
const role = z.enum(['owner', 'admin', 'support_agent'])
const o = z.strictObject

export const ErrorBody = o({
  error: o({ code: z.string(), message: z.string().min(1), retryable: z.boolean(), request_id: id, field_errors: z.record(z.string(), z.string()).optional() }),
})

const limit = o({
  hard_limit_minor: z.int().nonnegative(), reserved_minor: z.int().nonnegative(), settled_minor: z.int().nonnegative(), currency: z.literal('USD'),
  period: z.literal('month'), period_start: z.iso.date(), resets_on: z.iso.date(),
})
const source = o({ id, duplicate: z.boolean(), facts: z.int(), error_code: z.string().optional() })
const draft = o({
  business_type: z.string().nullable(), type_confirmed: z.boolean(),
  published: o({ sequence: z.int(), approved_at: at }).nullable(),
  conflicts: z.int(), pending: z.int(),
  facts: z.array(o({
    id, field_path: z.string(), value: o({ label: z.string(), text: z.string() }), evidence: z.string().nullable(), review_state: z.string(),
    conflict: z.boolean(), source: z.string().nullable(), diff: z.enum(['unreviewed', 'new', 'published', 'changed']),
  })),
  removed: z.array(o({ path: z.string(), label: z.string(), text: z.string() })),
})
const behaviorVersion = o({ sequence: z.int(), instructions: z.string(), handoff_message: z.string(), enquiry_fields: z.array(z.enum(['name', 'email'])) })
const behavior = o({ published: behaviorVersion, draft: behaviorVersion.nullable() })
// The key itself must never appear: only a masked label.
const aiConfig = o({
  id, provider: z.string(), endpoint: z.string().nullable(), model_id: z.string(), revision: z.int(), state: z.string(),
  key: o({ masked_label: z.string().regex(/^•+.{4}$/), saved_at: at }).nullable(),
  last_test: o({ mode: z.literal('mock'), status: z.string(), at }).nullable(),
})
const connection = o({
  id, route: z.enum(['official_cloud_api', 'unofficial_qr']), mode: z.literal('mock'), state: z.string(),
  masked_number: z.string().regex(/^••• \d{4}$/).nullable(), last_health: z.string().nullable(), last_health_at: at.nullable(), link_expires_at: at.nullable(),
})
const conversation = o({
  id, mode: z.enum(['bot', 'handoff_requested', 'human', 'resolved']), name: z.string().nullable(), number: z.string(), full_number: z.string(),
  connection_id: id, last_message_at: at, preview: z.string().nullable(), handoff_reason: z.string().nullable(),
  notice_state: z.enum(['pending', 'sent', 'failed', 'skipped']).nullable(), notified: z.int(), assigned_to_me: z.boolean(),
})
const message = o({
  id, direction: z.enum(['inbound', 'outbound']), sender: z.enum(['customer', 'bot', 'staff']), body: z.string(), state: z.string(),
  fact_path: z.string().nullable(), error_code: z.string().nullable(), created_at: at,
})
const member = o({ id, email: z.email(), role, status: z.enum(['invited', 'active']), is_me: z.boolean() })
const none = z.null()

export const RESPONSES = {
  'GET /api/v1/workspaces': z.array(o({ id, name: z.string(), state: z.string(), role })),
  'POST /api/v1/workspaces': o({ id }),
  'GET /api/v1/invitations': z.array(o({ id, workspace_name: z.string(), role })),
  'POST /api/v1/invitations/:id/accept': o({ id }),
  'GET /api/v1/operator/diagnostics': o({
    workspaces: o({ total: z.int(), automation_paused: z.int() }),
    workers: z.array(o({ name: z.string(), seconds_ago: z.int() })),
    jobs_open: z.array(o({ kind: z.string(), state: z.string(), n: z.int(), oldest_seconds: z.int() })),
    jobs_completed_24h: z.int(),
    jobs_needing_attention: z.array(o({ id, workspace_id: id, kind: z.string(), state: z.enum(['dead_letter', 'retry_wait', 'lease_expired']), attempts: z.int(), max_attempts: z.int(), error_code: z.string().nullable(), updated_at: z.string() })),
    sends_24h: z.array(o({ state: z.string(), error_code: z.string().nullable(), n: z.int() })),
    connections: z.array(o({ route: z.string(), mode: z.string(), state: z.string(), n: z.int() })),
    staff_notices: z.array(o({ state: z.string(), n: z.int() })),
  }),

  'GET /members': z.array(member),
  'POST /members': o({ id, status: z.literal('invited'), notice: z.enum(['simulated', 'failed']) }),
  'PATCH /members/:id': o({ id, role }),
  'DELETE /members/:id': o({ id, status: z.literal('revoked') }),

  'POST /sources': source,
  'POST /uploads': source,
  'GET /sources': z.array(o({ id, type: z.string(), url: z.string().nullable(), status: z.string(), metadata: z.record(z.string(), z.unknown()), facts: z.int(), created_at: at })),
  'GET /knowledge/draft': draft,
  'PATCH /knowledge/draft': draft,
  'GET /questions/next': o({ id, field_path: z.string(), ask: z.string(), reason: z.string(), remaining: z.int() }).nullable(),
  'POST /questions/:id/answer': none,
  'POST /knowledge/publish': o({ sequence: z.int(), facts: z.int(), left_out: z.int() }),

  'GET /behavior/draft': behavior,
  'PATCH /behavior/draft': behavior,
  'POST /behavior/publish': behavior,

  'GET /ai-configs': z.array(aiConfig),
  'POST /ai-configs': aiConfig,
  'POST /ai-configs/:id/secret': aiConfig,
  'DELETE /ai-configs/:id/secret': o({ removed_here: z.literal(true), revoked_at_vendor: z.literal(false) }),
  'POST /ai-configs/:id/tests': aiConfig,

  'GET /usage': o({
    limit: limit.nullable(), by_category: z.array(o({ category: z.string(), n: z.int(), cost: z.int() })),
    all_estimates: z.literal(true), source: z.literal('mock'), synthetic_cost_minor: z.literal(1),
  }),
  'PATCH /limits': limit,

  'GET /connections': z.array(connection),
  'POST /connections': connection,
  'POST /connections/:id/start': connection,
  'GET /connections/:id/link-artifact': o({ mock: z.literal(true), payload: z.string(), expires_at: at }),
  'POST /connections/:id/mock-link': connection,
  'POST /connections/:id/disconnect': connection,
  'POST /connections/:id/mock-inbound': o({
    duplicate: z.boolean(), replied: z.boolean(), reason: z.string().optional(), conversation_id: id.optional(),
    send: z.string().optional(), state: z.string().optional(),
  }),

  'POST /sample-chats': o({
    mode: z.literal('mock'), question: z.string(), knowledge_sequence: z.int(), outcome: z.enum(['answered', 'handoff']), reply: z.string(),
    fact_path: z.string().optional(), reason: z.string().optional(),
  }),
  'GET /readiness': o({
    can_activate: z.literal(false), blockers: z.array(z.string()).min(1), test_mode_ready: z.boolean(),
    checks: z.array(o({ key: z.string(), title: z.string(), state: z.enum(['done', 'mock', 'blocked', 'todo']), detail: z.string() })),
  }),
  'POST /pause': none,
  'POST /resume-replies': none,

  'GET /conversations': z.array(conversation),
  'GET /conversations/:id/messages': o({ conversation, messages: z.array(message) }),
  'POST /conversations/:id/takeover': none,
  'POST /conversations/:id/reply': o({ message_id: id, duplicate: z.boolean(), send: z.string().optional() }),
  'POST /conversations/:id/resume': none,
  'GET /enquiries': z.array(o({
    id, conversation_id: id, fields: o({ wants: z.string(), name: z.string().optional(), email: z.string().optional() }),
    status: z.enum(['new', 'open', 'closed']), number: z.string(), created_at: at,
  })),
  'PATCH /enquiries/:id': none,
} as const

type Key = keyof typeof RESPONSES
// '/connections/:id/start' -> `/connections/${string}/start`
type Pattern<S extends string> = S extends `${infer A}:${string}/${infer B}` ? `${A}${string}/${Pattern<B>}` : S extends `${infer A}:${string}` ? `${A}${string}` : S
type Find<M extends string, P extends string> = { [K in Key]: K extends `${infer KM} ${infer KP}` ? (M extends KM ? (P extends `${string}${Pattern<KP>}` ? K : never) : never) : never }[Key]
/** The response type for a method and path, worked out from the template the test wrote. */
export type DataOf<M extends string, P extends string> = [Find<M, P>] extends [never] ? unknown : z.infer<(typeof RESPONSES)[Find<M, P>]>

const matchers = (Object.keys(RESPONSES) as Key[]).map((key) => {
  const [method = '', path = ''] = key.split(' ')
  const body = path.replace(/:\w+/g, '[^/]+')
  return { key, method, re: new RegExp(path.startsWith('/api/') ? `^${body}$` : `^/api/v1/workspaces/[0-9a-f-]{36}${body}$`) }
})

/** Throws unless the body matches its route's schema (2xx) or the error envelope (anything else). */
export function validate(method: string, path: string, status: number, json: unknown): void {
  const route = path.split('?')[0] ?? path
  if (status >= 300) return void z.parse(ErrorBody, json, { reportInput: true })
  const m = matchers.find((x) => x.method === method && x.re.test(route))
  if (!m) throw new Error(`No response schema for ${method} ${route}`)
  const r = o({ data: RESPONSES[m.key] }).safeParse(json)
  if (!r.success) throw new Error(`${method} ${route} did not match its response schema:\n${z.prettifyError(r.error)}`)
}
