// Picks the adapter for a message by its connection, so a mock connection can never reach a
// real provider and a live one can never be answered by a mock.
import type { Messaging, SendTarget } from '../worker.ts'

export function routeMessaging(routes: { mock?: Messaging; official?: Messaging; qr?: Messaging }): Messaging {
  const pick = (t: Pick<SendTarget, 'mode' | 'route'>) => (t.mode === 'mock' ? routes.mock : t.route === 'official_cloud_api' ? routes.official : routes.qr)
  return {
    // No adapter for this connection: definitely not sent, so `failed`, never `uncertain`.
    send: (i) => pick(i.target)?.send(i) ?? Promise.resolve({ state: 'failed' as const, errorCode: 'route_not_configured' }),
    async identify(t) {
      const m = pick(t)
      if (!m?.identify) throw new Error('credentials_missing')
      return m.identify(t)
    },
  }
}
