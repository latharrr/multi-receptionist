// The job worker as its own process: `pnpm worker`. It connects with the worker role only and
// holds no web, callback or auth credentials. Adapters are MOCKS; refuses to run as production.
import { setTimeout as sleep } from 'node:timers/promises'
import { connect } from '@lathar/database'
import { roleUrl } from '@lathar/database/testing'
import { mockAi, type AiAdapter } from './ai.ts'
import { mailboxNotifier, mockMessaging, runWorker } from './worker.ts'

if (process.env.NODE_ENV === 'production') throw new Error('This worker uses mock adapters. It must not be deployed.')

const database = process.env.DATABASE_NAME ?? 'receptionist_demo'
const worker = connect(roleUrl('app_worker', database))
// Test knob: makes the mock AI slow so a test can stop this process in the middle of a job.
const delay = Number(process.env.MOCK_AI_DELAY_MS ?? 0)
const slow: AiAdapter = {
  async generate(req) {
    await sleep(delay)
    return mockAi.generate(req)
  },
}
const ai = delay ? slow : mockAi

const stop = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop.abort())
console.log(`Worker ${process.pid} on database ${database} (mock AI, mock WhatsApp, simulated staff notices)`)
await runWorker(
  { worker, ai, messaging: mockMessaging, notifier: mailboxNotifier(worker), baseUrl: process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}` },
  { name: `worker:${process.pid}`, signal: stop.signal },
)
await worker.end()
