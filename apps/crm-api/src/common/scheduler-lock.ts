import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { Prisma } from '@crm/database';

/**
 * One runner per scheduled job, across every API instance.
 *
 * `@Cron` fires in every process that has the module loaded. With two API
 * instances — a rolling deploy is enough — each reminder e-mail went out twice,
 * carry-forward ran twice, and the Quo sync spent the rate limit twice. A slow
 * run could also overlap the next tick on the same instance.
 *
 * The guard is a LEASE in `scheduler_locks`, not a Postgres advisory lock:
 * session advisory locks belong to one connection, and Prisma hands each query
 * whatever pooled connection is free, so the unlock could land on a different
 * connection and leak the lock forever. A lease is one atomic statement to take
 * and one to give back, works through any connection, and if the holder dies
 * mid-run it simply expires — at worst one tick is skipped.
 */

const logger = new Logger('SchedulerLock');

/** Identifies this process in `scheduler_locks.locked_by`. */
export const INSTANCE_ID = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;

type LockClient = {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
};

/**
 * Run `fn` only if no other runner holds `name`'s lease. Returns `fn`'s result,
 * or `undefined` when the job was skipped because someone else is running it.
 *
 * `leaseMs` must comfortably exceed the job's longest run: past it, another
 * instance may start the job alongside this one. A run that finishes releases
 * the lease straight away, so the lease length never delays the next tick.
 *
 * Times are compared in UTC on the database's own clock, so instances with
 * drifting clocks can't disagree about whether a lease has expired.
 */
export async function runExclusive<T>(
  prisma: LockClient,
  name: string,
  leaseMs: number,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const leaseSecs = Math.max(1, Math.ceil(leaseMs / 1000));
  let acquired: { name: string }[];
  try {
    acquired = await prisma.$queryRaw<{ name: string }[]>(Prisma.sql`
      INSERT INTO scheduler_locks (name, locked_until, locked_by, locked_at)
      VALUES (
        ${name},
        timezone('UTC', now()) + make_interval(secs => ${leaseSecs}::double precision),
        ${INSTANCE_ID},
        timezone('UTC', now())
      )
      ON CONFLICT (name) DO UPDATE
        SET locked_until = EXCLUDED.locked_until,
            locked_by    = EXCLUDED.locked_by,
            locked_at    = EXCLUDED.locked_at
        WHERE scheduler_locks.locked_until < timezone('UTC', now())
      RETURNING name`);
  } catch (err) {
    // No lock table (migration not applied yet) or the database is down. Skip
    // the tick rather than run unguarded: the job runs again next interval.
    logger.warn(`Skipping "${name}" — could not take its scheduler lease: ${(err as Error).message.split('\n')[0]}`);
    return undefined;
  }
  if (!acquired.length) {
    logger.debug(`Skipping "${name}" — another runner holds its lease`);
    return undefined;
  }
  try {
    return await fn();
  } finally {
    await prisma
      .$executeRaw(Prisma.sql`
        UPDATE scheduler_locks SET locked_until = timezone('UTC', now())
        WHERE name = ${name} AND locked_by = ${INSTANCE_ID}`)
      .catch((err) => logger.warn(`Could not release the "${name}" lease (it will expire on its own): ${String(err)}`));
  }
}
