import { Injectable } from '@nestjs/common';
import { LeadStatus, Prisma, Timezone, Role, ZoomMeetingStatus } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { tzLabel, UNSET_TIMEZONE_LABEL } from '../../common/timezone';
import { MetricsQueryDto } from './dto/metrics.dto';
import { CONNECTED_CALL, MISSED_INBOUND_CALL } from '../calls/call-status';

interface Node {
  total: number;
  planned: number;
}

// Parse a yyyy-mm-dd string into the first/last instant of that local day.
const dayStart = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 0, 0, 0, 0); };
const dayEnd = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 59, 999); };

@Injectable()
export class MetricsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Build the leads WHERE clause from the dashboard filter (FLT-008), scoped to
   * the caller.
   *
   * The role scope lives HERE, in the one clause every metric is built on, rather
   * than in each method. It used to be applied only inside `summary`, so the
   * chart and map endpoints — by-state, by-timezone, daily, bar, pivot — returned
   * organisation-wide lead counts to anyone who asked, including an employee who
   * may see nothing but their own book. Centralising it means a metric added
   * later is scoped by construction instead of by remembering to.
   */
  private leadWhere(q: MetricsQueryDto, user?: { id: string; role: Role }): Prisma.LeadWhereInput {
    const where: Prisma.LeadWhereInput = { deletedAt: null };
    if (user?.role === Role.employee) where.assignedToId = user.id;
    if (q.timezone) where.timezone = q.timezone;
    if (q.state) where.state = q.state;
    if (q.city) where.city = q.city;
    if (q.from || q.to) {
      // Treat from/to as whole local days so a single-day (Daily) filter spans the
      // full day rather than only the midnight instant.
      where.createdAt = {};
      if (q.from) where.createdAt.gte = dayStart(q.from);
      if (q.to) where.createdAt.lte = dayEnd(q.to);
    }
    return where;
  }

  private targetWhere(q: MetricsQueryDto): Prisma.TargetWhereInput {
    const where: Prisma.TargetWhereInput = {};
    if (q.timezone) where.timezone = q.timezone;
    if (q.state) where.state = q.state;
    if (q.city) where.city = q.city;
    return where;
  }

  /**
   * A lead counts as contacted once someone has actually reached it: a call that
   * completed, or a status of contacted-or-beyond. Derived live rather than
   * stored, so the count stays right as leads progress, are reworked or removed.
   */
  private static readonly CONTACTED: Prisma.LeadWhereInput = {
    OR: [
      { status: { in: [LeadStatus.contacted, LeadStatus.interested, LeadStatus.closed] } },
      { calls: { some: { endTime: { not: null } } } },
    ],
  };

  /**
   * DSH-001..004 / MET — the dashboard's summary cards, scoped to the caller.
   *
   * ROLE ISOLATION. This is the one place the dashboard's numbers come from, and
   * the scope is decided here rather than by the caller, so a client cannot ask
   * for someone else's figures:
   *  • employee  — every count is restricted to leads assigned to them and calls
   *    they placed. No other employee's work is reachable, and because leads have
   *    exactly one owner, no lead is counted for two people.
   *  • admin / team leader — organisation-wide totals across every employee.
   *
   * Counts deliberately reuse the same rules the underlying modules use — the
   * connected-call definition comes from call-status.ts, closed leads mean what
   * the Closed Leads module lists, follow-ups mean what the Follow-Ups page
   * shows — so a card can never disagree with the screen it summarises.
   */
  async summary(q: MetricsQueryDto, user?: { id: string; role: Role }) {
    const isEmployee = user?.role === Role.employee;
    // Already carries the employee scope — see `leadWhere`.
    const leadWhere = this.leadWhere(q, user);

    // Calls are filtered on when the call happened, matching the Calls Made
    // dashboard, and scoped to the employee who placed them.
    const callWhere: Prisma.CallWhereInput = {
      ...(isEmployee ? { callerId: user!.id } : {}),
      ...(q.from || q.to
        ? { startTime: { ...(q.from ? { gte: dayStart(q.from) } : {}), ...(q.to ? { lte: dayEnd(q.to) } : {}) } }
        : {}),
    };

    const [
      totalLeads,
      assignedLeads,
      contacted,
      followUpLeads,
      convertedLeads,
      closedLeads,
      plannedAgg,
      totalCalls,
      connectedCalls,
      missedCalls,
      scheduledCalls,
      callbackCalls,
      employeeCount,
    ] = await Promise.all([
      this.prisma.lead.count({ where: leadWhere }),
      // For an employee this necessarily equals their total: every lead they can
      // see is one assigned to them. For an admin it is the share of the book
      // that has an owner at all, which is the number that actually moves.
      //
      // The employee branch must NOT spread `assignedToId: { not: null }` over
      // the scoped clause — that key would replace the `assignedToId: <them>`
      // the scope just set, widening the count to every assigned lead in the
      // organisation. Same key, same object; the last one wins.
      this.prisma.lead.count({
        where: isEmployee ? leadWhere : { ...leadWhere, assignedToId: { not: null } },
      }),
      this.prisma.lead.count({ where: { ...leadWhere, ...MetricsService.CONTACTED } }),
      // Leads awaiting a follow-up, counted the way the Follow-Ups page lists
      // them: a callback still outstanding, or a note carrying a next date.
      // Counting LEADS (not rows) is what stops a lead with three notes being
      // counted three times.
      this.prisma.lead.count({
        where: {
          ...leadWhere,
          OR: [
            { callbackAt: { not: null }, callbackCompletedAt: null },
            { notes: { some: { nextFollowupDate: { not: null } } } },
          ],
        },
      }),
      // Converted = the lead became a real opportunity or a deal. Closed is the
      // narrower "won" set the Closed Leads module lists, so the two cards say
      // different things rather than repeating one number twice.
      this.prisma.lead.count({ where: { ...leadWhere, status: { in: [LeadStatus.interested, LeadStatus.closed] } } }),
      this.prisma.lead.count({ where: { ...leadWhere, status: LeadStatus.closed } }),
      this.prisma.target.aggregate({ where: this.targetWhere(q), _sum: { monthlyTarget: true } }),
      this.prisma.call.count({ where: callWhere }),
      this.prisma.call.count({ where: { ...callWhere, ...CONNECTED_CALL } }),
      // A genuine missed call: the customer rang in and nobody picked up. The
      // card sits directly above the Missed Calls list on the same dashboard,
      // so it counts exactly what that list shows. The broad MISSED_STATUSES
      // set would also count OUTBOUND no-answer and rejected calls — customer
      // didn't pick up, which is an outbound result, not a call anyone missed.
      this.prisma.call.count({ where: { ...callWhere, ...MISSED_INBOUND_CALL } }),
      // Zoom meetings still to happen — the Zoom Scheduled Queue in the panel.
      this.prisma.zoomMeeting.count({
        where: {
          status: { in: [ZoomMeetingStatus.scheduled, ZoomMeetingStatus.rescheduled, ZoomMeetingStatus.in_progress] },
          lead: { deletedAt: null, ...(isEmployee ? { assignedToId: user!.id } : {}) },
        },
      }),
      // Callbacks still owed — the Callback Queue in the panel.
      this.prisma.lead.count({ where: { ...leadWhere, callbackAt: { not: null }, callbackCompletedAt: null } }),
      // Denominator for the per-employee average. Only meaningful org-wide.
      isEmployee ? Promise.resolve(0) : this.prisma.user.count({ where: { role: Role.employee, isActive: true } }),
    ]);

    // Pending = assigned leads nobody has reached yet, so Contacted + Pending
    // accounts for the whole book and neither can drift from the other.
    const pendingLeads = Math.max(totalLeads - contacted, 0);
    const plannedLeads = plannedAgg._sum.monthlyTarget ?? 0;
    const balanceLeads = Math.max(plannedLeads - totalLeads, 0);
    const progressPct = plannedLeads > 0 ? Number(((totalLeads / plannedLeads) * 100).toFixed(2)) : 0;
    // Progress through the contacted pipeline — used for employees, whose target
    // is per-book rather than per-territory.
    const contactedPct = totalLeads > 0 ? Number(((contacted / totalLeads) * 100).toFixed(2)) : 0;

    return {
      /** Which set of numbers these are, so the UI can label the cards honestly. */
      scope: isEmployee ? ('personal' as const) : ('organization' as const),
      // ── Leads ──
      totalLeads,
      assignedLeads,
      contactedLeads: contacted,
      pendingLeads,
      followUpLeads,
      convertedLeads,
      closedLeads,
      /** Org-wide only — an employee has no team to average across. */
      avgLeadsPerEmployee:
        employeeCount > 0 ? Number((assignedLeads / employeeCount).toFixed(1)) : null,
      // ── Calls ──
      totalCalls,
      connectedCalls,
      missedCalls,
      scheduledCalls,
      callbackCalls,
      // ── Targets / rates (existing consumers) ──
      plannedLeads,
      balanceLeads,
      contactedPct,
      progressPct,
      /** Converted as a share of the book — a real rate, unlike progress-to-target. */
      conversionPct: totalLeads > 0 ? Number(((convertedLeads / totalLeads) * 100).toFixed(1)) : 0,
    };
  }

  /** CHT-002 — leads split by timezone (pie). */
  async byTimezone(q: MetricsQueryDto, user?: { id: string; role: Role }) {
    const grouped = await this.prisma.lead.groupBy({
      by: ['timezone'],
      where: this.leadWhere(q, user),
      _count: { _all: true },
    });
    const all: Timezone[] = ['EST', 'CST', 'MST', 'PST'];
    const rows: { timezone: string; count: number }[] = all.map((tz) => ({
      timezone: tz,
      count: grouped.find((g) => g.timezone === tz)?._count._all ?? 0,
    }));
    // Leads with no zone are a real bucket and get their own bar. Enumerating
    // only the four zones dropped them from the chart, so the breakdown quietly
    // added up to less than the lead count — and the leads that most need
    // attention (no zone, so no callback can be booked) were the invisible ones.
    const unset = grouped.find((g) => g.timezone === null)?._count._all ?? 0;
    if (unset > 0) rows.push({ timezone: UNSET_TIMEZONE_LABEL, count: unset });
    return rows;
  }

  /** MAP-002/003 — per-state totals vs targets (color-coded state map). */
  async byState(q: MetricsQueryDto, user?: { id: string; role: Role }) {
    const where = this.leadWhere(q, user);
    const [leadGroups, targetGroups, assignedGroups, contactedGroups] = await Promise.all([
      this.prisma.lead.groupBy({
        by: ['state', 'timezone'],
        where,
        _count: { _all: true },
      }),
      this.prisma.target.groupBy({
        by: ['state'],
        where: this.targetWhere(q),
        _sum: { monthlyTarget: true },
      }),
      this.prisma.lead.groupBy({
        by: ['state'],
        where: { ...where, assignedToId: { not: null } },
        _count: { _all: true },
      }),
      // Same contacted rule as summary(): a completed call exists OR the lead has
      // reached a contacted-or-beyond status.
      this.prisma.lead.groupBy({
        by: ['state'],
        where: {
          ...where,
          OR: [
            { status: { in: ['contacted', 'interested', 'closed'] } },
            { calls: { some: { endTime: { not: null } } } },
          ],
        },
        _count: { _all: true },
      }),
    ]);
    const plannedByState = new Map(targetGroups.map((t) => [t.state, t._sum.monthlyTarget ?? 0]));
    const assignedByState = new Map(assignedGroups.map((g) => [g.state, g._count._all]));
    const contactedByState = new Map(contactedGroups.map((g) => [g.state, g._count._all]));
    const totalByState = new Map<string, { total: number; timezone: string }>();
    for (const g of leadGroups) {
      // "Unassigned" for a state whose leads carry no zone, rather than
      // reporting them as Eastern.
      const cur = totalByState.get(g.state) ?? { total: 0, timezone: tzLabel(g.timezone) };
      cur.total += g._count._all;
      totalByState.set(g.state, cur);
    }
    return [...totalByState.entries()]
      .map(([state, v]) => {
        const planned = plannedByState.get(state) ?? 0;
        const progressPct = planned > 0 ? Number(((v.total / planned) * 100).toFixed(1)) : 0;
        return {
          state,
          timezone: v.timezone,
          total: v.total,
          assigned: assignedByState.get(state) ?? 0,
          contacted: contactedByState.get(state) ?? 0,
          planned,
          balance: Math.max(planned - v.total, 0),
          progressPct,
        };
      })
      .sort((a, b) => b.total - a.total);
  }

  /** CHT-003 — daily lead counts over the selected range (line). */
  async daily(q: MetricsQueryDto, user?: { id: string; role: Role }) {
    const leads = await this.prisma.lead.findMany({
      where: this.leadWhere(q, user),
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const byDay = new Map<string, number>();
    for (const l of leads) {
      const day = l.createdAt.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    return [...byDay.entries()].map(([date, count]) => ({ date, count }));
  }

  /** CHT-001 — bar chart: total / planned / balance. */
  async bar(q: MetricsQueryDto, user?: { id: string; role: Role }) {
    const s = await this.summary(q, user);
    return [
      { name: 'Total', value: s.totalLeads },
      { name: 'Planned', value: s.plannedLeads },
      { name: 'Balance', value: s.balanceLeads },
    ];
  }

  /** PVT-001/002 — Timezone › State › City pivot tree with per-level metrics. */
  async pivot(q: MetricsQueryDto, user?: { id: string; role: Role }) {
    const [leadGroups, targetGroups] = await Promise.all([
      this.prisma.lead.groupBy({
        by: ['timezone', 'state', 'city'],
        where: this.leadWhere(q, user),
        _count: { _all: true },
      }),
      this.prisma.target.groupBy({
        by: ['timezone', 'state', 'city'],
        where: this.targetWhere(q),
        _sum: { monthlyTarget: true },
      }),
    ]);

    // tz -> state -> city -> Node
    const tree = new Map<string, Map<string, Map<string, Node>>>();
    const ensure = (tz: string, st: string, ci: string): Node => {
      if (!tree.has(tz)) tree.set(tz, new Map());
      const states = tree.get(tz)!;
      if (!states.has(st)) states.set(st, new Map());
      const cities = states.get(st)!;
      if (!cities.has(ci)) cities.set(ci, { total: 0, planned: 0 });
      return cities.get(ci)!;
    };
    // Leads with no zone hang off an "Unassigned" branch of the tree, so the
    // territory view still shows them instead of silently filing them as EST.
    for (const g of leadGroups) ensure(tzLabel(g.timezone), g.state, g.city).total += g._count._all;
    for (const g of targetGroups)
      ensure(g.timezone, g.state, g.city).planned += g._sum.monthlyTarget ?? 0;

    const node = (total: number, planned: number) => ({
      total,
      planned,
      balance: Math.max(planned - total, 0),
      progressPct: planned > 0 ? Number(((total / planned) * 100).toFixed(2)) : 0,
    });

    return [...tree.entries()].map(([timezone, states]) => {
      const stateRows = [...states.entries()].map(([state, cities]) => {
        const cityRows = [...cities.entries()].map(([city, n]) => ({
          city,
          ...node(n.total, n.planned),
        }));
        const sTotal = cityRows.reduce((a, c) => a + c.total, 0);
        const sPlanned = cityRows.reduce((a, c) => a + c.planned, 0);
        return { state, ...node(sTotal, sPlanned), cities: cityRows };
      });
      const tTotal = stateRows.reduce((a, s) => a + s.total, 0);
      const tPlanned = stateRows.reduce((a, s) => a + s.planned, 0);
      return { timezone, ...node(tTotal, tPlanned), states: stateRows };
    });
  }
}
