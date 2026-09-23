import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';
import { setTimezoneSnapshot } from '../../common/timezone.js';

/**
 * Keeps common/timezone.ts's synchronous in-memory snapshot current. That
 * module is read from deep inside synchronous code all over the API and
 * cannot await a DB call itself, so this service owns the only DB read: once
 * on boot, every 15s as a safety net (multi-instance / direct-DB-edit cases),
 * and eagerly right after TimezonesService writes (see its create/update).
 *
 * Loads every row, active or not — a deactivated code must keep resolving to
 * its real IANA zone for leads/targets/employees that still reference it.
 * Deactivation only hides a code from `GET /timezones` (pickers) and from
 * what CSV import / new selections accept; it must never change how an
 * existing record's timestamp is interpreted.
 */
@Injectable()
export class TimezonesCacheService implements OnModuleInit {
  private readonly logger = new Logger(TimezonesCacheService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.refresh();
  }

  @Interval(15_000)
  async refresh() {
    try {
      const rows = await this.prisma.timezoneOption.findMany({ orderBy: { sortOrder: 'asc' } });
      setTimezoneSnapshot(rows.map((r) => ({ code: r.code, label: r.label, ianaZone: r.ianaZone })));
    } catch (e) {
      // A transient DB hiccup must not take down the interval or wipe out the
      // last-known-good snapshot — setTimezoneSnapshot() already refuses an
      // empty list, so this is just about not leaving an unhandled rejection.
      this.logger.warn(`Timezone snapshot refresh failed: ${(e as Error).message}`);
    }
  }
}
