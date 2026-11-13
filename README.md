# Lathar Labs WhatsApp Receptionist

A WhatsApp AI receptionist that many businesses can use, each in its own workspace. Each business
uploads and reviews its own knowledge, writes instructions for the assistant, brings its own AI
key, connects a WhatsApp number and answers customers from a team inbox.

This is a new, separate product. It shares no data, secrets, database, permissions or deployment
with the running Labs bot.

## Status: pilot code, not deployed

| Area | State |
|---|---|
| AI replies | **Real Anthropic adapter** (your own key). Tested against a local stub only; no paid call has been made. |
| WhatsApp, official Cloud API | **Real adapter**: credential check, sending, signed webhooks, delivery receipts. Tested against a local stub only; no Meta account or number has been connected. |
| WhatsApp, unofficial QR | **Real gateway** (Baileys 7.0.0-rc14). Tested with a fake socket only, never against real WhatsApp. Unsupported by Meta, and the number can be banned or disconnected. |
| Email | **Real SMTP** for sign-in links, invitations and staff notices. Tested against a local SMTP server only. |
| Sending | **Supervised**: every AI reply is a draft that staff approve, edit or discard. Automatic sending is available only in development builds. |
| Costs | Estimates: provider-reported tokens × list price (cached 2026-11-03), labelled as such and not reconciled with any invoice. Meta's per-message charges are counted, not priced. |
| Deployment | Dockerfile and compose file written; the image builds. **Never run as a full stack, never deployed.** The backup/restore scripts have not been tested yet. |

Nothing here has spent money, sent a real message or email, or touched an external account.

## Quick start (development)

Needs Node 24+, pnpm 11 and Docker.

```sh
pnpm install
pnpm db     # local PostgreSQL 18 in Docker (named volume infra_pgdata) + development login roles
pnpm dev    # prints the address; sign-in links appear at /dev/mailbox
```

- In development, AI and WhatsApp are mocks unless configured otherwise, and anything simulated is
  labelled "mock" on screen. Email goes to the local mailbox page.
- `pnpm dev` uses its own database (`receptionist_demo`) and data folder (`.data/receptionist_demo`).
  It never resets data; migrations only add. A throwaway copy: `DATABASE_NAME=receptionist_scratch pnpm dev`.
- It never takes a port from another process. If 3000 is busy it says which process holds it and
  uses the next free one; with `PORT` set it stops instead.
- Operator screen: `OPERATOR_EMAILS=you@example.test pnpm dev`, sign in with that address, open `/operator`.
- Separate worker: `WORKER=external PORT=3000 pnpm dev` and, in another terminal, `PORT=3000 pnpm worker`.
- Real AI in development (spends money on your key): `AI=live pnpm dev`.

```sh
pnpm test            # contracts, PostgreSQL isolation, mock flow, pilot suite (needs pnpm db)
pnpm lint && pnpm typecheck
pnpm test:browser    # real Chrome, keyboard and three widths; setup is in tests/browser/check.mjs
```

## How it works

**Onboarding (self-service, per business):** sign in by email link → create workspace → paste or
upload business text → answer gap questions → review facts, resolve conflicts, publish a version →
assistant instructions → AI provider and key (encrypted, masked, replaceable) → monthly spending limit
and message cap → choose a WhatsApp route (consent recorded) → test chat → go live.

**Going live** needs every readiness check to pass *and* a platform operator to enable the workspace.
Only one route and number should be active for the first pilot.

**Answering:** an inbound message is deduplicated, routed to its tenant by the server's own
number mapping (never by an ID in the payload), and a reply is generated from the *published* facts
only. The assistant must cite the facts it used; a reply containing a number that is not in those
facts or in the conversation goes to staff instead. Missing information means a clarifying question
or a staff handoff, never a guessed price, time or promise. Customer messages and imported text are
treated as data, not instructions. The AI key is never put in the prompt.

**Supervised mode:** the reply becomes a draft in the inbox. Staff approve it as written, edit it, or
discard it and reply themselves. A newer customer message replaces a waiting draft. A handoff creates
no draft; the customer waits for a person.

**Team inbox:** take over, reply, hand back, pause automation. While paused, staff can still reply.
Staff notices go to every active member by email through a durable per-recipient outbox.

## Send safety

- **Jobs are database rows with fenced leases** (30 s, renewed every 10 s, with a token checked on
  every write). A worker that stalls loses the job; its late writes are refused. Tested with two real
  worker processes: A freezes, B takes over, A resumes.
- **Intent before the call:** the send record and the budget reservation are committed before any
  provider is contacted.
- **Unknown outcomes stay unknown.** A send interrupted after submission is marked *uncertain* and
  never resent automatically. If the provider later confirms it, that is recorded as evidence. There is
  no claim of exactly-once delivery.
- **Checks immediately before dispatch:** global stop, workspace live, pause, takeover, permissions,
  the 24-hour customer service window and the monthly message cap.
- **Ordering:** one send per conversation at a time, in order.
- **Spending:** a concurrency-safe reservation of the call's upper bound, then settlement with the
  provider-reported usage. The cap cannot be exceeded by parallel requests. One retry per call at most.

## Security

- Tenant isolation is enforced in PostgreSQL with row-level security. Each process connects as its own
  role: `app_user` (web), `app_worker` (jobs; reads keys only inside the job's tenant, cannot write them),
  `app_callback` (webhooks), `app_auth` (sign-in library schema), `app_operator` (one read-only
  diagnostics function).
- Secrets (AI keys, WhatsApp tokens) are sealed with `MASTER_KEY`, which is never stored in the database
  and never returned after saving. The web role cannot read the ciphertext.
- Webhooks are verified with `X-Hub-Signature-256` over the raw body.
- Operator actions are audited without customer content. Tests cover other tenants, removed members,
  invitation misuse and support-agent permissions.
- **Known gap:** QR session files are stored unencrypted in the data folder.

## Privacy and data

- `/privacy` and `/support` are public pages; support goes to `SUPPORT_EMAIL`.
- Each workspace sets how many days conversations are kept; expired data is purged by the worker.
- Members who can manage the team can delete one customer's conversation, messages and contact details.

## WhatsApp rules (checked against Meta's documentation, November 2026)

- Pricing is per message. Service messages inside the 24-hour window are free for the first 1,000 per
  number per month from 1 October 2026, and charged after that.
- Outside the 24-hour window only approved templates may be sent. **Templates are not built**, so late
  replies are refused.
- Onboarding other businesses' numbers needs a Meta app with business verification, App Review and
  advanced access to `whatsapp_business_messaging` and `whatsapp_business_management`, usually through
  Embedded Signup. **Embedded Signup is not built**; today an owner enters a phone number ID and token,
  and the platform's Meta app must be subscribed to that owner's WhatsApp account.
- No Meta account, app or number is assumed to be approved.

## Production

One image runs every process. See `infra/deploy/`:

```sh
cd infra/deploy
cp env.example .env              # fill in; git-ignored. Never commit it or paste values into a chat.
docker compose build
docker compose up -d db
./backup.sh                      # before every migration
docker compose run --rm migrate  # migrations, then sets each role's login from its DATABASE_URL
docker compose --profile public up -d          # web, worker, Caddy (automatic HTTPS for APP_DOMAIN)
docker compose --profile qr up -d gateway      # only if the QR route is chosen (QR_GATEWAY=on)
```

- **Configuration** is validated at start-up: production refuses to start with missing secrets,
  non-HTTPS `PUBLIC_URL`, mock AI, a non-Meta Graph host or `ANTHROPIC_BASE_URL` set. Errors name the
  setting, never its value.
- **Health:** `/healthz` (process up) and `/readyz` (database reachable). Logs are JSON lines on stdout.
- **Backups:** `backup.sh` writes a database dump, the roles and the data folder. Keep `MASTER_KEY`
  separately; without it saved keys cannot be opened.
- **Restore/rollback:** `restore.sh <dump>` restores into a scratch database, checks it and removes
  it. `restore.sh <dump> <new_name>` restores into a new database for recovery. Nothing is overwritten.
  Migrations only add, so rolling back the code is safe; rolling back data means restoring a dump.

## Layout

- `packages/contracts`: capabilities, state machines, delivery-state reducer.
- `packages/database`: SQL migrations, `pg` adapter, tenant boundaries.
- `apps/web/src`: HTTP server and screens (`server.ts`), job worker (`worker.ts`, `worker-main.ts`),
  QR gateway (`gateway-main.ts`), migrations (`migrate.ts`), adapters (`adapters/`), development mocks
  (`dev/`, never loaded in production).
- `infra/`: local PostgreSQL; `infra/deploy/`: production compose, proxy, env template, backup and restore.
- `tests/browser/`: browser check and screenshots; `docs/design/`: static design prototype.

## Not built yet

- WhatsApp templates and Embedded Signup.
- Reconciliation of costs with the AI provider's or Meta's invoices.
- Encryption at rest for QR session files.
- Monitoring beyond health endpoints and logs (no alerting service is configured).
- Ownership transfer, choosing who gets staff notices, operator job retry/cancel, CSV export,
  usage history for earlier months.
- CI (no remote yet).

## Open decisions before a pilot

Pilot business and number, which route to activate, hosting, AI model and monthly budget, and the
email sender. No paid service, deployment or account change happens without explicit approval.
