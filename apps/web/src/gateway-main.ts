// QR gateway process: `pnpm gateway`. Holds the unofficial linked-device sessions, receives their
// messages and performs their sends. Off unless QR_GATEWAY=on. One process only: two gateways
// would fight over the same sessions.
import makeWASocket, { Browsers, useMultiFileAuthState } from '@whiskeysockets/baileys'
import { createGateway, type QrSocket } from './adapters/whatsapp-qr.ts'
import { boot, log } from './runtime.ts'
import { runWorker } from './worker.ts'

const rt = await boot(['DATABASE_URL_WORKER', 'DATABASE_URL_CALLBACK', 'MASTER_KEY'])
if (rt.config.QR_GATEWAY !== 'on') {
  console.error('The QR gateway is switched off. Set QR_GATEWAY=on to run the unofficial route.')
  process.exit(1)
}
const worker = rt.pool('worker')
// The library logs message metadata at verbose levels; nothing from it is written anywhere.
const quiet = { level: 'silent', child: () => quiet, trace() {}, debug() {}, info() {}, warn() {}, error() {} }
const gateway = createGateway({
  worker, callback: rt.pool('callback', 3), dataDir: rt.dataDir,
  async factory(sessionDir) {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
    const sock = makeWASocket({
      auth: state, logger: quiet, browser: Browsers.ubuntu('Receptionist'),
      markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false,
    })
    return { sock: sock as unknown as QrSocket, saveCreds }
  },
})

const stop = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop.abort())
const timer = setInterval(() => gateway.sync().catch((e) => console.error('gateway:', e instanceof Error ? e.message : 'unknown')), 3000)
log('gateway.started', { pid: process.pid })
// Only this process runs sends for live QR connections (queue 'qr'); it never calls the AI or sends mail.
await runWorker(
  { worker, ai: rt.ai, messaging: rt.messaging(gateway.messaging), notifier: { send: async () => { throw new Error('the gateway sends no mail') } }, baseUrl: null, masterKey: rt.masterKey },
  { name: `gateway:${process.pid}`, signal: stop.signal, queue: 'qr' },
)
clearInterval(timer)
await gateway.stop()
await worker.end()
