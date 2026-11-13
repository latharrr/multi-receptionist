// Business inputs -> draft facts -> one question at a time -> reviewed, published version.
// Extraction here is a deterministic MOCK (no AI call). It only lifts what the text states.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canTransition } from '@lathar/contracts'
import { audit, one, type Tx } from '@lathar/database'
import { AppError, checkPublicHttpsUrl, invalid } from './http.ts'

export const LIMITS = { bytes: 2 * 1024 * 1024, urls: 10, files: 10 }
export const EXTRACTION_VERSION = 'mock-rules-1'

const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex')
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60)
const same = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ')

const ALIASES: [RegExp, string, string][] = [
  [/^(business |company |shop |clinic )?name$/, 'name', 'Business name'],
  [/^((opening|business|working|open) )?(hours|times|timings?)$/, 'hours', 'Opening hours'],
  [/^(address|location|where( we are| to find us)?)$/, 'address', 'Address'],
  [/^(phone|telephone|tel|phone number|call us)$/, 'phone', 'Phone'],
  [/^(e-?mail|email address)$/, 'email', 'Email'],
  [/^(prices?|pricing|fees?|rates?|cost)$/, 'prices', 'Prices'],
  [/^(services|what we (do|offer)|products|menu)$/, 'services', 'What you offer'],
]
const pathFor = (label: string) => {
  const a = ALIASES.find(([re]) => re.test(label.toLowerCase()))
  return a ? { path: a[1], label: a[2] } : { path: slug(label), label: label.slice(0, 120) }
}

export interface Extracted {
  path: string
  label: string
  text: string
  evidence: string
}

export function extractFacts(text: string): Extracted[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  const out: Extracted[] = []
  const add = (rawLabel: string, value: string, line: number, faq = false) => {
    const clean = rawLabel.replace(/[*_#`]/g, '').trim()
    const { path, label } = faq ? { path: `faq.${slug(clean)}`, label: clean.slice(0, 160) } : pathFor(clean)
    if (!slug(clean) || !value.trim()) return
    out.push({ path, label, text: value.trim().slice(0, 600), evidence: `Line ${line + 1}: ${(lines[line] ?? '').slice(0, 160)}` })
  }
  const special = (l: string) => /^#{1,6}\s/.test(l) || /^(q|question|a|answer)\s*[:.)]/i.test(l) || /^[-*]?\s*[^:]{2,40}:\s+\S/.test(l) || l.endsWith('?')
  const next = (i: number) => {
    let j = i + 1
    while (j < lines.length && !lines[j]) j++
    return j
  }
  const line = (i: number) => lines[i] ?? ''
  for (let i = 0; i < lines.length; i++) {
    const q = /^(?:q|question)\s*[:.)]\s*(.+)$/i.exec(line(i))
    const heading = /^#{1,6}\s+(.+)$/.exec(line(i))
    const pair = /^[-*]?\s*([^:]{2,40}):\s+(.+)$/.exec(line(i))
    if (q) {
      const j = next(i)
      const a = /^(?:a|answer)\s*[:.)]\s*(.+)$/i.exec(line(j))
      if (a) {
        add(q[1] ?? '', a[1] ?? '', i, true)
        i = j
      }
    } else if (heading) {
      const body: string[] = []
      let j = next(i)
      while (line(j) && !special(line(j))) body.push(line(j++).replace(/^[-*]\s+/, ''))
      if (body.length) {
        add(heading[1] ?? '', body.join(' '), i)
        i = j - 1
      } else if (line(i).startsWith('# ')) add('Business name', heading[1] ?? '', i)
    } else if (line(i).endsWith('?') && line(i).length < 200) {
      const j = next(i)
      if (line(j) && !special(line(j))) {
        add(line(i), line(j), i, true)
        i = j
      }
    } else if (pair && !/^https?$/i.test(pair[1] ?? '')) {
      add(pair[1] ?? '', pair[2] ?? '', i)
    }
  }
  return out
}

const TYPES: [string, RegExp][] = [
  ['Dental clinic', /\b(dentist|dental|orthodont\w*)\b/gi],
  ['Medical clinic', /\b(clinic|doctor|patients?|physio\w*)\b/gi],
  ['Restaurant or café', /\b(menu|restaurant|caf[eé]|dine|reservations?)\b/gi],
  ['Salon or spa', /\b(salon|haircut|hair|spa|beauty|nails)\b/gi],
  ['Shop', /\b(shop|store|in stock|delivery|returns?)\b/gi],
  ['Gym or studio', /\b(gym|fitness|classes|yoga|membership)\b/gi],
]
/** A draft guess the owner can correct; null when the text gives no signal. */
export function inferType(text: string): string | null {
  const [best] = TYPES.map(([t, re]) => [t, text.match(re)?.length ?? 0] as const).sort((a, b) => b[1] - a[1])
  return best && best[1] > 0 ? best[0] : null
}

export interface NewSource {
  type: 'text' | 'faq' | 'file' | 'url'
  bytes?: Uint8Array
  url?: string
  filename?: string
}

export async function addSource(tx: Tx, storageDir: string, src: NewSource) {
  if (src.type === 'url') {
    const url = checkPublicHttpsUrl(src.url ?? '', 'url').href
    const existing = await tx.query<{ id: string }>('SELECT id FROM sources WHERE url = $1', [url])
    if (existing.rows[0]) return { id: existing.rows[0].id, duplicate: true, facts: 0 }
    const n = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM sources WHERE type = 'url'`)
    if (one(n).n >= LIMITS.urls) throw invalid('url', `Up to ${LIMITS.urls} addresses can be added.`)
    // No fetcher exists yet, so the page is recorded as not imported rather than faked.
    const r = await tx.query<{ id: string }>(
      `INSERT INTO sources (workspace_id, type, url, status, metadata)
       VALUES (app_workspace_id(), 'url', $1, 'failed', '{"error_code":"URL_IMPORT_NOT_BUILT"}') RETURNING id`,
      [url],
    )
    await touchWorkspace(tx)
    return { id: one(r).id, duplicate: false, facts: 0, error_code: 'URL_IMPORT_NOT_BUILT' }
  }

  const bytes = src.bytes ?? new Uint8Array()
  if (bytes.length === 0) throw invalid('text', 'Add some text first.')
  if (bytes.length > LIMITS.bytes) throw new AppError(413, 'TOO_LARGE', 'That is larger than the 2 MB limit.')
  if (bytes.includes(0)) throw invalid('file', 'That file is not plain text.')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw invalid('file', 'That file is not UTF-8 text.')
  }

  const hash = sha(bytes)
  const dup = await tx.query<{ id: string }>('SELECT id FROM sources WHERE content_hash = $1', [hash])
  if (dup.rows[0]) return { id: dup.rows[0].id, duplicate: true, facts: 0 }

  const ws = one(await tx.query<{ id: string }>('SELECT app_workspace_id() AS id')).id
  await mkdir(join(storageDir, ws), { recursive: true, mode: 0o700 })
  await writeFile(join(storageDir, ws, hash), bytes, { mode: 0o600 })

  const source = await tx.query<{ id: string }>(
    `INSERT INTO sources (workspace_id, type, object_key, status, content_hash, imported_at, metadata)
     VALUES (app_workspace_id(), $1, $2, 'imported', $3, now(), $4) RETURNING id`,
    [src.type, `${ws}/${hash}`, hash, JSON.stringify({ filename: src.filename ?? null, bytes: bytes.length })],
  )
  const sourceId = one(source).id
  await tx.query(
    `INSERT INTO import_jobs (workspace_id, source_id, status, attempt_count, extraction_version)
     VALUES (app_workspace_id(), $1, 'complete', 1, $2)`,
    [sourceId, EXTRACTION_VERSION],
  )

  let added = 0
  for (const f of extractFacts(text)) {
    const existing = await tx.query<{ id: string; value: { text: string }; conflict_group: string | null }>(
      `SELECT id, value, conflict_group FROM fact_drafts WHERE field_path = $1 AND review_state <> 'rejected'`,
      [f.path],
    )
    if (existing.rows.some((e) => same(e.value.text, f.text))) continue
    let group: string | null = null
    if (existing.rows.length) {
      // Two sources disagree: both go back to review and publishing is blocked until one is chosen.
      group = one(existing).conflict_group ?? randomUUID()
      await tx.query(`UPDATE fact_drafts SET conflict_group = $1, review_state = 'pending' WHERE field_path = $2 AND review_state <> 'rejected'`, [group, f.path])
    }
    await tx.query(
      `INSERT INTO fact_drafts (workspace_id, source_id, field_path, value, evidence, confidence, conflict_group)
       VALUES (app_workspace_id(), $1, $2, $3, $4, 'medium', $5)`,
      [sourceId, f.path, JSON.stringify({ label: f.label, text: f.text }), f.evidence, group],
    )
    added++
  }

  await tx.query(
    `INSERT INTO business_profiles (workspace_id, draft_type) VALUES (app_workspace_id(), $1)
     ON CONFLICT (workspace_id) DO UPDATE SET draft_type = COALESCE(business_profiles.draft_type, EXCLUDED.draft_type)`,
    [inferType(text)],
  )
  await touchWorkspace(tx)
  return { id: sourceId, duplicate: false, facts: added }
}

async function touchWorkspace(tx: Tx) {
  await tx.query(`UPDATE workspaces SET state = 'configuring' WHERE id = app_workspace_id() AND state = 'draft'`)
}

export async function listSources(tx: Tx) {
  return (
    await tx.query<{ id: string; type: string; url: string | null; status: string; metadata: { filename?: string; bytes?: number; error_code?: string }; facts: number; created_at: Date }>(
      `SELECT s.id, s.type, s.url, s.status, s.metadata, s.created_at,
              (SELECT count(*)::int FROM fact_drafts f WHERE f.source_id = s.id) AS facts
       FROM sources s ORDER BY s.created_at`,
    )
  ).rows
}

// ---------------------------------------------------------------- questions

const QUESTIONS = [
  { path: 'hours', label: 'Opening hours', ask: 'What are your opening hours?', reason: 'This is what customers ask most. Without it, every question about hours goes to your staff.' },
  { path: 'services', label: 'What you offer', ask: 'What do you offer, in a sentence or two?', reason: 'Lets the assistant say whether you can help before taking an enquiry.' },
  { path: 'address', label: 'Address', ask: 'Where can customers find you?', reason: 'Customers ask for directions. Skip this if you have no premises.' },
  { path: 'phone', label: 'Phone', ask: 'Which phone number should customers call?', reason: 'Given only when a customer asks how to call you.' },
  { path: 'prices', label: 'Prices', ask: 'Which prices are you happy for the assistant to quote?', reason: 'The assistant never guesses a price. Skip this and price questions go to staff.' },
]

export interface Question {
  id: string
  field_path: string
  ask: string
  reason: string
  remaining: number
}

/** The next useful unanswered question, or null. Only ever one active prompt (schema-enforced). */
export async function nextQuestion(tx: Tx): Promise<Question | null> {
  const hasSource = await tx.query('SELECT 1 FROM sources LIMIT 1')
  if (!hasSource.rows[0]) return null
  for (const [priority, q] of QUESTIONS.entries())
    await tx.query(
      `INSERT INTO clarification_questions (workspace_id, field_path, reason, priority, optional)
       VALUES (app_workspace_id(), $1, $2, $3, true) ON CONFLICT (workspace_id, field_path) DO NOTHING`,
      [q.path, q.reason, priority],
    )
  // A later import may have answered a question; never ask for something already known.
  await tx.query(
    `UPDATE clarification_questions q SET state = 'answered'
     WHERE state IN ('pending', 'active')
       AND EXISTS (SELECT 1 FROM fact_drafts f WHERE f.field_path = q.field_path AND f.review_state <> 'rejected')`,
  )
  let active = await tx.query<{ id: string; field_path: string }>(`SELECT id, field_path FROM clarification_questions WHERE state = 'active'`)
  if (!active.rows[0])
    active = await tx.query(
      `UPDATE clarification_questions SET state = 'active'
       WHERE id = (SELECT id FROM clarification_questions WHERE state = 'pending' ORDER BY priority LIMIT 1)
       RETURNING id, field_path`,
    )
  const row = active.rows[0]
  if (!row) return null
  const def = QUESTIONS.find((q) => q.path === row.field_path)
  if (!def) return null
  const left = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM clarification_questions WHERE state IN ('pending', 'active')`)
  return { id: row.id, field_path: row.field_path, ask: def.ask, reason: def.reason, remaining: one(left).n }
}

export async function answerQuestion(tx: Tx, id: string, answer: string | null) {
  const q = await tx.query<{ field_path: string }>(
    `UPDATE clarification_questions SET state = $2, answer = $3 WHERE id = $1 AND state = 'active' RETURNING field_path`,
    [id, answer ? 'answered' : 'skipped', answer ? JSON.stringify(answer) : null],
  )
  if (!q.rows[0]) throw new AppError(409, 'QUESTION_NOT_ACTIVE', 'That question has already been answered or skipped.')
  if (!answer) return // skipped: the fact stays unknown
  const def = QUESTIONS.find((d) => d.path === q.rows[0]?.field_path)
  if (!def) return
  await tx.query(
    `INSERT INTO fact_drafts (workspace_id, field_path, value, evidence, confidence, review_state)
     VALUES (app_workspace_id(), $1, $2, 'Answered by you during setup', 'high', 'accepted')`,
    [def.path, JSON.stringify({ label: def.label, text: answer.slice(0, 600) })],
  )
}

// ---------------------------------------------------------------- review & publish

export interface Knowledge {
  business_type: string | null
  facts: { path: string; label: string; text: string }[]
}
export interface Published {
  id: string
  sequence: number
  content: Knowledge
  approved_at: Date
}

export async function published(tx: Tx): Promise<Published | null> {
  const r = await tx.query<Published>(`SELECT id, sequence, content, approved_at FROM knowledge_versions WHERE status = 'published'`)
  return r.rows[0] ?? null
}

const CONFLICTED = `conflict_group IN (SELECT conflict_group FROM fact_drafts
  WHERE review_state <> 'rejected' AND conflict_group IS NOT NULL GROUP BY conflict_group HAVING count(*) > 1)`

export async function getDraft(tx: Tx) {
  const facts = (
    await tx.query<{ id: string; field_path: string; value: { label: string; text: string }; evidence: string | null; review_state: string; conflict: boolean; source: string | null }>(
      `SELECT f.id, f.field_path, f.value, f.evidence, f.review_state,
              COALESCE(f.review_state <> 'rejected' AND f.${CONFLICTED}, false) AS conflict,
              CASE WHEN s.id IS NULL THEN NULL ELSE COALESCE(s.metadata->>'filename', s.url, CASE s.type WHEN 'faq' THEN 'Pasted FAQs' ELSE 'Pasted text' END) END AS source
       FROM fact_drafts f LEFT JOIN sources s ON s.id = f.source_id AND s.workspace_id = f.workspace_id
       WHERE f.review_state <> 'rejected' ORDER BY f.field_path, f.created_at`,
    )
  ).rows
  const profile = (await tx.query<{ draft_type: string | null; confirmed_type: string | null }>('SELECT draft_type, confirmed_type FROM business_profiles')).rows[0]
  const pub = await published(tx)
  const live = new Map(pub?.content.facts.map((f) => [f.path, f.text]))
  return {
    business_type: profile?.confirmed_type ?? profile?.draft_type ?? null,
    type_confirmed: Boolean(profile?.confirmed_type),
    published: pub && { sequence: pub.sequence, approved_at: pub.approved_at },
    conflicts: facts.filter((f) => f.conflict).length,
    pending: facts.filter((f) => f.review_state === 'pending' && !f.conflict).length,
    facts: facts.map((f) => ({
      ...f,
      // Draft vs published, per fact.
      diff: !['accepted', 'edited'].includes(f.review_state) ? 'unreviewed' : !live.has(f.field_path) ? 'new' : live.get(f.field_path) === f.value.text ? 'published' : 'changed',
    })),
    removed: pub?.content.facts.filter((p) => !facts.some((f) => f.field_path === p.path && ['accepted', 'edited'].includes(f.review_state))) ?? [],
  }
}

export async function patchDraft(tx: Tx, body: Record<string, unknown>) {
  if (typeof body.business_type === 'string' && body.business_type.trim()) {
    await tx.query(
      `INSERT INTO business_profiles (workspace_id, confirmed_type) VALUES (app_workspace_id(), $1)
       ON CONFLICT (workspace_id) DO UPDATE SET confirmed_type = EXCLUDED.confirmed_type`,
      [body.business_type.trim().slice(0, 80)],
    )
  }
  if (body.accept_all) await tx.query(`UPDATE fact_drafts SET review_state = 'accepted' WHERE review_state = 'pending' AND (conflict_group IS NULL OR NOT ${CONFLICTED})`)
  if (typeof body.label === 'string' && typeof body.text === 'string' && !body.id) {
    if (!body.label.trim() || !body.text.trim()) throw invalid('text', 'Give the fact a name and a value.')
    const { path, label } = pathFor(body.label.trim())
    if (!path) throw invalid('label', 'Use letters or numbers in the name.')
    const clash = await tx.query(`SELECT 1 FROM fact_drafts WHERE field_path = $1 AND review_state <> 'rejected'`, [path])
    if (clash.rows[0]) throw invalid('label', 'That fact already exists. Edit it in the list instead.')
    await tx.query(
      `INSERT INTO fact_drafts (workspace_id, field_path, value, evidence, confidence, review_state)
       VALUES (app_workspace_id(), $1, $2, 'Entered by you', 'high', 'accepted')`,
      [path, JSON.stringify({ label, text: body.text.trim().slice(0, 600) })],
    )
  }
  if (typeof body.id === 'string') {
    const f = (await tx.query<{ value: { label: string; text: string }; conflict_group: string | null; review_state: string }>('SELECT value, conflict_group, review_state FROM fact_drafts WHERE id = $1', [body.id])).rows[0]
    if (!f) throw new AppError(404, 'NOT_FOUND', 'Not found.')
    let state = ['accepted', 'rejected'].includes(body.review_state as string) ? (body.review_state as string) : f.review_state
    let text = f.value.text
    if (typeof body.text === 'string' && body.text.trim() && body.text.trim() !== text) {
      text = body.text.trim().slice(0, 600)
      state = 'edited'
    }
    await tx.query('UPDATE fact_drafts SET value = $2, review_state = $3 WHERE id = $1', [body.id, JSON.stringify({ ...f.value, text }), state])
    // Choosing one side of a conflict settles it.
    if (f.conflict_group && state !== 'rejected')
      await tx.query(`UPDATE fact_drafts SET review_state = 'rejected' WHERE conflict_group = $1 AND id <> $2`, [f.conflict_group, body.id])
  }
}

export async function publish(tx: Tx, userId: string, workspaceState: string) {
  const draft = await getDraft(tx)
  if (draft.conflicts) throw new AppError(409, 'CONFLICTS_UNRESOLVED', 'Some facts disagree with each other. Choose the right one before publishing.')
  const facts = draft.facts.filter((f) => f.diff !== 'unreviewed').map((f) => ({ path: f.field_path, label: f.value.label, text: f.value.text }))
  if (!facts.length) throw new AppError(409, 'NOTHING_APPROVED', 'Accept at least one fact before publishing.')
  const content: Knowledge = { business_type: draft.business_type, facts }
  const canonical = JSON.stringify(content)
  const hash = sha(canonical)
  const current = await tx.query<{ content_hash: string }>(`SELECT content_hash FROM knowledge_versions WHERE status = 'published'`)
  if (current.rows[0]?.content_hash === hash) throw new AppError(409, 'NO_CHANGES', 'The draft is the same as the published version.')
  await tx.query(`UPDATE knowledge_versions SET status = 'superseded' WHERE status = 'published'`)
  const v = await tx.query<{ id: string; sequence: number }>(
    `INSERT INTO knowledge_versions (workspace_id, sequence, status, content, content_hash, approved_by, approved_at)
     VALUES (app_workspace_id(), (SELECT COALESCE(max(sequence), 0) + 1 FROM knowledge_versions), 'published', $1, $2, $3, now())
     RETURNING id, sequence`,
    [canonical, hash, userId],
  )
  // A reply being generated against the old version must not be sent after this.
  await tx.query(
    `UPDATE workspaces SET lock_version = lock_version + 1, state = $1 WHERE id = app_workspace_id()`,
    [canTransition('workspace', workspaceState, 'testing') ? 'testing' : workspaceState],
  )
  await audit(tx, 'knowledge.publish', { knowledge_version_id: one(v).id })
  return { sequence: one(v).sequence, facts: facts.length, left_out: draft.pending }
}
