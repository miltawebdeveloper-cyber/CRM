# CRM API — NestJS monorepo (apps/crm-api).
#
# Node 22 is REQUIRED, not just node>=20: the API imports the @crm/database
# workspace as RAW TypeScript (packages/database/src/index.ts), which only runs
# via Node's native type stripping (Node >= 22.18). On Node 20 the app compiles
# but crashes at runtime with "Unknown file extension .ts". Do not downgrade.
#
# Two stages. The BUILD stage holds the compiler toolchain and does all the
# work; the RUNTIME stage gets the built app and nothing it doesn't run — no
# python/make/g++ (a compiler in a production image is a ready-made toolkit for
# anyone who gets a shell in it), no web app sources — and runs as the
# unprivileged `node` user instead of root.

# ── Build ─────────────────────────────────────────────────────────────────────
FROM node:22-slim AS build

# Prisma needs OpenSSL. python3/make/g++ are the toolchain node-gyp uses to compile
# native deps (e.g. bcrypt) from source — node:*-slim ships without them, so
# `npm ci` fails at the native build step without this.
RUN apt-get update -y \
 && apt-get install -y --no-install-recommends openssl python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# prisma.config.ts resolves `env('DATABASE_URL')` at load time for EVERY prisma
# command — including `prisma generate`, which runs in postinstall/build here — and
# `.env` is (rightly) excluded from the image. `generate` never connects to the DB,
# so a throwaway value just satisfies config loading. The platform injects the real
# DATABASE_URL at runtime.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"

# Copy the whole monorepo. node_modules / dist are excluded via .dockerignore so
# native deps (e.g. bcrypt) are compiled for Linux HERE instead of being copied
# from the host — never ship a host node_modules into the image.
COPY . .

# Install every workspace. Dev deps are kept on purpose: `nest build` needs them
# at build time, and the Prisma CLI (`migrate deploy`) is used at start time.
# `npm ci`, not `npm install`: exactly the versions in package-lock.json, and the
# build fails if the lockfile is stale.
RUN npm ci

# Generate the Prisma client, compile the API to apps/crm-api/dist, then drop
# what the API never runs: the web app's sources (its workspace link with it).
RUN npm run -w @crm/database generate \
 && npm run -w @crm/api build \
 && rm -rf apps/crm-web node_modules/@crm/web

# ── Runtime ───────────────────────────────────────────────────────────────────
# The same base image as the build, so the native modules compiled there (bcrypt)
# load here unchanged.
FROM node:22-slim AS runtime

RUN apt-get update -y \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# The built monorepo, at the same paths it was built at — workspace symlinks in
# node_modules (@crm/database → packages/database) and the API's own nested
# node_modules resolve exactly as they did in the build stage. Owned by `node`,
# so anything that writes inside /app (npm, the Prisma CLI) behaves as it did as
# root.
COPY --from=build --chown=node:node /app /app

USER node

# Northflank injects PORT; apps/crm-api/src/main.ts binds process.env.PORT.
# Apply any pending migrations on boot (idempotent), then start the API. Requires
# DATABASE_URL to be set in the service's environment.
#
# Migrations still don't gate the PROCESS: with `&&`, any migrate failure (bad
# DATABASE_URL, DB still booting, SSL mismatch) stopped the API from ever
# listening, and the platform's proxy then reported only an opaque
# "upstream connect error ... connection refused" with no clue why. So the API
# still binds its port and the real Prisma error stays in the runtime logs.
#
# But they DO gate HEALTH. A failed migrate exports MIGRATIONS_FAILED=1, and
# /api/health then answers 503 (naming the failed migration check) instead of
# 200 — the old setup reported a half-migrated deploy as healthy and sent it
# traffic. Point the platform's readiness check at /api/health and its liveness
# check at /api/health/live. `exec` makes node PID 1 so it receives SIGTERM and
# shuts down cleanly (main.ts enables Nest's shutdown hooks) on redeploy.
CMD ["sh", "-c", "npm run -w @crm/database migrate:deploy || { echo '!!! migrate deploy FAILED - API will report 503 on /api/health; check DATABASE_URL !!!'; export MIGRATIONS_FAILED=1; }; exec node apps/crm-api/dist/main.js"]
