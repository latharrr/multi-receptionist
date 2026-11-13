// DEVELOPMENT AND TEST ONLY. Stand-ins for the AI provider, WhatsApp and email. The production
// entry points never import this file (config.ts refuses mock adapters when APP_ENV=production).
import { randomUUID } from 'node:crypto'
import type { Db } from '@lathar/database'
import type { AiAdapter } from '../adapters/ai.ts'
import type { Knowledge } from '../knowledge.ts'
import type { Messaging, Notifier } from '../worker.ts'

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

/** MOCK: keyword lookup over the published facts. Ignores owner instructions and history. */
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

/** MOCK: stands in for a provider accepting a message. Accepted is not delivered. */
export const mockMessaging: Messaging = { send: async () => ({ state: 'accepted', providerMessageId: `mock-${randomUUID()}` }) }

/** SIMULATED delivery: writes to the development mailbox table. Nothing leaves this machine. */
export const mailboxNotifier = (db: Db): Notifier => ({
  send: async (n) => void (await db.query('INSERT INTO local_mail (to_email, subject, body) VALUES ($1, $2, $3)', [n.to, n.subject, n.body])),
})
