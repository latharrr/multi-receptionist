// Spec §14 "Tenant and authorization" plus the §5/§6 invariants the schema itself enforces.
// All data is synthetic.
import { execFileSync } from 'node:child_process'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { AccessError, audit, connect, one, createWorkspace, migrate, withTenant, withWorkspace, type Db } from '../src/index.ts'
import { createTestDatabase, roleUrl, type Pools } from '../src/testing.ts'

// Real PostgreSQL. `db` is the web role's pool; `admin` (the owner) is used only to seed and inspect.
let pools: Pools
let db: Db
let admin: Db
const u: Record<string, string> = {}
const ws: Record<string, string> = {}
const conn: Record<string, string> = {}
const contact: Record<string, string> = {}

const SAME_PHONE = '15550100' // both tenants talk to the same customer number

const need = (v: string | undefined) => {
  if (!v) throw new Error('fixture missing')
  return v
}
const denied = (code: string) => (e: unknown) => e instanceof AccessError && e.code === code

before(async () => {
  pools = await createTestDatabase()
  ;({ web: db, admin } = pools)
  await migrate(admin) // idempotent

  for (const name of ['a', 'b', 'admin', 'agent', 'unverified']) {
    const { rows } = await admin.query<{ id: string }>(
      'INSERT INTO users (email, verified_at) VALUES ($1, $2) RETURNING id',
      [`${name}@example.test`, name === 'unverified' ? null : new Date()],
    )
    u[name] = one({ rows }).id
  }
  ws.a = await createWorkspace(db, need(u.a), 'Synthetic Clinic A')
  ws.b = await createWorkspace(db, need(u.b), 'Synthetic Shop B')
  await admin.query(
    `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'support_agent')`,
    [ws.a, u.admin, u.agent],
  )

  for (const k of ['a', 'b']) {
    await withWorkspace(db, { userId: need(u[k]), workspaceId: need(ws[k]) }, async (tx) => {
      const c = await tx.query<{ id: string }>(
        `INSERT INTO connections (workspace_id, route) VALUES (app_workspace_id(), 'unofficial_qr') RETURNING id`,
      )
      conn[k] = one(c).id
      const p = await tx.query<{ id: string }>(
        `INSERT INTO contacts (workspace_id, connection_id, provider_customer_id)
         VALUES (app_workspace_id(), $1, $2) RETURNING id`,
        [conn[k], SAME_PHONE],
      )
      contact[k] = one(p).id
    })
  }
})

test('member of A sees only A, even with overlapping customer identifiers', async () => {
  await withWorkspace(db, { userId: need(u.a), workspaceId: need(ws.a) }, async (tx) => {
    const all = await tx.query<{ id: string }>('SELECT id FROM contacts')
    assert.deepEqual(all.rows.map((r) => r.id), [contact.a])
    const forged = await tx.query('SELECT 1 FROM contacts WHERE id = $1', [contact.b])
    assert.equal(forged.rows.length, 0)
    const spaces = await tx.query<{ id: string }>('SELECT id FROM workspaces')
    assert.deepEqual(spaces.rows.map((r) => r.id), [ws.a])
    const people = await tx.query<{ id: string }>('SELECT id FROM users')
    assert.ok(!people.rows.some((r) => r.id === u.b), "tenant B's owner is not visible")
  })
})

test('non-member gets NOT_FOUND for another workspace and for malformed ids', async () => {
  await assert.rejects(withWorkspace(db, { userId: need(u.a), workspaceId: need(ws.b) }, async () => 1), denied('NOT_FOUND'))
  await assert.rejects(withWorkspace(db, { userId: need(u.a), workspaceId: "x' OR 1=1" }, async () => 1), denied('NOT_FOUND'))
})

test('RLS rejects writing a row into another tenant', async () => {
  await assert.rejects(
    withWorkspace(db, { userId: need(u.a), workspaceId: need(ws.a) }, (tx) =>
      tx.query(`INSERT INTO contacts (workspace_id, connection_id, provider_customer_id) VALUES ($1, $2, 'x')`, [
        ws.b,
        conn.b,
      ]),
    ),
    /row-level security/,
  )
})

test('composite foreign keys reject cross-tenant references even without RLS', async () => {
  // Runs as the migration superuser, so only the FK is protecting us here.
  await assert.rejects(
    admin.query('INSERT INTO conversations (workspace_id, connection_id, contact_id) VALUES ($1, $2, $3)', [
      ws.a,
      conn.a,
      contact.b,
    ]),
    /foreign key/,
  )
})

test('capabilities: agent and ungranted admin cannot publish; expired grant is ignored', async () => {
  const publish = (userId: string) =>
    withWorkspace(db, { userId, workspaceId: need(ws.a), capability: 'knowledge.publish' }, async () => 'ok')

  await assert.rejects(publish(need(u.agent)), denied('FORBIDDEN'))
  await assert.rejects(publish(need(u.admin)), denied('FORBIDDEN'))

  const grant = (expires: string) =>
    admin.query(
      `INSERT INTO permission_grants (workspace_id, grantee_user_id, capability, granted_by, expires_at)
       VALUES ($1, $2, 'knowledge.publish', $3, now() + $4::interval)`,
      [ws.a, u.admin, u.a, expires],
    )
  await grant('-1 hour')
  await assert.rejects(publish(need(u.admin)), denied('FORBIDDEN'))
  await grant('1 hour')
  assert.equal(await publish(need(u.admin)), 'ok')
  assert.equal(await publish(need(u.a)), 'ok')
})

test('unverified user cannot create a workspace', async () => {
  await assert.rejects(createWorkspace(db, need(u.unverified), 'Nope'), denied('FORBIDDEN'))
})

test('published knowledge is immutable and only one version is published', async () => {
  await withWorkspace(db, { userId: need(u.a), workspaceId: need(ws.a) }, async (tx) => {
    const v = await tx.query<{ id: string }>(
      `INSERT INTO knowledge_versions (workspace_id, sequence, content)
       VALUES (app_workspace_id(), 1, '{"hours":"9-5"}') RETURNING id`,
    )
    const id = one(v).id
    await tx.query(`UPDATE knowledge_versions SET content = '{"hours":"9-6"}' WHERE id = $1`, [id]) // draft: editable
    await tx.query(
      `UPDATE knowledge_versions SET status = 'approved', approved_by = app_user_id(), approved_at = now() WHERE id = $1`,
      [id],
    )
    await tx.query(`UPDATE knowledge_versions SET status = 'published' WHERE id = $1`, [id])
  })
  const inA = <T>(fn: Parameters<typeof withWorkspace<T>>[2]) =>
    withWorkspace(db, { userId: need(u.a), workspaceId: need(ws.a) }, fn)

  await assert.rejects(
    inA((tx) => tx.query(`UPDATE knowledge_versions SET content = '{"hours":"24/7"}' WHERE sequence = 1`)),
    /immutable after draft/,
  )
  await assert.rejects(
    inA((tx) =>
      tx.query(
        `INSERT INTO knowledge_versions (workspace_id, sequence, status, content, approved_by)
         VALUES (app_workspace_id(), 2, 'published', '{}', app_user_id())`,
      ),
    ),
    /one_published_knowledge/,
  )
})

test('budget reservations cannot exceed the approved cap', async () => {
  const reserve = () =>
    withWorkspace(db, { userId: need(u.a), workspaceId: need(ws.a) }, (tx) =>
      tx.query('UPDATE budget_limits SET reserved_micros = reserved_micros + 60'),
    )
  await withWorkspace(db, { userId: need(u.a), workspaceId: need(ws.a) }, (tx) =>
    tx.query(
      `INSERT INTO budget_limits (workspace_id, funding_source, provider, period, currency, hard_limit_micros, approved_by)
       VALUES (app_workspace_id(), 'byok', 'mock', 'month', 'USD', 100, app_user_id())`,
    ),
  )
  await reserve()
  await assert.rejects(reserve(), /budget_cap/)
})

test('ten duplicate webhook deliveries create one inbound event', async () => {
  for (let i = 0; i < 10; i++) {
    await withWorkspace(db, { userId: need(u.a), workspaceId: need(ws.a) }, (tx) =>
      tx.query(
        `INSERT INTO inbound_events (workspace_id, connection_id, external_event_key, kind, payload_hash)
         VALUES (app_workspace_id(), $1, 'evt-1', 'message', 'h') ON CONFLICT DO NOTHING`,
        [conn.a],
      ),
    )
  }
  const { rows } = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM inbound_events')
  assert.equal(one({ rows }).n, 1)
})

test('audit log is append-only and secret ciphertext is unreadable for the request role', async () => {
  const inA = <T>(fn: Parameters<typeof withWorkspace<T>>[2]) =>
    withWorkspace(db, { userId: need(u.a), workspaceId: need(ws.a) }, fn)

  await inA((tx) => audit(tx, 'test.event'))
  await assert.rejects(inA((tx) => tx.query(`UPDATE audit_events SET action = 'tampered'`)), /permission denied/)
  await assert.rejects(inA((tx) => tx.query('DELETE FROM audit_events')), /permission denied/)

  await inA((tx) =>
    tx.query(
      `INSERT INTO secret_refs (workspace_id, kind, ciphertext, key_version, masked_label)
       VALUES (app_workspace_id(), 'ai_key', '\\x00', 'k1', 'sk-…abcd')`,
    ),
  )
  const masked = await inA((tx) => tx.query<{ masked_label: string }>('SELECT masked_label FROM secret_refs'))
  assert.equal(one(masked).masked_label, 'sk-…abcd')
  await assert.rejects(inA((tx) => tx.query('SELECT ciphertext FROM secret_refs')), /permission denied/)
})

test('tenant context does not leak out of the transaction', async () => {
  const { rows } = await db.query<{ ws: string | null; n: number }>(
    'SELECT app_workspace_id() AS ws, (SELECT count(*)::int FROM contacts) AS n',
  )
  assert.equal(one({ rows }).ws, null)
  assert.equal(one({ rows }).n, 0, 'no tenant context means no tenant rows')
})

test('revoked membership loses access immediately', async () => {
  await admin.query(`UPDATE memberships SET status = 'revoked' WHERE user_id = $1`, [u.agent])
  await assert.rejects(withWorkspace(db, { userId: need(u.agent), workspaceId: need(ws.a) }, async () => 1), denied('NOT_FOUND'))
})

after(() => pools.drop())

test('the web role cannot switch role, reach the auth schema or resolve callbacks', async () => {
  const who = await db.query<{ u: string; s: boolean }>('SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS s')
  assert.deepEqual(who.rows[0], { u: 'app_user', s: false })
  await assert.rejects(db.query('SET ROLE postgres'), /permission denied/)
  await assert.rejects(db.query('SET ROLE app_worker'), /permission denied/)
  await assert.rejects(db.query('CREATE TABLE auth.x (id int)'), /permission denied/)
  await assert.rejects(db.query(`SELECT * FROM resolve_connection('unofficial_qr', 'num-a')`), /permission denied/)
  await assert.rejects(db.query('ALTER TABLE contacts DISABLE ROW LEVEL SECURITY'), /must be owner/)
})

test('worker role: leases jobs across tenants, but reads tenant data only inside the job\'s tenant', async () => {
  for (const k of ['a', 'b'])
    await admin.query(`INSERT INTO jobs (workspace_id, kind, dedupe_key) VALUES ($1, 'process_inbound', 'seed')`, [ws[k]])
  const { worker } = pools
  const jobs = await worker.query<{ workspace_id: string }>('SELECT workspace_id FROM jobs')
  assert.deepEqual(jobs.rows.map((j) => j.workspace_id).sort(), [ws.a, ws.b].sort())
  assert.equal((await worker.query('SELECT 1 FROM contacts')).rows.length, 0, 'no tenant context, no tenant rows')
  await withTenant(worker, need(ws.a), async (tx) => {
    assert.deepEqual((await tx.query<{ id: string }>('SELECT id FROM contacts')).rows.map((r) => r.id), [contact.a])
    assert.equal((await tx.query('SELECT 1 FROM contacts WHERE id = $1', [contact.b])).rows.length, 0)
  })
  // The worker needs tenant keys to call providers: it reads them only inside the job's tenant and can never write them.
  assert.equal((await worker.query('SELECT ciphertext FROM secret_refs')).rows.length, 0, 'no tenant context, no keys')
  assert.equal((await withTenant(worker, need(ws.b), (tx) => tx.query('SELECT ciphertext FROM secret_refs'))).rows.length, 0, 'another tenant sees none of A’s keys')
  assert.ok((await withTenant(worker, need(ws.a), (tx) => tx.query('SELECT ciphertext FROM secret_refs'))).rows.length > 0)
  await assert.rejects(withTenant(worker, need(ws.a), (tx) => tx.query('UPDATE secret_refs SET revoked_at = now()')), /permission denied/)
  await assert.rejects(withTenant(worker, need(ws.a), (tx) => tx.query('DELETE FROM audit_events')), /permission denied/)
  await assert.rejects(worker.query('SET ROLE app_user'), /permission denied/)
  // Work for tenant A cannot be attached to tenant B's contact: the composite foreign key refuses it.
  await assert.rejects(
    withTenant(worker, need(ws.a), (tx) => tx.query('INSERT INTO conversations (workspace_id, connection_id, contact_id) VALUES (app_workspace_id(), $1, $2)', [conn.a, contact.b])),
    /foreign key/,
  )
})

test('callback role: the tenant comes from the server-owned number mapping, never from the caller', async () => {
  const { callback } = pools
  await admin.query(`UPDATE connections SET state = 'connected', verified_number_id = 'num-a' WHERE id = $1`, [conn.a])
  // The same provider number cannot be connected for a second tenant.
  await assert.rejects(admin.query(`UPDATE connections SET state = 'connected', verified_number_id = 'num-a' WHERE id = $1`, [conn.b]), /one_connected_number/)

  // A live number resolves only once its workspace has been switched on.
  const resolveA = () => callback.query<{ workspace_id: string; connection_id: string }>(`SELECT * FROM resolve_connection('unofficial_qr', 'num-a')`)
  await admin.query(`UPDATE connections SET mode = 'live' WHERE id = $1`, [conn.a])
  assert.equal((await resolveA()).rows.length, 0)
  await admin.query(`UPDATE workspaces SET state = 'active' WHERE id = $1`, [ws.a])
  const hit = await resolveA()
  assert.deepEqual(hit.rows, [{ workspace_id: ws.a, connection_id: conn.a }])
  assert.equal((await callback.query(`SELECT * FROM resolve_connection('unofficial_qr', 'unknown')`)).rows.length, 0)
  assert.equal((await callback.query(`SELECT * FROM resolve_connection('official_cloud_api', 'num-a')`)).rows.length, 0)

  const insert = (workspace: string, connection: string, key: string) =>
    withTenant(callback, workspace, (tx) =>
      tx.query(`INSERT INTO inbound_events (workspace_id, connection_id, external_event_key, kind, payload_hash) VALUES ($1, $2, $3, 'message', 'h')`, [workspace, connection, key]))
  await insert(need(ws.a), need(conn.a), 'cb-1')
  // A body claiming tenant B with A's connection, or tenant A while the context says B, both fail.
  await assert.rejects(insert(need(ws.b), need(conn.a), 'cb-2'), /foreign key/)
  await assert.rejects(withTenant(callback, need(ws.b), (tx) => tx.query(`INSERT INTO inbound_events (workspace_id, connection_id, external_event_key, kind, payload_hash) VALUES ($1, $2, 'cb-3', 'message', 'h')`, [ws.a, conn.a])), /row-level security/)
  for (const table of ['contacts', 'messages', 'conversations', 'knowledge_versions', 'secret_refs', 'users', 'workspaces', 'connections'])
    await assert.rejects(withTenant(callback, need(ws.a), (tx) => tx.query(`SELECT 1 FROM ${table}`)), /permission denied/, table)
})

test('backup and restore: a dump restored into a new database keeps data, grants and isolation', async () => {
  const restored = `${pools.name}_restored`
  const sh = (cmd: string) => execFileSync('docker', ['compose', '-f', new URL('../../../infra/docker-compose.yml', import.meta.url).pathname, 'exec', '-T', 'db', 'sh', '-c', cmd], { stdio: 'pipe' })
  sh(`createdb -U postgres ${restored} && pg_dump -U postgres -Fc ${pools.name} | pg_restore -U postgres --exit-on-error -d ${restored}`)
  const radmin = connect(roleUrl('admin', restored), 1)
  const rweb = connect(roleUrl('app_user', restored), 2)
  try {
    const count = (d: Db, t: string) => d.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`).then((r) => one(r).n)
    for (const t of ['workspaces', 'memberships', 'contacts', 'audit_events', 'schema_migrations']) assert.equal(await count(radmin, t), await count(admin, t), t)
    await withWorkspace(rweb, { userId: need(u.a), workspaceId: need(ws.a) }, async (tx) => {
      assert.deepEqual((await tx.query<{ id: string }>('SELECT id FROM contacts')).rows.map((r) => r.id), [contact.a])
    })
    await assert.rejects(withWorkspace(rweb, { userId: need(u.b), workspaceId: need(ws.a) }, async () => 1), denied('NOT_FOUND'))
    await assert.rejects(withWorkspace(rweb, { userId: need(u.a), workspaceId: need(ws.a) }, (tx) => tx.query('SELECT ciphertext FROM secret_refs')), /permission denied/)
    await migrate(radmin) // a restored database is already at the current migration
  } finally {
    await Promise.all([radmin.end(), rweb.end()])
    sh(`dropdb -U postgres --force ${restored}`)
  }
})
