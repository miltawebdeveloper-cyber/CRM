# CRM API — NestJS monorepo (apps/crm-api).
#
# Node 22 is REQUIRED, not just node>=20: the API imports the @crm/database
# workspace as RAW TypeScript (packages/database/src/index.ts), which only runs
# via Node's native type stripping (Node >= 22.18). On Node 20 the app compiles
# but crashes at runtime with "Unknown file extension .ts". Do not downgrade.
FROM node:22-slim

# Prisma needs OpenSSL present.
RUN apt-get update -y \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the whole monorepo. node_modules / dist are excluded via .dockerignore so
# native deps (e.g. bcrypt) are compiled for Linux HERE instead of being copied
# from the host — never ship a host node_modules into the image.
COPY . .

# Install every workspace. Dev deps are kept on purpose: `nest build` needs them
# at build time, and the Prisma CLI (`migrate deploy`) + tsx (seed) are used at
# start time.
RUN npm install

# Generate the Prisma client, then compile the API to apps/crm-api/dist.
RUN npm run -w @crm/database generate \
 && npm run -w @crm/api build

ENV NODE_ENV=production

# Northflank injects PORT; apps/crm-api/src/main.ts binds process.env.PORT.
# Apply any pending migrations on boot (idempotent), then start the API. Requires
# DATABASE_URL to be set in the service's environment.
CMD ["sh", "-c", "npm run -w @crm/database migrate:deploy && node apps/crm-api/dist/main.js"]
