# Lathar Labs WhatsApp Receptionist

Multi-business WhatsApp AI receptionist. This repository is a new, separate product; it shares no
data, secrets or deployment with the running Labs bot.

**Current level: local prototype with mock integrations.** Nothing here connects to WhatsApp, calls
an AI provider, sends email or spends money. It refuses to start with `NODE_ENV=production`.

## Start the demo

```sh
pnpm install
pnpm db     # local PostgreSQL 18 in Docker (data in the named volume infra_pgdata) + the login roles
pnpm dev    # prints the address; sign-in links appear at /dev/mailbox
```

- `pnpm dev` uses its own database, `receptionist_demo`, and its own folder for keys and uploads,
  `.data/receptionist_demo`. It never reads or changes `.data/pg`, `.data/master.key` or any other
  database. Migrations only add; nothing is reset. Run it again and your demo data is still there.
- It never takes a port from another process. If 3000 is busy it says which process holds it,
  leaves it running and uses the next free port. With `PORT` set it stops with a message instead.
- `pnpm db` is safe to repeat; it does not recreate the container or touch existing databases.
- Operator screen: `OPERATOR_EMAILS=you@example.test pnpm dev`, sign in with that address, open `/operator`.
- Jobs as a separate process: `WORKER=external PORT=3000 pnpm dev` in one terminal and
  `PORT=3000 pnpm worker` in another. The web process then holds no worker database role.
- A second, throwaway demo: `DATABASE_NAME=receptionist_scratch pnpm dev`.

```sh
pnpm test                    # contracts, PostgreSQL isolation/restore, HTTP acceptance flow (needs pnpm db)
pnpm lint && pnpm typecheck
pnpm test:browser            # real-browser check; see the header of tests/browser/check.mjs
```

## What works (all against mocks)

Sign-in by single-use email link → create workspace → paste/upload business text → answer or skip
one question at a time → review facts, resolve conflicts, publish a version → assistant settings →
AI provider and your own API key (encrypted, masked) → monthly spending limit → choose a WhatsApp
route (both represented, consent recorded) → test chat → inbox with takeover, staff reply, hand back,
pause automation → enquiries → usage → team (invite, join, roles, remove) → staff handoff notices →
operator diagnostics. Activation for real customers is always refused.

**Pause automation** stops the assistant only. Staff can still take over a chat and reply while it
is paused, with the usual checks (reply permission, takeover, connected number).

## Layout

- `packages/contracts` — capabilities, state machines, delivery-state reducer.
- `packages/database` — SQL migrations, `pg` adapter, request/worker/callback tenant boundaries.
- `apps/web` — plain Node HTTP server: control API (`/api/v1`), server-rendered screens, and the
  durable job worker (`src/worker.ts`), run in-process or as its own process (`src/worker-main.ts`).
- `infra/` — local PostgreSQL container. `tests/browser/` — browser check and its screenshots.
- `docs/design/` — static design prototype (landing, components, app).

## Database roles

Each process connects as its own login role and cannot switch: `app_user` (web requests),
`app_worker` (leases jobs across tenants, reads tenant data only inside a job's tenant),
`app_callback` (maps a provider number to a tenant, records the event, enqueues work, reads nothing
else), `app_auth` (the auth library's own schema), `app_operator` (one read-only diagnostics
function: counts, states and IDs, no content). Migrations run as the owner; the running app keeps no
owner connection. Rollback is restore-from-dump (tested); there are no down-migrations.

## Durable work

Jobs are rows with leases. A failed job waits 2s, 4s, 8s… between attempts and is abandoned
(dead-lettered) after three; an abandoned reply hands the customer to staff. A worker that dies
mid-job is recovered when its lease expires, without a second send or a second budget reservation.
A send whose outcome is unknown is marked uncertain and never resent. Every send re-checks pause,
takeover and the connection immediately before submitting.

## Mocked or simulated

- **AI**: keyword lookup over published facts, behind the `AiAdapter` interface. Free-text assistant
  instructions are saved but **not applied**. No provider is contacted; the saved key is never used.
- **WhatsApp**: both routes are simulated behind the `Messaging` interface; customers are simulated
  from the inbox. Inbound events still take the callback path (callback role, number mapping).
- **Costs**: synthetic. A made-up flat 1 cent per generated reply, so the limit can be exercised. It
  is not a price or an estimate.
- **Email**: sign-in links, invitations and staff notices are written to a local mailbox table and
  page, development only, behind the `Notifier` interface.
- **Extraction** of facts and enquiry details: fixed patterns, not AI.

## Not built

- Live adapters for either WhatsApp route or any AI provider; signature-verified callback endpoints.
- A real email sender. Without the development mailbox, sign-in links cannot be delivered.
- Team: ownership transfer, delegated permissions from a screen, declining an invitation, choosing
  who gets staff notices (every active member does).
- Operator: retry/cancel of jobs, time-limited support access, an audit trail of operator views.
- Export/close, retention, reading web pages, CSV export of enquiries, usage history for earlier
  months, version rollback, If-Match on edits.
- The spec's Python worker (the durable core stays TypeScript) and Next.js (deliberately plain Node).
- Known limits of the worker: a job that runs longer than its 30-second lease can be picked up by a
  second worker; staff notices are at-least-once per person; the monthly limit follows the workspace
  timezone, which is fixed at UTC because there is no setting for it yet.
- CI has never run (no remote).
