import { Injectable } from '@nestjs/common';
import { LeadStatus, Prisma, Role, ZoomMeetingStatus } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { ALL_TIMEZONES, tzLabel, UNSET_TIMEZONE_LABEL } from '../../common/timezone';
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
   *
   * Note this is a fragment, always spread onto an already-scoped clause — it is
   * never the whole WHERE. The Contacted card counts contacted leads WITHIN the
   * assigned set, not across the whole book.
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
   *
   * THE LEAD CARDS RECONCILE BY CONSTRUCTION. Two nested sets, and every card
   * says which one it belongs to:
   *
   *   Total       = every lead in scope
   *    ├ Unassigned = no owner yet — nobody can have worked it
   *    └ Assigned   = has an owner (an employee's own book — so = Total)
   *        ├ Contacted = of those, the ones reached
   *        └ Balance   = Assigned − Contacted
   *       Follow-up / Converted / Onboarding are further cuts of ASSIGNED.
   *
   *   Progress    = Contacted ÷ Assigned × 100, or 0 with nothing assigned
   *
   * Every count below Assigned is measured inside it. That is not a detail:
   * Follow-up, Converted and Onboarding used to be counted across the whole
   * book while Contacted was counted inside Assigned, so an admin could be shown
   * more Converted leads than Contacted ones — a lead reported as won that the
   * row above said nobody had spoken to. Sharing one denominator is what stops a
   * card exceeding the row it is a subset of.
   *
   * The trade this makes: a lead that is closed but has NO owner (worked and
   * then unassigned, or imported with a status) no longer reaches the Onboarding
   * card, though the Closed Leads module still lists it. That is the lesser
   * inconsistency — the module answers "what is closed", this row answers "what
   * has the team done with the leads it holds", and a row that cannot add up is
   * worse than a row that is honestly about a smaller set.
   */
  async summary(q: MetricsQueryDto, user?: { id: string; role: Role }) {
    const isEmployee = user?.role === Role.employee;
    // Already carries the employee scope — see `leadWhere`.
    const leadWhere = this.leadWhere(q, user);

    // The assigned book: the denominator the Contacted, Balance and Progress
    // cards are all measured against.
    //
    // For an employee this is simply their own leads — every lead they can see is
    // one assigned to them, so their Total and Assigned agree by construction.
    // For an admin it is the share of the book that has an owner at all, which is
    // the number that actually moves.
    //
    // The employee branch must NOT spread `assignedToId: { not: null }` over the
    // scoped clause — that key would replace the `assignedToId: <them>` the scope
    // just set, widening every count to the whole organisation. Same key, same
    // object; the last one wins. Deriving the clause once, here, is what stops
    // that mistake being re-made per metric.
    const assignedWhere: Prisma.LeadWhereInput = isEmployee
      ? leadWhere
      : { ...leadWhere, assignedToId: { not: null } };

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
      this.prisma.lead.count({ where: assignedWhere }),
      // Contacted leads out of the ASSIGNED ones — the card reads as a share of
      // the row above it, and Balance is exactly the remainder. Counting across
      // the whole book instead would let an admin's Contacted exceed a plausible
      // fraction of Assigned, and would make Assigned − Contacted meaningless.
      this.prisma.lead.count({ where: { ...assignedWhere, ...MetricsService.CONTACTED } }),
      // Leads awaiting a follow-up, counted the way the Follow-Ups page lists
      // them: a callback still outstanding, or a note carrying a next date.
      // Counting LEADS (not rows) is what stops a lead with three notes being
      // counted three times.
      this.prisma.lead.count({
        where: {
          ...assignedWhere,
          OR: [
            { callbackAt: { not: null }, callbackCompletedAt: null },
            { notes: { some: { nextFollowupDate: { not: null } } } },
          ],
        },
      }),
      // Converted = the lead became a real opportunity or a deal. Closed is the
      // narrower "won" set the Closed Leads module lists, so the two cards say
      // different things rather than repeating one number twice.
      this.prisma.lead.count({ where: { ...assignedWhere, status: { in: [LeadStatus.interested, LeadStatus.closed] } } }),
      this.prisma.lead.count({ where: { ...assignedWhere, status: LeadStatus.closed } }),
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

    // Balance = assigned leads nobody has reached yet. Contacted + Balance is
    // exactly Assigned, so the three cards always reconcile and neither can
    // drift from the other. `Math.max` is belt-and-braces: contacted is counted
    // within the assigned set, so it can never exceed it.
    const balanceLeads = Math.max(assignedLeads - contacted, 0);
    // The rest of the book — leads nobody owns yet. Reported rather than left
    // implicit so Total adds up on screen: without it an admin saw Total 471 and
    // Assigned 181 with no account of the other 290, which read as a figure the
    // dashboard had lost rather than work not yet handed out. Always 0 for an
    // employee, whose scope is their own assigned leads by definition.
    const unassignedLeads = Math.max(totalLeads - assignedLeads, 0);
    // The progress bar measures how far through the assigned book the team is —
    // contacted over assigned. With nothing assigned there is nothing to be a
    // fraction of, so progress is 0 rather than a divide-by-zero NaN.
    const progressPct = assignedLeads > 0 ? Number(((contacted / assignedLeads) * 100).toFixed(2)) : 0;

    // ── Targets ──
    // A different question entirely: how the book compares to the monthly target
    // set per territory. Kept under `target…` names so it can't be mistaken for
    // the contacted progress above — the two used to share the names `balanceLeads`
    // and `progressPct`, which is how a target number ended up on a card that
    // claimed to be about contacting leads.
    const plannedLeads = plannedAgg._sum.monthlyTarget ?? 0;
    const targetBalanceLeads = Math.max(plannedLeads - totalLeads, 0);
    const targetProgressPct = plannedLeads > 0 ? Number(((totalLeads / plannedLeads) * 100).toFixed(2)) : 0;

    return {
      /** Which set of numbers these are, so the UI can label the cards honestly. */
      scope: isEmployee ? ('personal' as const) : ('organization' as const),
      // ── Leads ──
      totalLeads,
      /** Total minus assigned — the leads still waiting to be handed out. */
      unassignedLeads,
      assignedLeads,
      contactedLeads: contacted,
      /** Assigned minus contacted — the leads still owed a first conversation. */
      balanceLeads,
      /** Contacted ÷ assigned, as a percentage. Drives the progress bar. */
      progressPct,
      // All three are cuts of the ASSIGNED book, like Contacted and Balance —
      // see the header note on why they can't be counted across Total.
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
      // ── Targets / rates ──
      plannedLeads,
      targetBalanceLeads,
      targetProgressPct,
      /**
       * Converted as a share of the ASSIGNED book — a real rate, unlike
       * progress-to-target.
       *
       * Over `totalLeads` it would divide an assigned-scoped numerator by a
       * whole-book denominator, which is the same mismatch the cards above had:
       * every lead not yet handed out would drag the rate down as though the
       * team had tried and failed to convert it.
       */
      conversionPct: assignedLeads > 0 ? Number(((convertedLeads / assignedLeads) * 100).toFixed(1)) : 0,
    };
  }

  /** CHT-002 — leads split by timezone (pie). */
  async byTimezone(q: MetricsQueryDto, user?: { id: string; role: Role }) {
    const grouped = await this.prisma.lead.groupBy({
      by: ['timezone'],
      where: this.leadWhere(q, user),
      _count: { _all: true },
    });
    // Read off the enum rather than a hand-written list: the four US zones used
    // to be spelled out here, so UK, India, Alaska and Hawaii leads would have
    // been dropped from the chart the day they became selectable.
    const rows: { timezone: string; count: number }[] = ALL_TIMEZONES.map((tz) => ({
      timezone: tz,
      count: grouped.find((g) => g.timezone === tz)?._count._all ?? 0,
    }));
    // Leads with no zone are a real bucket and get their own bar. Enumerating
    // only the configured zones dropped them from the chart, so the breakdown
    // quietly added up to less than the lead count — and the leads that most need
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

  /**
   * CHT-001 — bar chart: total / planned / balance.
   *
   * "Balance" here is the shortfall against the monthly target, not the
   * uncontacted balance the dashboard cards show — this chart sits beside
   * Planned, so it is the target sense of the word.
   */
  async bar(q: MetricsQueryDto, user?: { id: string; role: Role }) {
    const s = await this.summary(q, user);
    return [
      { name: 'Total', value: s.totalLeads },
      { name: 'Planned', value: s.plannedLeads },
      { name: 'Balance', value: s.targetBalanceLeads },
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
