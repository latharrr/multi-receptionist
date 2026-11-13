// Applies database migrations with the owning role: `pnpm migrate`. Its own deploy step, run
// before the new web and worker processes start. Additive only; see docs/operations.md for rollback.
import { migrate } from '@lathar/database'
import { boot, log } from './runtime.ts'

const rt = await boot(['DATABASE_URL_MIGRATE'])
const owner = rt.pool('migrate', 1)
await migrate(owner)
// Production: each process's login role gets the password from its own DATABASE_URL, so the
// credentials live in one place. Development logins come from infra/postgres-init.sql instead.
if (rt.config.production) {
  for (const role of ['WEB', 'WORKER', 'CALLBACK', 'AUTH', 'OPERATOR'] as const) {
    const u = URL.parse(rt.config[`DATABASE_URL_${role}`] ?? '')
    if (!u?.password) continue
    // format() quotes the name and the password; the statement itself cannot take parameters.
    const sql = await owner.query<{ sql: string }>(`SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS sql FROM pg_roles WHERE rolname = $1 AND rolname LIKE 'app\_%'`, [decodeURIComponent(u.username), decodeURIComponent(u.password)])
    if (sql.rows[0]) await owner.query(sql.rows[0].sql)
    log('migrate.login_set', { role: decodeURIComponent(u.username), known: Boolean(sql.rows[0]) })
  }
}
const done = await owner.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')
log('migrate.done', { applied: done.rows.length, latest: done.rows.at(-1)?.name ?? null })
await owner.end()
