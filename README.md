# Lathar Labs WhatsApp Receptionist

Multi-business WhatsApp AI receptionist. This repository is a new, separate product; it shares no
data, secrets or deployment with the running Labs bot.

**Current level: local prototype with mock integrations.** Nothing here connects to WhatsApp, calls
an AI provider, sends email or spends money. It refuses to start with `NODE_ENV=production`.

```sh
pnpm install
pnpm db          # local PostgreSQL 18 in Docker, with the restricted login roles
pnpm dev         # http://127.0.0.1:3000  (sign-in links appear at /dev/mailbox)
pnpm test        # contracts, PostgreSQL isolation/restore, and the HTTP acceptance flow
pnpm lint && pnpm typecheck
pnpm test:browser   # real-browser check; see the header of tests/browser/check.mjs
```

## What works (all against mocks)

Sign-in by single-use email link → create workspace → paste/upload business text → answer or skip
one question at a time → review facts, resolve conflicts, publish a version → assistant settings →
AI provider and your own API key (encrypted, masked) → spending limit → choose a WhatsApp route
(both represented, consent recorded) → test chat → inbox with takeover, staff reply, hand back,
pause → enquiries → usage. Activation for real customers is always refused.

## Layout

- `packages/contracts` — capabilities, state machines, delivery-state reducer.
- `packages/database` — SQL migrations, `pg` adapter, request/worker/callback tenant boundaries.
- `apps/web` — plain Node HTTP server: control API (`/api/v1`), server-rendered screens, in-process job worker.
- `infra/` — local PostgreSQL container. `tests/browser/` — browser check and its screenshots.
- `docs/design/` — static design prototype (landing, components, app).

## Database roles

Each process connects as its own login role and cannot switch: `app_user` (web requests),
`app_worker` (leases jobs across tenants, reads tenant data only inside a job's tenant),
`app_callback` (maps a provider number to a tenant, records the event, enqueues work, reads nothing
else), `app_auth` (the auth library's own schema). Migrations run as the owner; the running app
keeps no owner connection. Rollback is restore-from-dump (tested); there are no down-migrations.

## Mocked

- **AI**: keyword lookup over published facts, behind the `AiAdapter` interface. Free-text
  instructions are stored but ignored. No provider is contacted; the saved key is never used.
- **WhatsApp**: both routes are simulated behind the `Messaging` interface; customers are simulated
  from the inbox. Inbound events still take the callback path (callback role, number mapping).
- **Costs**: a flat 1 cent estimate per generation, so the limit can be exercised.
- **Email**: a local mailbox table and page, development only.
- **Extraction** of facts and enquiry details: fixed patterns, not AI.

## Not built

- Live adapters for either WhatsApp route or any AI provider; signature-verified callback endpoints.
- The spec's separate Python worker. The durable job and send ledger exist, in-process in TypeScript.
- Next.js. The spec recommends it; this prototype is deliberately plain Node.
- A real email sender. Without the development mailbox, sign-in links cannot be delivered.
- Team management, staff notifications, operator screens, export/close, retention (listed in-app
  under "Not built yet").
- Reading web pages, CSV export of enquiries, monthly limit reset, version rollback, If-Match on edits.
- CI has never run (no remote).
