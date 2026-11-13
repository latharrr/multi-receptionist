// Every setting the processes read, validated once at start-up. A missing or malformed value
// stops the process with a list of what is wrong; nothing falls back to a mock in production.
import { z } from 'zod'

const url = (protocols: string[]) => z.string().refine((v) => protocols.includes(URL.parse(v)?.protocol ?? ''), `must be a ${protocols.join(' or ')} URL`)
const Common = z.object({
  APP_ENV: z.enum(['development', 'production']).default('development'),
  /** Base64 of 32 random bytes. Opens tenant secrets; never stored in the database. */
  MASTER_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'must be base64 of 32 bytes').optional(),
  DATABASE_URL_WEB: url(['postgres:', 'postgresql:']).optional(),
  DATABASE_URL_WORKER: url(['postgres:', 'postgresql:']).optional(),
  DATABASE_URL_CALLBACK: url(['postgres:', 'postgresql:']).optional(),
  DATABASE_URL_AUTH: url(['postgres:', 'postgresql:']).optional(),
  DATABASE_URL_OPERATOR: url(['postgres:', 'postgresql:']).optional(),
  /** Owner connection, used only by the migrate command. */
  DATABASE_URL_MIGRATE: url(['postgres:', 'postgresql:']).optional(),
  /** Where people reach the app, e.g. https://app.example.com. */
  PUBLIC_URL: url(['https:', 'http:']).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  AUTH_SECRET: z.string().min(32).optional(),
  DATA_DIR: z.string().optional(),
  OPERATOR_EMAILS: z.string().default(''),
  /** Shown to customers' staff on the support and privacy pages. */
  SUPPORT_EMAIL: z.email().optional(),
  SMTP_URL: url(['smtp:', 'smtps:']).optional(),
  MAIL_FROM: z.string().min(3).optional(),
  /** Meta app credentials for the official route (one app for the platform). */
  META_APP_SECRET: z.string().min(16).optional(),
  META_VERIFY_TOKEN: z.string().min(16).optional(),
  GRAPH_API_BASE: url(['https:', 'http:']).default('https://graph.facebook.com'),
  GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v27.0'),
  /** development only: 'live' uses tenants' real AI keys instead of the mock. */
  AI: z.enum(['mock', 'live']).optional(),
  /** Allows the unofficial QR gateway to start. Off unless explicitly enabled. */
  QR_GATEWAY: z.enum(['on', 'off']).default('off'),
  LOG_LEVEL: z.enum(['info', 'warn', 'error']).default('info'),
})
export type Config = z.infer<typeof Common> & { production: boolean; operatorEmails: string[] }

export function loadConfig(env: NodeJS.ProcessEnv, needs: (keyof z.infer<typeof Common>)[] = []): Config {
  const parsed = Common.safeParse(env)
  const problems = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
  const c = parsed.success ? parsed.data : null
  if (c) {
    const production = c.APP_ENV === 'production'
    for (const k of needs) if (production && !c[k]) problems.push(`${k}: required in production`)
    if (production) {
      if (c.PUBLIC_URL && !c.PUBLIC_URL.startsWith('https://')) problems.push('PUBLIC_URL: must be https in production')
      if (c.AI === 'mock') problems.push('AI: the mock cannot be used in production')
      if (!c.GRAPH_API_BASE.startsWith('https://graph.facebook.com')) problems.push('GRAPH_API_BASE: must be Meta’s own host in production')
      // The Anthropic SDK reads this variable itself; in production it would send tenants' keys to another host.
      if (env.ANTHROPIC_BASE_URL) problems.push('ANTHROPIC_BASE_URL: must not be set in production')
      if (Boolean(c.SMTP_URL) !== Boolean(c.MAIL_FROM)) problems.push('SMTP_URL and MAIL_FROM: set both')
      if (Boolean(c.META_APP_SECRET) !== Boolean(c.META_VERIFY_TOKEN)) problems.push('META_APP_SECRET and META_VERIFY_TOKEN: set both or neither')
    }
  }
  if (!c || problems.length) {
    // Names and reasons only; values are never printed.
    throw new Error(`Configuration is not valid:\n  ${problems.join('\n  ')}`)
  }
  return { ...c, production: c.APP_ENV === 'production', operatorEmails: c.OPERATOR_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean) }
}
