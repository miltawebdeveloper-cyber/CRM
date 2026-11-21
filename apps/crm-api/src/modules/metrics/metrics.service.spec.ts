import { describe, expect, it, jest } from '@jest/globals';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MetricsService, previousPeriod, shiftDay } from './metrics.service.js';
import type { MetricsQueryDto } from './dto/metrics.dto.js';

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
      outcome: { findMany: jest.fn(async () => []) },
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

/** ▲/▼ vs the previous period, and the per-day trend. */
describe('MetricsService — previous period', () => {
  it('is the same number of days, ending the day before', () => {
    expect(previousPeriod('2026-11-01', '2026-11-07')).toEqual({ from: '2026-10-25', to: '2026-10-31', days: 7 });
    expect(previousPeriod('2026-11-20', '2026-11-20')).toEqual({ from: '2026-11-19', to: '2026-11-19', days: 1 });
    // Across a month and a year end, on the calendar alone.
    expect(previousPeriod('2026-01-01', '2026-01-31')).toEqual({ from: '2025-12-01', to: '2025-12-31', days: 31 });
  });

  it('moves days on the calendar, whatever shape the date arrives in', () => {
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay('2026-11-20T00:00:00.000Z', 1)).toBe('2026-11-21');
  });

  it('asks for the previous period only when told to and when there is a range', async () => {
    const service = new MetricsService({} as PrismaService);
    const compute = jest
      .spyOn(service as unknown as { computeSummary: (q: Record<string, unknown>) => Promise<unknown> }, 'computeSummary')
      .mockImplementation(async (q) => ({ totalLeads: q.from === '2026-10-25' ? 40 : 50, totalCalls: 9, conversionPct: 2 }));

    const plain = (await service.summary({ from: '2026-11-01', to: '2026-11-07' } as never)) as { previous: unknown };
    expect(plain.previous).toBeNull();

    const compared = (await service.summary({ from: '2026-11-01', to: '2026-11-07', compare: true } as never)) as {
      totalLeads: number;
      previous: { from: string; to: string; totalLeads: number };
    };
    expect(compared.totalLeads).toBe(50);
    expect(compared.previous).toMatchObject({ from: '2026-10-25', to: '2026-10-31', totalLeads: 40 });
    // The current period came from the cache the first call filled.
    expect(compute).toHaveBeenCalledTimes(2);

    const open = (await service.summary({ compare: true } as never)) as { previous: unknown };
    expect(open.previous).toBeNull();
  });
});

describe('MetricsService.trend', () => {
  function harness() {
    // The connected query is the one carrying the answered-call rule.
    const callFind = jest.fn(async (a: { where: unknown }) =>
      JSON.stringify(a.where).includes('durationSecs')
        ? [{ startTime: new Date('2026-11-19T15:00:00Z') }]
        : [{ startTime: new Date('2026-11-19T15:00:00Z') }, { startTime: new Date('2026-11-19T16:00:00Z') }, { startTime: new Date('2026-11-20T15:00:00Z') }],
    );
    // Each lead's first answered call — one lead first reached on the 20th.
    const callGroup = jest.fn(async (_a: unknown) => [{ leadId: 'l1', _min: { startTime: new Date('2026-11-20T15:00:00Z') } }]);
    const prisma = {
      call: { findMany: callFind, groupBy: callGroup },
      outcome: { findMany: jest.fn(async () => [{ slug: 'call_back' }]) },
    } as unknown as PrismaService;
    return { service: new MetricsService(prisma), callFind, callGroup };
  }
  const groupArgs = (h: ReturnType<typeof harness>) => h.callGroup.mock.calls[0][0] as Record<string, unknown>;

  it('counts each business day in the range, and reports empty days as zero', async () => {
    const h = harness();
    const res = await h.service.trend({ from: '2026-11-18', to: '2026-11-20' } as never, { id: 'a', role: 'admin' } as never);
    expect(res.days.map((d) => d.day)).toEqual(['2026-11-18', '2026-11-19', '2026-11-20']);
    expect(res.days[0]).toEqual({ day: '2026-11-18', calls: 0, connected: 0, contacted: 0 });
    expect(res.days[1]).toMatchObject({ calls: 2, connected: 1, contacted: 0 });
    expect(res.days[2]).toMatchObject({ calls: 1, contacted: 1 });
  });

  it("keeps an employee to their own calls and leads", async () => {
    const h = harness();
    await h.service.trend({ from: '2026-11-18', to: '2026-11-20' } as never, { id: 'emp-1', role: 'employee' } as never);
    expect(JSON.stringify(h.callFind.mock.calls[0][0])).toContain('"callerId":"emp-1"');
    expect(JSON.stringify(groupArgs(h).where)).toContain('"assignedToId":"emp-1"');
  });

  it('counts a lead as contacted on the day of its first ANSWERED call, not its first No Answer', async () => {
    const h = harness();
    await h.service.trend({ from: '2026-11-18', to: '2026-11-20' } as never, { id: 'a', role: 'admin' } as never);
    const args = groupArgs(h);
    expect(args.by).toEqual(['leadId']);
    expect(args._min).toEqual({ startTime: true });
    // The answered-call rule, from the configured reached outcomes…
    const where = JSON.stringify(args.where);
    expect(where).toContain('"outcome":{"in":["call_back"]}');
    expect(where).toContain('"durationSecs":{"gt":0}');
    // …and kept only when that first one falls inside the window.
    expect(args.having).toEqual({ startTime: { _min: { gte: expect.any(Date), lte: expect.any(Date) } } });
  });

  it('defaults to the last fourteen days, and never draws more than ~three months', async () => {
    const h = harness();
    expect((await h.service.trend({} as never, { id: 'a', role: 'admin' } as never)).days).toHaveLength(14);
    expect((await h.service.trend({ from: '2025-01-01', to: '2026-11-20' } as never, { id: 'a', role: 'admin' } as never)).days).toHaveLength(92);
  });
});

/**
 * The dashboard's call cards count what Calls Made counts: a missed inbound
 * call on a known lead is the Missed Calls card's alone. It used to be counted
 * in Total, Connected and Missed at once.
 */
describe('MetricsService — call cards follow Calls Made', () => {
  async function callWheres() {
    const counts = jest.fn(async (_a: { where?: unknown }) => 0);
    const prisma = {
      lead: { count: jest.fn(async () => 0) },
      call: { count: counts },
      user: { count: jest.fn(async () => 0) },
      zoomMeeting: { count: jest.fn(async () => 0) },
      target: { aggregate: jest.fn(async () => ({ _sum: { monthlyTarget: 0 } })) },
      outcome: { findMany: jest.fn(async () => [{ slug: 'call_back' }, { slug: 'closed_won' }]) },
    } as unknown as PrismaService;
    await new MetricsService(prisma).summary({ from: '2026-11-20', to: '2026-11-20' } as MetricsQueryDto, { id: 'a', role: 'admin' } as never);
    return counts.mock.calls.map(([a]) => JSON.stringify(a?.where));
  }

  it('keeps missed inbound calls on known leads out of Total and Connected, and in Missed', async () => {
    const [total, connected, missed] = await callWheres();
    // Total: the counted-call rule.
    expect(total).toContain('"leadId":{"not":null}');
    // Connected: BOTH rules survive — the answered rule didn't overwrite the
    // missed-inbound one, which is what spreading them together could do.
    expect(connected).toContain('"leadId":{"not":null}');
    // Answered: a reached outcome, or no outcome with an answered status and talk time.
    expect(connected).toContain('"outcome":{"in":["call_back","closed_won"]}');
    expect(connected).toContain('"durationSecs":{"gt":0}');
    // Missed: the missed calls themselves.
    expect(missed).toContain('"direction":"inbound"');
    expect(missed).not.toContain('"leadId":{"not":null}');
  });
});
