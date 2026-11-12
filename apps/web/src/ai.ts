// Customer-owned AI provider settings. No live adapter exists yet: nothing here calls a vendor.
import { audit, one, type Tx } from '@lathar/database'
import { publishedBehavior } from './assistant.ts'
import { AppError, checkPublicHttpsUrl, invalid, str } from './http.ts'
import type { Knowledge } from './knowledge.ts'
import { sealSecret } from './secrets.ts'
import { reserve, settle } from './usage.ts'

export const PROVIDERS = {
  anthropic: 'Claude (Anthropic API)',
  groq: 'Groq',
  nvidia: 'NVIDIA',
  custom: 'Custom compatible API',
} as const
export type Provider = keyof typeof PROVIDERS

async function revokeCurrent(tx: Tx) {
  await tx.query(
    `UPDATE secret_refs SET revoked_at = now() WHERE revoked_at IS NULL
       AND id IN (SELECT secret_ref_id FROM ai_configs WHERE state <> 'revoked')`,
  )
  await tx.query(`UPDATE ai_configs SET state = 'revoked', secret_ref_id = NULL WHERE state <> 'revoked'`)
}

/** Saving a provider always starts a new config, so a key is never carried to a new destination. */
export async function saveConfig(tx: Tx, body: unknown) {
  const provider = str(body, 'provider', 20) as Provider
  if (!(provider in PROVIDERS)) throw invalid('provider', 'Choose one of the listed providers.')
  const model = str(body, 'model_id', 200)
  if (!/^[\w.:/@-]+$/.test(model)) throw invalid('model_id', 'Use the model ID exactly as the provider writes it.')
  const endpoint = provider === 'custom' ? checkPublicHttpsUrl(str(body, 'endpoint', 500), 'endpoint', true).href : null
  await revokeCurrent(tx)
  const r = await tx.query<{ id: string }>(
    `INSERT INTO ai_configs (workspace_id, provider, endpoint, model_id) VALUES (app_workspace_id(), $1, $2, $3) RETURNING id`,
    [provider, endpoint, model],
  )
  await audit(tx, 'ai_config.save', { ai_config_id: one(r).id })
  return getConfig(tx)
}

export interface AiConfig {
  id: string
  provider: Provider
  endpoint: string | null
  model_id: string
  revision: number
  state: string
  key: { masked_label: string; saved_at: Date } | null
  last_test: { mode: string; status: string; at: Date } | null
}

/** Never selects ciphertext; the request role could not read it anyway. */
export async function getConfig(tx: Tx): Promise<AiConfig | null> {
  const r = await tx.query<AiConfig & { masked_label: string | null; saved_at: Date; t_mode: string | null; t_status: string; t_at: Date }>(
    `SELECT c.id, c.provider, c.endpoint, c.model_id, c.revision, c.state, s.masked_label, s.created_at AS saved_at,
            t.mode AS t_mode, t.status AS t_status, t.created_at AS t_at
     FROM ai_configs c
     LEFT JOIN secret_refs s ON s.id = c.secret_ref_id AND s.workspace_id = c.workspace_id AND s.revoked_at IS NULL
     LEFT JOIN LATERAL (SELECT mode, status, created_at FROM test_runs
                        WHERE ai_config_id = c.id AND ai_config_revision = c.revision AND type = 'ai_config'
                        ORDER BY created_at DESC LIMIT 1) t ON true
     WHERE c.state <> 'revoked'`,
  )
  const c = r.rows[0]
  if (!c) return null
  return {
    id: c.id, provider: c.provider, endpoint: c.endpoint, model_id: c.model_id, revision: c.revision, state: c.state,
    key: c.masked_label ? { masked_label: c.masked_label, saved_at: c.saved_at } : null,
    last_test: c.t_mode ? { mode: c.t_mode, status: c.t_status, at: c.t_at } : null,
  }
}

async function requireConfig(tx: Tx, id: string) {
  const c = await getConfig(tx)
  if (!c || c.id !== id) throw new AppError(404, 'NOT_FOUND', 'Not found.')
  return c
}

export async function saveSecret(tx: Tx, master: Buffer, configId: string, body: unknown) {
  const c = await requireConfig(tx, configId)
  const key = str(body, 'api_key', 500, 8)
  if (/\s/.test(key)) throw invalid('api_key', 'Paste the key without spaces or line breaks.')
  const ws = one(await tx.query<{ id: string }>('SELECT app_workspace_id() AS id')).id
  await tx.query('UPDATE secret_refs SET revoked_at = now(), rotated_at = now() WHERE id = (SELECT secret_ref_id FROM ai_configs WHERE id = $1)', [configId])
  const s = await tx.query<{ id: string }>(
    `INSERT INTO secret_refs (workspace_id, kind, ciphertext, key_version, masked_label)
     VALUES (app_workspace_id(), 'ai_api_key', $1, 'local-1', $2) RETURNING id`,
    [sealSecret(master, `${ws}:ai_api_key:${c.provider}:${c.endpoint ?? ''}`, key), `••••••••${key.slice(-4)}`],
  )
  await tx.query('UPDATE ai_configs SET secret_ref_id = $2, revision = revision + 1 WHERE id = $1', [configId, one(s).id])
  await audit(tx, 'ai_config.secret.save', { ai_config_id: configId })
  return getConfig(tx)
}

export async function deleteSecret(tx: Tx, configId: string) {
  await requireConfig(tx, configId)
  await tx.query('UPDATE secret_refs SET revoked_at = now() WHERE id = (SELECT secret_ref_id FROM ai_configs WHERE id = $1)', [configId])
  await tx.query('UPDATE ai_configs SET secret_ref_id = NULL, revision = revision + 1 WHERE id = $1', [configId])
  await audit(tx, 'ai_config.secret.delete', { ai_config_id: configId })
  return { removed_here: true, revoked_at_vendor: false }
}

export async function testConfig(tx: Tx, configId: string, mode: unknown) {
  const c = await requireConfig(tx, configId)
  if (mode !== 'mock')
    throw new AppError(409, 'LIVE_TEST_NOT_AVAILABLE', `A live check of ${PROVIDERS[c.provider]} is not built yet. Nothing was sent and nothing was charged.`)
  if (!c.key) throw new AppError(409, 'KEY_MISSING', 'Save an API key first.')
  await tx.query(
    `INSERT INTO test_runs (workspace_id, type, ai_config_id, ai_config_revision, mode, status, results)
     VALUES (app_workspace_id(), 'ai_config', $1, $2, 'mock', 'passed', '{"checked":"saved settings only; no request left this machine"}')`,
    [configId, c.revision],
  )
  return getConfig(tx)
}

// ---------------------------------------------------------------- mock generation

export type Generated = { kind: 'answer'; text: string; factPath: string } | { kind: 'handoff'; reason: string }
export interface AiAdapter {
  generate(req: { knowledge: Knowledge; message: string }): Promise<Generated>
}

const STOP = new Set('the and you your are for can what when where how much does have with this that from about who why our get any please there their they them was will would could should'.split(' '))
const HINTS: [RegExp, string][] = [
  [/\b(open|opening|close|closing|closed|hours|times?|today|tomorrow|sundays?|saturdays?|weekends?)\b/, 'hours'],
  [/\b(where|address|located|location|directions?|find you)\b/, 'address'],
  [/\b(price|prices|cost|costs|fee|fees|how much|charge|rates?)\b/, 'prices'],
  [/\b(phone|call|ring|telephone)\b/, 'phone'],
  [/\b(email|e-mail)\b/, 'email'],
  [/\b(services?|offer|provide|sell|menu)\b/, 'services'],
]
const words = (s: string) => s.toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((w) => !STOP.has(w)) ?? []

/**
 * MOCK: keyword lookup over the published facts. It answers only with a published fact's own
 * text and hands off everything else, so it can never invent a price or follow an instruction.
 */
export const mockAi: AiAdapter = {
  async generate({ knowledge, message }) {
    const m = message.toLowerCase()
    if (/\b(human|person|someone|somebody|staff|agent|manager|speak to|talk to|call me)\b/.test(m)) return { kind: 'handoff', reason: 'Customer asked for a person' }
    const asked = words(m)
    let best: { score: number; fact: Knowledge['facts'][number] } | null = null
    for (const fact of knowledge.facts) {
      const label = words(fact.label)
      let score = label.length ? asked.filter((w) => label.includes(w)).length / label.length : 0
      if (HINTS.some(([re, path]) => path === fact.path && re.test(m))) score = 1
      if (score >= 0.5 && score > (best?.score ?? 0)) best = { score, fact }
    }
    if (!best) return { kind: 'handoff', reason: 'Not covered by published facts' }
    return { kind: 'answer', text: best.fact.text.slice(0, 280), factPath: best.fact.path }
  },
}

/** Stateless sample chat against the published versions. Always mock; recorded as a mock test run. */
export async function sampleChat(tx: Tx, ai: AiAdapter, knowledge: { id: string; sequence: number; content: Knowledge }, message: string) {
  const budget = await reserve(tx)
  if (budget !== 'ok')
    throw new AppError(409, budget.toUpperCase(), budget === 'no_spending_limit' ? 'Set a spending limit first. The assistant does not generate anything without one.' : 'The spending limit has been reached, so nothing was generated.')
  const g = await ai.generate({ knowledge: knowledge.content, message })
  const behavior = await publishedBehavior(tx)
  const result = { question: message, knowledge_sequence: knowledge.sequence, ...(g.kind === 'answer' ? { outcome: 'answered', reply: g.text, fact_path: g.factPath } : { outcome: 'handoff', reply: behavior.handoff_message, reason: g.reason }) }
  const run = await tx.query<{ id: string }>(
    `INSERT INTO test_runs (workspace_id, type, knowledge_version_id, mode, status, results)
     VALUES (app_workspace_id(), 'sample_chat', $1, 'mock', 'passed', $2) RETURNING id`,
    [knowledge.id, JSON.stringify(result)],
  )
  await settle(tx, 'test_chat', `test:${one(run).id}`)
  return { mode: 'mock', ...result }
}
