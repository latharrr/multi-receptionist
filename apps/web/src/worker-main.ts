// The job worker as its own process: `pnpm worker`. It connects with the worker role only and
// holds no web, callback or auth credentials. Run as many as needed; leases keep them apart.
import { setTimeout as sleep } from 'node:timers/promises'
import type { AiAdapter } from './adapters/ai.ts'
import { boot, log } from './runtime.ts'
import { runWorker } from './worker.ts'

const rt = await boot(['DATABASE_URL_WORKER', 'MASTER_KEY', 'SMTP_URL', 'MAIL_FROM'])
const worker = rt.pool('worker')

// Test knobs, refused in production: slow the AI or the send so a test can stall or kill this process mid-job.
const aiDelay = Number(process.env.TEST_AI_DELAY_MS ?? 0)
const sendDelay = Number(process.env.TEST_SEND_DELAY_MS ?? 0)
if ((aiDelay || sendDelay) && rt.config.production) throw new Error('Test delays cannot be used in production.')
const ai: AiAdapter = aiDelay ? { ...rt.ai, generate: async (req) => { await sleep(aiDelay); return rt.ai.generate(req) } } : rt.ai
const base = rt.messaging()
const messaging = sendDelay ? { ...base, send: async (i: Parameters<typeof base.send>[0]) => { await sleep(sendDelay); return base.send(i) } } : base

const stop = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop.abort())
log('worker.started', { pid: process.pid, production: rt.config.production, ai: rt.aiLive ? 'live' : 'mock' })
await runWorker(
  { worker, ai, messaging, notifier: rt.notifier(worker).notifier, baseUrl: rt.config.PUBLIC_URL ?? null, masterKey: rt.masterKey },
  { name: `worker:${process.pid}`, signal: stop.signal },
)
await worker.end()
