import { describe, expect, it, jest } from '@jest/globals';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from './metrics.service';
import type { MetricsQueryDto } from './dto/metrics.dto';

/**
 * The KPI cards sit directly above the Lead Management grid and have to be
 * counting the same leads it is listing.
 *
 * The grid can date a lead two ways — when it was created, and the day it is
 * currently scheduled for — and the cards take the same choice, because a row of
 * totals over one set of leads above a table of a different set is worse than no
 * totals at all. Nobody reads the cards as a separately-scoped figure; they read
 * them as the count of what is underneath.
 */
describe('MetricsService — leads counted on the same date the grid is filtered by', () => {
  /** `leadWhere` is private and is the whole decision; reached deliberately. */
  const leadWhereOf = (q: Partial<MetricsQueryDto>) => {
    const service = new MetricsService({} as PrismaService);
    const fn = (service as unknown as {
      leadWhere: (q: Partial<MetricsQueryDto>, user?: unknown) => Record<string, never>;
    }).leadWhere;
    return fn.call(service, q);
  };

  it('counts on the created date by default', async () => {
    const where = leadWhereOf({ from: '2026-08-01', to: '2026-08-14' });

    // Whole local days, so a single-day filter spans the day rather than
    // matching only the midnight instant.
    expect(where.createdAt).toBeDefined();
    expect(where).not.toHaveProperty('assignments');
  });

  it('counts on the scheduled day when the grid is set to it', async () => {
    const where = leadWhereOf({ from: '2026-08-14', to: '2026-08-14', dateField: 'scheduled' });

    // The active assignment, matching the grid's own filter exactly — so a lead
    // created in July and carried into today is counted by both, or by neither.
    expect(where.assignments).toMatchObject({ some: { isActive: true } });
    expect(where).not.toHaveProperty('createdAt');
  });

  it('applies neither when no range is given', async () => {
    const where = leadWhereOf({});
    expect(where).not.toHaveProperty('createdAt');
    expect(where).not.toHaveProperty('assignments');
    // Soft-deleted leads are still out, whatever the dates say.
    expect(where.deletedAt).toBeNull();
  });

  it('leaves the call-based figures on when the call happened, either way', async () => {
    // A call is dated by when it was made. That is a fact about the call and has
    // nothing to do with which day the lead is queued for, so switching the lead
    // date must not quietly re-window Calls Made.
    const counts = jest.fn(async (_a: { where?: Record<string, unknown> }) => 0);
    const prisma = {
      lead: { count: counts },
      call: { count: counts },
      user: { count: counts },
      zoomMeeting: { count: counts },
      target: { aggregate: jest.fn(async () => ({ _sum: { monthlyTarget: 0 } })) },
    } as unknown as PrismaService;
    const service = new MetricsService(prisma);

    const summary = await service.summary({ from: '2026-08-14', to: '2026-08-14', dateField: 'scheduled' } as MetricsQueryDto);

    // The read went through without the scheduled basis leaking into the call
    // filter — a `startTime` window is what a call is scoped by, and there is no
    // assignment relation on a call to filter instead.
    expect(summary).toBeDefined();
    const callWheres = counts.mock.calls
      .map(([a]) => a?.where)
      .filter((w): w is Record<string, unknown> => !!w && 'startTime' in w);
    expect(callWheres.length).toBeGreaterThan(0);
    for (const w of callWheres) expect(w).not.toHaveProperty('assignments');
  });
});
