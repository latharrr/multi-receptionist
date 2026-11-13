// Customer-owned AI provider settings (BYOK). The key is sealed here and only ever opened by the worker.
import { randomUUID } from 'node:crypto'
import { audit, one, type Tx } from '@lathar/database'
import { SUPPORTED_MODELS } from './adapters/anthropic.ts'
import { AppError, invalid, str } from './http.ts'
import { sealSecret } from './secrets.ts'
import { enqueue } from './worker.ts'

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
  // Only providers with a tested adapter can be saved; the rest stay visibly unavailable.
  if (provider !== 'anthropic') throw new AppError(409, 'PROVIDER_NOT_AVAILABLE', `${PROVIDERS[provider]} has no tested adapter yet. Only Claude (Anthropic API) can be used.`)
  if (!SUPPORTED_MODELS.includes(model)) throw invalid('model_id', `Choose one of: ${SUPPORTED_MODELS.join(', ')}. Other models have no checked price, so their cost could not be capped.`)
  const endpoint = null // custom endpoints return with the first adapter that supports one
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
  /** Why the last live check failed, in plain words. */
  last_error: string | null
  key: { masked_label: string; saved_at: Date } | null
  last_test: { mode: string; status: string; at: Date } | null
}

/** Never selects ciphertext; the request role could not read it anyway. */
export async function getConfig(tx: Tx): Promise<AiConfig | null> {
  const r = await tx.query<AiConfig & { masked_label: string | null; saved_at: Date; t_mode: string | null; t_status: string; t_at: Date }>(
    `SELECT c.id, c.provider, c.endpoint, c.model_id, c.revision, c.state, c.last_error, s.masked_label, s.created_at AS saved_at,
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
    id: c.id, provider: c.provider, endpoint: c.endpoint, model_id: c.model_id, revision: c.revision, state: c.state, last_error: c.last_error,
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
  // A new key has not been checked: the config goes back to draft until a live check passes.
  await tx.query(`UPDATE ai_configs SET secret_ref_id = $2, revision = revision + 1, state = 'draft', last_error = NULL WHERE id = $1`, [configId, one(s).id])
  await audit(tx, 'ai_config.secret.save', { ai_config_id: configId })
  return getConfig(tx)
}

export async function deleteSecret(tx: Tx, configId: string) {
  await requireConfig(tx, configId)
  await tx.query('UPDATE secret_refs SET revoked_at = now() WHERE id = (SELECT secret_ref_id FROM ai_configs WHERE id = $1)', [configId])
  await tx.query(`UPDATE ai_configs SET secret_ref_id = NULL, revision = revision + 1, state = 'draft', last_error = NULL WHERE id = $1`, [configId])
  await audit(tx, 'ai_config.secret.delete', { ai_config_id: configId })
  return { removed_here: true, revoked_at_vendor: false }
}

/** Starts a live check of the key and model. The worker does it: it reads model metadata and generates nothing. */
export async function testConfig(tx: Tx, configId: string) {
  const c = await requireConfig(tx, configId)
  if (!c.key) throw new AppError(409, 'KEY_MISSING', 'Save an API key first.')
  await tx.query(`UPDATE ai_configs SET state = 'validating', last_error = NULL WHERE id = $1`, [configId])
  const key = `validate:${configId}:${c.revision}:${randomUUID()}`
  await enqueue(tx, 'validate_ai_config', key, { ai_config_id: configId, user_id: one(await tx.query<{ id: string }>('SELECT app_user_id() AS id')).id })
  await audit(tx, 'ai_config.test', { ai_config_id: configId })
  return key
}
