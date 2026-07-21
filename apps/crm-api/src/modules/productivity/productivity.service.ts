import { Injectable } from '@nestjs/common';
import { OutcomeCategory } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * How long a call with no end time can still be treated as live. Nothing closes
 * an abandoned call, so without a bound one stale row marks a rep "On Call"
 * indefinitely. A real call comfortably fits inside this.
 */
const STALE_CALL_MS = 4 * 60 * 60 * 1000; // 4 hours

export type Period = 'day' | 'week' | 'month';
function since(period: Period): Date {
  if (period === 'week') return new Date(Date.now() - 7 * 86400_000);
  if (period === 'month') return new Date(Date.now() - 30 * 86400_000);
  return startOfToday();
}

@Injectable()
export class ProductivityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Which outcome slugs count as a won deal / a scheduled callback, read from the
   * configurable Outcome list.
   *
   * These used to be the literals 'closed_deal' and 'callback', neither of which
   * is a configured slug (they are `closed_won` / `closed_lost` and `call_back`),
   * so both metrics reported a permanent zero. Deriving them from the outcome's
   * category and its schedulesCallback flag means renaming or adding an outcome
   * can't silently zero the dashboard again.
   */
  private async outcomeGroups() {
    const [won, callbacks] = await Promise.all([
      this.prisma.outcome.findMany({ where: { category: OutcomeCategory.closed_positive }, select: { slug: true } }),
      this.prisma.outcome.findMany({ where: { schedulesCallback: true }, select: { slug: true } }),
    ]);
    return {
      won: won.map((o) => o.slug),
      callbacks: callbacks.map((o) => o.slug),
    };
  }

  /** PRD-005 — per-caller productivity table, scoped to a period. */
  async perCaller(period: Period = 'day') {
    const today = since(period);
    const callers = await this.prisma.user.findMany({
      where: { role: 'employee', isActive: true },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    });

    const [assignedByStatus, callsToday] = await Promise.all([
      this.prisma.lead.groupBy({
        by: ['assignedToId', 'status'],
        where: { deletedAt: null, assignedToId: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.call.groupBy({
        by: ['callerId'],
        where: { endTime: { gte: today } },
        _count: { _all: true },
        _sum: { durationSecs: true },
      }),
    ]);

    const callsMap = new Map(
      callsToday.map((c) => [c.callerId, { calls: c._count._all, secs: c._sum.durationSecs ?? 0 }]),
    );

    return callers.map((c) => {
      const statuses = assignedByStatus.filter((a) => a.assignedToId === c.id);
      const assigned = statuses.reduce((a, s) => a + s._count._all, 0);
      const closed = statuses.find((s) => s.status === 'closed')?._count._all ?? 0;
      const interested = statuses.find((s) => s.status === 'interested')?._count._all ?? 0;
      const calls = callsMap.get(c.id);
      const productiveSecs = calls?.secs ?? 0;
      return {
        id: c.id,
        name: c.name,
        email: c.email,
        callsToday: calls?.calls ?? 0,
        leadsCompleted: closed + interested,
        assigned,
        conversionPct: assigned > 0 ? Number(((closed / assigned) * 100).toFixed(1)) : 0,
        productiveSecs,
        workHours: Number((productiveSecs / 3600).toFixed(1)),
      };
    });
  }

  /** CAL-023 — end-of-day call summary per caller. */
  async dailySummary() {
    const today = startOfToday();
    const [callers, calls, groups] = await Promise.all([
      this.prisma.user.findMany({
        where: { role: 'employee', isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.call.findMany({
        where: { endTime: { gte: today } },
        select: { callerId: true, outcome: true },
      }),
      this.outcomeGroups(),
    ]);
    const won = new Set(groups.won);
    const callback = new Set(groups.callbacks);
    return callers.map((c) => {
      const mine = calls.filter((x) => x.callerId === c.id);
      const connected = mine.filter((x) => x.outcome && !['no_answer', 'busy'].includes(x.outcome)).length;
      return {
        id: c.id,
        name: c.name,
        callsMade: mine.length,
        connected,
        callbacks: mine.filter((x) => x.outcome && callback.has(x.outcome)).length,
        deals: mine.filter((x) => x.outcome && won.has(x.outcome)).length,
      };
    });
  }

  /** MGR-001..005 — live team status + KPIs. */
  async teamLive() {
    const today = startOfToday();
    const groups = await this.outcomeGroups();
    const [callers, openCalls, callsToday, closedToday, best] = await Promise.all([
      this.prisma.user.findMany({
        where: { role: 'employee', isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      // "On Call" must mean a call happening NOW. Nothing ever closes a call that
      // was abandoned (agent shut the tab mid-call), so an unbounded endTime:null
      // query left that rep showing as On Call forever. Only calls started within
      // the last few hours can plausibly still be live.
      this.prisma.call.findMany({
        where: { endTime: null, startTime: { gte: new Date(Date.now() - STALE_CALL_MS) } },
        select: { callerId: true },
      }),
      this.prisma.call.aggregate({
        where: { endTime: { gte: today } },
        _count: { _all: true },
        _sum: { durationSecs: true },
      }),
      this.prisma.call.count({ where: { endTime: { gte: today }, outcome: { in: groups.won } } }),
      this.prisma.call.groupBy({
        by: ['callerId'],
        where: { endTime: { gte: today } },
        _count: { _all: true },
        orderBy: { _count: { callerId: 'desc' } },
        take: 1,
      }),
    ]);

    const onCall = new Set(openCalls.map((c) => c.callerId));
    const totalCalls = callsToday._count._all;
    const totalTalkSecs = callsToday._sum.durationSecs ?? 0;
    const bestId = best[0]?.callerId;
    const bestCaller = callers.find((c) => c.id === bestId);

    return {
      kpis: {
        totalCallsToday: totalCalls,
        totalTalkSecs,
        conversionRate: totalCalls > 0 ? Number(((closedToday / totalCalls) * 100).toFixed(1)) : 0,
        bestPerformer: bestCaller ? { name: bestCaller.name, calls: best[0]._count._all } : null,
      },
      team: callers.map((c) => ({
        id: c.id,
        name: c.name,
        status: onCall.has(c.id) ? 'On Call' : 'Idle',
      })),
    };
  }
}
