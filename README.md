# CRM Lead & Sales System

Outbound-calling sales CRM for a US tax/bookkeeping firm. Leads are organised by
**Country → Time Zone → State → City**; the system covers lead import and
de-duplication, assignment and carry-forward, a calling workspace, callbacks and
follow-ups, Zoom meetings, productivity dashboards, and AI call summaries.

See [SOLUTION_DESIGN.md](SOLUTION_DESIGN.md) for the original architecture and
roadmap — parts of it (Twilio, Redis, Socket.IO, BullMQ) were planned but never
built; this README describes what actually runs.

## Stack

- **Web:** Next.js 16 (App Router) · React 19 · TypeScript · Tailwind · TanStack Query
- **API:** NestJS 12 (modular monolith) · Prisma 7 (pg driver adapter) · PostgreSQL
- **Auth:** JWT access + rotating refresh tokens backed by server-side sessions ·
  RBAC guards · email OTP with trusted devices · optional TOTP MFA
- **Calling & SMS:** Quo / OpenPhone. Calls are placed in the Quo app via its deep
  link (it has no dial API); call, SMS and recording events arrive by signed
  webhook. Live views (incoming-call popup, call state, dashboards) poll the API.
- **AI:** call transcription + summaries via Groq (Whisper/Llama) or Anthropic
- **Background work:** in-process cron jobs, each guarded by a database lease
  (`scheduler_locks`) so it runs once across instances; long operations (lead
  import, Quo sync-all) run as `background_jobs` the client polls.

## Monorepo layout

```
apps/crm-web       Next.js frontend
apps/crm-api       NestJS backend
packages/database  Prisma schema, migrations, seed and maintenance scripts
infrastructure/    local docker-compose (Postgres; its Redis service is unused)
```

## Local setup

Requires **Node ≥ 22.18** (the API loads `@crm/database` as raw TypeScript).

```bash
npm ci                         # install every workspace
cp .env.example .env           # then fill in values — see the comments in it
npm run docker:up              # local Postgres
npm run db:generate            # Prisma client
npm run db:migrate             # apply migrations to the local database
SEED_PASSWORD='choose-one' npm run db:seed   # demo data
npm run dev                    # api on :4000, web on :3000
```

The seed creates `admin@crm.local`, `leader1@crm.local`, `caller1@crm.local` and
friends, all with the `SEED_PASSWORD` you chose. Never seed a shared or production
database with a guessable password. To create a real admin on any database:

```bash
DATABASE_URL="<db-url>" EMAIL="you@company.com" PASSWORD="<strong>" npm run -w @crm/database set-admin
```

## Checks

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

On a machine with little free memory, run the API tests with fewer workers —
`npm test -w @crm/api -- --maxWorkers=2` — and not at the same time as the web tests.
CI (`.github/workflows/ci.yml`) also applies every migration to a fresh Postgres.

## Deploying the API

The root `Dockerfile` builds the API image. On boot it applies pending
migrations, then starts the server. Before the first deploy:

- **Secrets:** production refuses to start unless `JWT_ACCESS_SECRET` and
  `JWT_REFRESH_SECRET` are set, at least 32 characters, not placeholders, and
  different. Also set `QUO_WEBHOOK_SECRET` (webhooks are refused without it),
  `MFA_ENCRYPTION_KEY`, `WEB_ORIGIN`, SMTP settings and `DATABASE_URL`.
- **Health checks:** readiness → `/api/health` (503 if the database is down or
  migrations failed), liveness → `/api/health/live`.
- **Proxy:** `TRUST_PROXY` = proxy hops in front of the API (default 1).
- **Time zone:** `BUSINESS_TIMEZONE` decides what "today" means (default `EST`).

Every setting is documented in [.env.example](.env.example).
