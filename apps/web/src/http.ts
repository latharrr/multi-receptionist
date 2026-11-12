import { isIP } from 'node:net'

export class AppError extends Error {
  status: number
  code: string
  fields?: Record<string, string>
  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message)
    this.status = status
    this.code = code
    this.fields = fields
  }
}
export const invalid = (field: string, message: string) => new AppError(422, 'VALIDATION', message, { [field]: message })

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Required trimmed string from an untrusted JSON body. */
export function str(body: unknown, field: string, max: number, min = 1): string {
  const v = (body as Record<string, unknown> | null)?.[field]
  if (typeof v !== 'string' || v.trim().length < min) throw invalid(field, 'This is required.')
  if (v.length > max) throw invalid(field, `Keep this under ${max} characters.`)
  return v.trim()
}

// Escape-by-default HTML: every interpolation is escaped unless it is itself html`…` output.
export class Raw {
  s: string
  constructor(s: string) {
    this.s = s
  }
}
const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const render = (v: unknown): string =>
  v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(render).join('') : esc(v)
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  return new Raw(strings.reduce((out, s, i) => out + render(values[i - 1]) + s))
}

/**
 * Used for imported page URLs and custom AI endpoints.
 * shortcut: hostname rules only. Resolved-address and redirect checks must run at connect
 * time; add them with the first adapter that actually opens a connection.
 */
export function checkPublicHttpsUrl(raw: string, field: string, allowPort = false): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw invalid(field, 'Enter a full address starting with https://')
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (u.protocol !== 'https:') throw invalid(field, 'Use a public https:// address.')
  if (u.username || u.password) throw invalid(field, 'Addresses containing a username or password are not accepted.')
  if (u.port && !allowPort) throw invalid(field, 'Addresses with a custom port are not accepted.')
  if (isIP(host) || !host.includes('.') || /(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/.test(host))
    throw invalid(field, 'Use a public https:// address. Private, local and numeric addresses are not accepted.')
  return u
}

export const normalizeNumber = (raw: string, field: string): string => {
  const d = raw.replace(/[\s()-]/g, '')
  if (!/^\+?\d{8,15}$/.test(d)) throw invalid(field, 'Enter the full number with country code, for example +15550100.')
  return d.replace(/^\+/, '')
}
export const maskNumber = (n: string) => `••• ${n.slice(-4)}`
