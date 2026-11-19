export * from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Prisma 7 driver adapter (pg) built from DATABASE_URL, with an explicit pool.
 *
 * pg's defaults were in force: 10 connections, and `connectionTimeoutMillis: 0`
 * — wait FOREVER for a free connection. Under load (every agent's 1 s polls on
 * top of dashboards and imports) an exhausted pool therefore didn't fail, it
 * hung requests until the browser gave up. Now a request that can't get a
 * connection within the timeout fails fast and visibly.
 *
 *  • DATABASE_POOL_MAX (default 10) — per API instance. Keep
 *    instances × max under the database's connection limit.
 *  • DATABASE_CONNECT_TIMEOUT_MS (default 10000) — wait for a free connection.
 */
export function createPrismaAdapter(): PrismaPg {
  return new PrismaPg({
    connectionString: process.env.DATABASE_URL as string,
    max: Number(process.env.DATABASE_POOL_MAX) || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS) || 10_000,
  });
}

// Shared client for scripts. LAZY: it used to be constructed when this module
// was first imported — which the API does, for its types — so every API process
// carried a second client and pool it never used.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function getPrisma(): PrismaClient {
  if (!globalForPrisma.prisma) {
    // Kept on globalThis outside production so dev hot-reload reuses one pool.
    globalForPrisma.prisma = new PrismaClient({
      adapter: createPrismaAdapter(),
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }
  return globalForPrisma.prisma;
}

/** The shared client, created on first use. Prefer `getPrisma()` in new code. */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getPrisma();
    const value = Reflect.get(client, prop, client);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
