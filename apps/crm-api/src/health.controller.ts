import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from './common/decorators/public.decorator.js';
import { PrismaService } from './prisma/prisma.service.js';

/** How long the database gets to answer before the check calls it down. */
const DB_CHECK_TIMEOUT_MS = 3_000;

/**
 * Health endpoints for the hosting platform.
 *
 * `/health` used to return 200 unconditionally, so a container whose database
 * was unreachable — or whose migrations had failed on boot (the Dockerfile
 * starts the API either way) — reported healthy and kept receiving traffic
 * while every real request failed. It now answers 503 unless the database
 * answers and migrations applied, so the platform can hold back a broken
 * rollout and route around a sick instance.
 *
 * `/health/live` is the plain "is the process up" probe. Point a LIVENESS
 * check there and the READINESS check at `/health`: a database blip should
 * take an instance out of rotation, not get it restarted in a loop.
 */
@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  // DEP-002 — health check returns 200 when the API can actually serve.
  @Public()
  @Get()
  async check() {
    const ts = new Date().toISOString();
    const migrationsFailed = process.env.MIGRATIONS_FAILED === '1';
    const database = await this.pingDatabase();
    if (database !== 'ok' || migrationsFailed) {
      throw new ServiceUnavailableException({
        status: 'error',
        ts,
        checks: { database, migrations: migrationsFailed ? 'failed — see the boot logs for the Prisma error' : 'ok' },
      });
    }
    return { status: 'ok', ts, checks: { database, migrations: 'ok' } };
  }

  @Public()
  @Get('live')
  live() {
    return { status: 'ok', ts: new Date().toISOString() };
  }

  private async pingDatabase(): Promise<string> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${DB_CHECK_TIMEOUT_MS}ms`)), DB_CHECK_TIMEOUT_MS);
        }),
      ]);
      return 'ok';
    } catch (err) {
      return `unreachable — ${(err as Error).message.split('\n')[0].slice(0, 200)}`;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
