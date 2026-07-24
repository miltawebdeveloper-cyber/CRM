import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CommDirection, LeadStatus, OutcomeCategory, Prisma, Role, Timezone } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OutcomesService } from '../outcomes/outcomes.service';
import { CommunicationsService } from '../communications/communications.service';
import { CallPivotDim, CallPivotQueryDto, CallStatsQueryDto, SetCallTargetDto, StartCallDto, EndCallDto, CreateNoteDto, UpdateFollowupDto } from './dto/call.dto';
import { closureFields } from '../leads/lead-closure';

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// yyyy-mm-dd → first/last instant of that local day, so a single-day filter
// covers the whole day rather than just the midnight instant.
const dayStart = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 0, 0, 0, 0); };
const dayEnd = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 59, 999); };

/** Provider call statuses that mean the call never connected. */
const MISSED_STATUSES = ['missed', 'no-answer', 'no_answer', 'rejected', 'declined'];
const FAILED_STATUSES = ['failed', 'busy', 'canceled', 'cancelled'];

/**
 * Status stamped on a call the agent started but never dispositioned — they shut
 * the tab, the browser died, or the dial never happened. Distinct from any
 * provider status so these are identifiable in the log rather than looking like
 * a normal completed call.
 */
const ABANDONED_STATUS = 'abandoned';

/**
 * How long a call may sit with no end time before it's treated as abandoned.
 * Generous: it must comfortably exceed the longest real call, because closing a
 * live call would truncate it.
 */
const ABANDONED_AFTER_MS = Number(process.env.ABANDONED_CALL_AFTER_MS ?? 4 * 60 * 60 * 1000);

/** Most calls one sweep will close, so a first run on a large backlog is bounded. */
const ABANDONED_BATCH = 500;

/**
 * Most calls the pivot will read in one request. The pivot aggregates in memory
 * (its dimensions include derived ones like weekday and hour, which no groupBy
 * can express), so the cap is what keeps a wide-open range from loading the whole
 * call table. The response says when it bites, rather than quietly under-counting.
 */
const PIVOT_MAX = 20_000;

/** Funnel bucket order — the axis reads Cold → … → Closed, not alphabetically. */
const BUCKET_ORDER: OutcomeCategory[] = [
  OutcomeCategory.cold,
  OutcomeCategory.warm,
  OutcomeCategory.hot,
  OutcomeCategory.connected,
  OutcomeCategory.closed_positive,
  OutcomeCategory.closed_negative,
];

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** A pivot axis value, plus the sort key that orders it. */
interface PivotKey {
  key: string;
  label: string;
  color?: string | null;
  sort: number;
}

/** The slice of a call the pivot's dimensions read. */
interface PivotCall {
  startTime: Date;
  endTime: Date | null;
  durationSecs: number | null;
  direction: CommDirection | null;
  status: string | null;
  outcome: string | null;
  caller: { id: string; name: string } | null;
  lead: { status: string } | null;
}

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly outcomesService: OutcomesService,
    private readonly comms: CommunicationsService,
  ) {}

  /**
   * Close calls that were started and never ended.
   *
   * Starting a call writes the row immediately, but only the wrap-up ends it — so
   * shutting the tab mid-call leaves a row open forever. Nothing else ever closed
   * these, and an open call is not inert: it pinned the lead at the top of the
   * caller's queue as "in progress", and marked the rep permanently On Call.
   *
   * `endTime` is set to the call's own `startTime` rather than "now", so a call
   * abandoned days ago doesn't materialise as a multi-day conversation. Duration
   * is 0 because it was never dispositioned — we genuinely don't know what
   * happened, and inventing a length would corrupt talk-time and averages.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async closeAbandonedCalls(): Promise<number> {
    if (process.env.ABANDONED_CALL_CRON === 'off') return 0;
    const cutoff = new Date(Date.now() - ABANDONED_AFTER_MS);
    const stale = await this.prisma.call.findMany({
      where: { endTime: null, startTime: { lt: cutoff } },
      select: { id: true, startTime: true },
      take: ABANDONED_BATCH,
    });
    if (stale.length === 0) return 0;

    await this.prisma.$transaction(
      stale.map((c) =>
        this.prisma.call.update({
          where: { id: c.id },
          data: { endTime: c.startTime, durationSecs: 0, status: ABANDONED_STATUS },
        }),
      ),
    );
    this.logger.log(`Closed ${stale.length} abandoned call(s) older than ${Math.round(ABANDONED_AFTER_MS / 3600_000)}h`);
    return stale.length;
  }

  /**
   * CAL-008 — start call: create the record, mark the lead in progress.
   *
   * Delegates to CommunicationsService so there is exactly ONE way an outbound
   * call gets created. This used to write a bare row of its own, which skipped
   * the caller-identity check and left `direction`, `status` and `fromNumber`
   * unset — quietly bypassing the rule that a customer must always see the
   * identity of the employee actually calling, and leaving the call invisible to
   * the inbound/outbound split.
   */
  async start(dto: StartCallDto, callerId: string) {
    const { callId } = await this.comms.startCall(dto.leadId, callerId);
    // Working a brand-new lead moves it into progress. Conditional in the WHERE
    // so it only touches a lead still sitting at `new`.
    await this.prisma.lead.updateMany({
      where: { id: dto.leadId, status: LeadStatus.new },
      data: { status: LeadStatus.in_progress },
    });
    return this.prisma.call.findUniqueOrThrow({ where: { id: callId } });
  }

  // CAL-009/010 — end call: compute duration, store outcome, update lead status
  async end(callId: string, dto: EndCallDto, callerId: string) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Call not found');
    if (call.callerId !== callerId) throw new ForbiddenException('Not your call');

    const endTime = new Date();
    const durationSecs =
      dto.durationSecs ?? Math.max(0, Math.round((endTime.getTime() - call.startTime.getTime()) / 1000));

    const oc = await this.outcomesService.bySlug(dto.outcome);
    const schedulesCallback = oc?.schedulesCallback ?? false;

    const leadObj = await this.prisma.lead.findUnique({
      where: { id: call.leadId },
      select: { assignedToId: true, status: true },
    });

    const [updated] = await this.prisma.$transaction([
      this.prisma.call.update({
        where: { id: callId },
        data: { endTime, durationSecs, outcome: dto.outcome, recordingUrl: dto.recordingUrl },
      }),
      this.prisma.lead.update({
        where: { id: call.leadId },
        data: {
          callStatus: dto.outcome,
          ...(oc?.leadStatus ? { status: oc.leadStatus } : {}),
          // An outcome that closes the lead moves it to Closed Leads, credited
          // to the caller who logged the outcome.
          ...closureFields(oc?.leadStatus ?? undefined, leadObj?.status, callerId),
          ...(schedulesCallback
            ? {
                // (Re)schedule a callback — reset reminder stamps so the cron
                // fires fresh reminders for the new date.
                callbackAt: dto.callbackAt ? new Date(dto.callbackAt) : null,
                callbackCompletedAt: null,
                callbackReminderDayBeforeAt: null,
                callbackReminderDueAt: null,
                callbackReminderMissedAt: null,
              }
            : // Any other completed outcome clears the pin (removes it from the
              // pinned section / calling queue once the outcome is updated).
              { callbackCompletedAt: new Date() }),
        },
      }),
      this.prisma.activity.create({
        data: {
          leadId: call.leadId,
          userId: callerId,
          action: 'call_completed',
          newValue: dto.outcome,
          callStatus: dto.outcome,
          assignedToId: leadObj?.assignedToId ?? null,
        },
      }),
    ]);

    const lead = await this.prisma.lead.findUnique({
      where: { id: call.leadId },
      include: { assignedTo: { select: { id: true, name: true, email: true } } },
    });
    if (lead && schedulesCallback && dto.callbackAt) {
      const callbackText = `A callback for ${lead.businessName} is scheduled for ${new Date(dto.callbackAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}.`;
      await this.notifications.notifyAndEmail(
        lead.assignedToId,
        'callback_reminder',
        `Callback scheduled for ${lead.businessName}`,
        callbackText,
        { email: lead.assignedTo?.email ?? null, alsoManagers: true },
      );
    }
    return updated;
  }

  // CAL-012/013 — note after a call (lead resolved from the call record)
  async addNoteToCall(callId: string, dto: CreateNoteDto, userId: string) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Call not found');
    const note = await this.prisma.note.create({
      data: {
        leadId: call.leadId,
        callId,
        noteText: dto.noteText,
        nextFollowupDate: dto.nextFollowupDate ? new Date(dto.nextFollowupDate) : undefined,
        ...(dto.callbackAt ? { nextFollowupDate: new Date(dto.callbackAt) } : {}),
        createdById: userId,
      },
    });
    // Mirror the note onto the lead's Comments so Lead Management shows the latest
    // remark without opening the record. The note row above is the history; this
    // field is just the newest entry, denormalized for the list column.
    const text = dto.noteText?.trim();
    if (text) {
      await this.prisma.lead.update({ where: { id: call.leadId }, data: { comments: text } });
    }
    return note;
  }

  // CAL-015 — call + note history for a lead.
  // PERM: recordings / transcripts / AI summaries are admin + team-leader only,
  // the same rule the timeline and the Recordings tab enforce. Fields are listed
  // explicitly rather than via `include`, so a sensitive column added to Call in
  // future can't leak here by default.
  async history(leadId: string, current: { role: Role }) {
    const canViewRecordings = current.role === Role.admin || current.role === Role.team_leader;
    const calls = await this.prisma.call.findMany({
      where: { leadId },
      orderBy: { startTime: 'desc' },
      select: {
        id: true, leadId: true, callerId: true, startTime: true, endTime: true,
        durationSecs: true, outcome: true, direction: true, status: true,
        fromNumber: true, createdAt: true,
        recordingUrl: true, transcript: true, aiSummary: true,
        caller: { select: { id: true, name: true } },
        notes: { orderBy: { createdAt: 'desc' } },
      },
    });
    return calls.map((c) => ({
      ...c,
      recordingUrl: canViewRecordings ? c.recordingUrl : null,
      transcript: canViewRecordings ? c.transcript : null,
      aiSummary: canViewRecordings ? c.aiSummary : null,
    }));
  }

  // CAL-001..005 — caller dashboard KPIs
  async callerDashboard(callerId: string) {
    const today = startOfToday();
    const [assigned, todaysCalls] = await Promise.all([
      this.prisma.lead.count({ where: { assignedToId: callerId, deletedAt: null } }),
      this.prisma.call.findMany({
        where: { callerId, endTime: { gte: today } },
        select: { durationSecs: true },
      }),
    ]);
    const callsCompleted = todaysCalls.length;
    const productiveSecs = todaysCalls.reduce((a, c) => a + (c.durationSecs ?? 0), 0);
    const avgCallSecs = callsCompleted > 0 ? Math.round(productiveSecs / callsCompleted) : 0;
    return {
      assignedLeads: assigned,
      callsCompleted,
      pendingLeads: Math.max(assigned - callsCompleted, 0),
      productiveSecs,
      avgCallSecs,
    };
  }

  // CAL-016/017 — next unworked assigned lead (lowest leadId, skip closed/rejected)
  async nextLead(callerId: string) {
    const lead = await this.prisma.lead.findFirst({
      where: {
        assignedToId: callerId,
        deletedAt: null,
        status: { notIn: ['closed', 'rejected'] },
      },
      orderBy: [{ status: 'asc' }, { leadId: 'asc' }],
    });
    return lead ?? null;
  }

  // CAL-013 — upcoming follow-ups (notes with a next follow-up date).
  // Employees only see follow-ups for their own assigned leads; managers see
  // all and may filter by a specific caller via `userId`.
  async followups(current: { id: string; role: Role }, userId?: string) {
    const isManager = current.role === Role.admin || current.role === Role.team_leader;
    const targetUserId = isManager ? userId : current.id; // employees forced to own
    const [notes, leads] = await Promise.all([
      this.prisma.note.findMany({
        where: {
          nextFollowupDate: { not: null },
          ...(targetUserId ? { lead: { assignedToId: targetUserId } } : {}),
        },
        orderBy: { nextFollowupDate: 'asc' },
        take: 50,
        select: {
          id: true,
          noteText: true,
          nextFollowupDate: true,
          lead: { select: { id: true, businessName: true, phone: true, city: true, state: true, timezone: true, status: true, callbackAt: true, callbackCompletedAt: true } },
          createdBy: { select: { name: true } },
        },
      }),
      this.prisma.lead.findMany({
        where: {
          callbackAt: { not: null },
          callbackCompletedAt: null,
          deletedAt: null,
          ...(targetUserId ? { assignedToId: targetUserId } : {}),
        },
        orderBy: { callbackAt: 'asc' },
        take: 50,
        select: {
          id: true,
          businessName: true,
          phone: true,
          city: true,
          state: true,
          timezone: true,
          status: true,
          callbackAt: true,
          callbackCompletedAt: true,
          assignedTo: { select: { name: true } },
        },
      }),
    ]);
    return [
      ...notes.map((n) => ({
        kind: 'note' as const,
        id: n.id,
        noteText: n.noteText,
        nextFollowupDate: n.nextFollowupDate,
        caller: n.createdBy?.name ?? null,
        completedAt: null,
        lead: n.lead,
      })),
      ...leads.map((l) => ({
        kind: 'lead' as const,
        id: l.id,
        noteText: `Callback for ${l.businessName}`,
        nextFollowupDate: l.callbackAt,
        caller: l.assignedTo?.name ?? null,
        completedAt: l.callbackCompletedAt,
        lead: {
          id: l.id,
          businessName: l.businessName,
          phone: l.phone,
          city: l.city,
          state: l.state,
          timezone: l.timezone,
          status: l.status,
          callbackAt: l.callbackAt,
          callbackCompletedAt: l.callbackCompletedAt,
        },
      })),
    ].sort((a, b) => {
      const at = a.nextFollowupDate ? new Date(a.nextFollowupDate).getTime() : 0;
      const bt = b.nextFollowupDate ? new Date(b.nextFollowupDate).getTime() : 0;
      return at - bt;
    });
  }

  async updateFollowup(kind: 'note' | 'lead', id: string, dto: UpdateFollowupDto, userId: string) {
    if (kind === 'note') {
      const note = await this.prisma.note.findUnique({ where: { id } });
      if (!note) throw new NotFoundException('Follow-up not found');
      return this.prisma.note.update({
        where: { id },
        data: {
          ...(dto.noteText !== undefined ? { noteText: dto.noteText } : {}),
          ...(dto.followUpAt !== undefined ? { nextFollowupDate: dto.followUpAt ? new Date(dto.followUpAt) : null } : {}),
        },
      });
    }

    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('Follow-up not found');
    const updated = await this.prisma.lead.update({
      where: { id },
      data: {
        ...(dto.followUpAt !== undefined ? { callbackAt: dto.followUpAt ? new Date(dto.followUpAt) : null } : {}),
        callbackCompletedAt: null,
      },
    });
    await this.prisma.activity.create({
      data: {
        leadId: id,
        userId,
        action: 'updated',
        oldValue: lead.callbackAt?.toISOString() ?? null,
        newValue: dto.followUpAt ?? null,
      },
    });
    return updated;
  }

  async completeFollowup(kind: 'note' | 'lead', id: string, userId: string) {
    if (kind === 'note') {
      const note = await this.prisma.note.findUnique({ where: { id } });
      if (!note) throw new NotFoundException('Follow-up not found');
      await this.prisma.activity.create({
        data: { leadId: note.leadId, userId, action: 'completed', oldValue: note.nextFollowupDate?.toISOString() ?? null, newValue: null },
      });
      return this.prisma.note.update({ where: { id }, data: { nextFollowupDate: null } });
    }

    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('Follow-up not found');
    await this.prisma.activity.create({
      data: { leadId: id, userId, action: 'completed', oldValue: lead.callbackAt?.toISOString() ?? null, newValue: null },
    });
    return this.prisma.lead.update({ where: { id }, data: { callbackCompletedAt: new Date() } });
  }

  async outcomes(
    query: { from?: string; to?: string; outcome?: string; userId?: string },
    current: { id: string; role: Role },
  ) {
    // Employees see only their own outcomes; managers/admins see all and may
    // filter by a specific caller (req 6 dashboard).
    const isManager = current.role === Role.admin || current.role === Role.team_leader;
    const callerId = isManager ? query.userId : current.id;
    return this.prisma.call.findMany({
      where: {
        ...(callerId ? { callerId } : {}),
        ...(query.from || query.to
          ? {
              createdAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lt: new Date(query.to) } : {}),
              },
            }
          : {}),
        ...(query.outcome ? { outcome: query.outcome } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        outcome: true,
        createdAt: true,
        lead: {
          select: { id: true, businessName: true, phone: true, status: true, callbackAt: true, callbackCompletedAt: true },
        },
        caller: { select: { id: true, name: true, email: true } },
      },
    });
  }

  /**
   * WHERE clause shared by the Calls Made dashboard's stats and its detail rows,
   * so the cards and the table can never describe different sets of calls.
   * Employees are pinned to their own calls; managers see everyone and may
   * narrow to one caller.
   */
  private async callsMadeWhere(query: CallStatsQueryDto, current: { id: string; role: Role }): Promise<Prisma.CallWhereInput> {
    const isManager = current.role === Role.admin || current.role === Role.team_leader;
    const callerId = isManager ? query.userId : current.id;

    // Geography / lead-status filters resolve against the call's lead.
    const lead: Prisma.LeadWhereInput = {};
    if (query.timezone) lead.timezone = query.timezone as Timezone;
    if (query.state) lead.state = query.state;
    if (query.city) lead.city = query.city;
    if (query.leadStatus === 'assigned') lead.assignedToId = { not: null };
    else if (query.leadStatus === 'unassigned') lead.assignedToId = null;
    else if (query.leadStatus) lead.status = query.leadStatus as LeadStatus;

    // Outcome match. Calls store the outcome SLUG, but leads imported before the
    // outcome list existed carry the display NAME in their legacy callStatus, and
    // the old client-side filter matched either — so keep both, or historical
    // rows would silently vanish from the log when filtered.
    let outcomeWhere: Prisma.CallWhereInput = {};
    if (query.outcome) {
      const oc = await this.prisma.outcome.findUnique({ where: { slug: query.outcome }, select: { name: true } });
      const legacy = [query.outcome, ...(oc?.name ? [oc.name] : [])];
      outcomeWhere = {
        OR: [
          { outcome: query.outcome },
          ...legacy.map((v) => ({ outcome: null, lead: { callStatus: { equals: v, mode: 'insensitive' as const } } })),
        ],
      };
    }

    return {
      ...(callerId ? { callerId } : {}),
      // Filter on when the call happened, not when the row was written.
      ...(query.from || query.to
        ? {
            startTime: {
              ...(query.from ? { gte: dayStart(query.from) } : {}),
              ...(query.to ? { lte: dayEnd(query.to) } : {}),
            },
          }
        : {}),
      ...(Object.keys(lead).length ? { lead } : {}),
      ...outcomeWhere,
    };
  }

  /** Whole days covered by the range — the multiplier for a per-day target.
   *  An open-ended range has no meaningful day count. */
  private daysInRange(query: CallStatsQueryDto): number | null {
    if (!query.from || !query.to) return null;
    const ms = dayEnd(query.to).getTime() - dayStart(query.from).getTime();
    return Math.max(1, Math.round(ms / 86_400_000));
  }

  /**
   * Target dial for the range: the scoped employees' per-day call targets summed
   * and scaled by the number of days shown. Null when there's no target to speak
   * of (none configured, or an open-ended range where "per day × days" is
   * meaningless) — the dashboard hides the dial rather than showing a fake 0%.
   */
  private async targetFor(query: CallStatsQueryDto, current: { id: string; role: Role }, completed: number) {
    const days = this.daysInRange(query);
    if (days === null) return null;
    const isManager = current.role === Role.admin || current.role === Role.team_leader;
    const only = isManager ? query.userId : current.id;
    const employees = await this.prisma.employee.findMany({
      where: only ? { id: only } : {},
      select: { dailyCallTarget: true, targetMissReason: true },
    });
    const perDay = employees.reduce((sum, e) => sum + e.dailyCallTarget, 0);
    if (perDay === 0) return null;
    const target = perDay * days;
    return {
      target,
      completed,
      remaining: Math.max(target - completed, 0),
      metPct: Number(((completed / target) * 100).toFixed(1)),
      // Only meaningful for a single rep; the all-team view has no one reason.
      reason: employees.length === 1 ? employees[0].targetMissReason : null,
    };
  }

  /**
   * Calls Made — the funnel report plus raw call volume for the selected range.
   *
   * Everything on the funnel counts *calls that recorded an outcome* (`given`),
   * because an outcome is what places a call in a bucket. Raw volume counts every
   * call, so `total` is deliberately >= `given`.
   *
   * `connected` (volume) comes from `endTime` rather than the provider status:
   * every call logged through the dialer gets an end time, while `status` is only
   * set on calls that came through OpenPhone, so counting status alone would
   * report zero for manually dialled work.
   */
  async callsMadeStats(query: CallStatsQueryDto, current: { id: string; role: Role }) {
    const where = await this.callsMadeWhere(query, current);
    const [total, outgoing, incoming, connected, missed, failed, duration, byOutcome, outcomes] = await Promise.all([
      this.prisma.call.count({ where }),
      this.prisma.call.count({ where: { ...where, direction: CommDirection.outbound } }),
      this.prisma.call.count({ where: { ...where, direction: CommDirection.inbound } }),
      // Abandoned calls carry an end time so they stop reading as "in progress",
      // but they were never dispositioned — counting them as connected would
      // inflate the connect rate with calls nobody confirmed even happened.
      this.prisma.call.count({ where: { ...where, endTime: { not: null }, NOT: { status: ABANDONED_STATUS } } }),
      this.prisma.call.count({ where: { ...where, status: { in: MISSED_STATUSES } } }),
      this.prisma.call.count({ where: { ...where, status: { in: FAILED_STATUSES } } }),
      this.prisma.call.aggregate({ where, _sum: { durationSecs: true }, _avg: { durationSecs: true } }),
      this.prisma.call.groupBy({ by: ['outcome'], where, _count: { _all: true } }),
      this.prisma.outcome.findMany({
        orderBy: { sortOrder: 'asc' },
        select: { slug: true, name: true, color: true, category: true },
      }),
    ]);

    const counts = new Map(byOutcome.filter((o) => o.outcome).map((o) => [o.outcome as string, o._count._all]));
    // Every configured status appears, including the zeroes — the report is a
    // fixed checklist, so a missing row reads as a broken query, not a quiet 0.
    const byStatus = outcomes.map((o) => ({
      slug: o.slug,
      name: o.name,
      color: o.color,
      category: o.category,
      count: counts.get(o.slug) ?? 0,
    }));

    const given = byStatus.reduce((s, o) => s + o.count, 0);
    const bucket = (c: OutcomeCategory) => byStatus.filter((o) => o.category === c).reduce((s, o) => s + o.count, 0);
    const categories = {
      cold: bucket(OutcomeCategory.cold),
      warm: bucket(OutcomeCategory.warm),
      hot: bucket(OutcomeCategory.hot),
      connected: bucket(OutcomeCategory.connected),
      closedPositive: bucket(OutcomeCategory.closed_positive),
      closedNegative: bucket(OutcomeCategory.closed_negative),
    };

    const pct = (n: number) => (given > 0 ? Number(((n / given) * 100).toFixed(1)) : 0);
    const ratios = {
      // "Calls made" is the contact rate: everything that got past cold.
      callsMade: pct(categories.warm + categories.hot + categories.connected + categories.closedPositive + categories.closedNegative),
      warm: pct(categories.warm),
      hot: pct(categories.hot),
      connected: pct(categories.connected),
      closedPositive: pct(categories.closedPositive),
      closedNegative: pct(categories.closedNegative),
    };

    return {
      // ── Raw volume ──
      total,
      outgoing,
      incoming,
      connected,
      missed,
      failed,
      totalDurationSecs: duration._sum.durationSecs ?? 0,
      avgDurationSecs: Math.round(duration._avg.durationSecs ?? 0),
      connectedPct: total > 0 ? Number(((connected / total) * 100).toFixed(1)) : 0,
      // ── Funnel report ──
      given,
      byStatus,
      categories,
      ratios,
      coldPct: pct(categories.cold),
      target: await this.targetFor(query, current, given),
    };
  }

  /**
   * Resolve one call to its value on a given axis.
   *
   * Every dimension answers for *every* call, including the ones that have no
   * value for it — an un-outcomed call is "No outcome", not a dropped row — so
   * the pivot's cells always add back up to the calls that were scanned.
   *
   * Only the outcome axis carries a colour: it is configured per outcome (Admin →
   * Outcomes) so the API is its source of truth. Funnel-bucket colours live on the
   * web side, which owns the funnel's look, so this returns bare bucket keys.
   */
  private pivotKeyFor(dim: CallPivotDim, outcomes: { slug: string; name: string; color: string; category: OutcomeCategory | null }[]) {
    const bySlug = new Map(outcomes.map((o) => [o.slug, o]));
    const orderOf = new Map(outcomes.map((o, i) => [o.slug, i]));
    const none = (label: string): PivotKey => ({ key: '∅', label, sort: Number.MAX_SAFE_INTEGER });

    return (c: PivotCall): PivotKey => {
      switch (dim) {
        case CallPivotDim.employee:
          return c.caller ? { key: c.caller.id, label: c.caller.name, sort: 0 } : none('Unknown');
        case CallPivotDim.outcome: {
          const o = c.outcome ? bySlug.get(c.outcome) : undefined;
          if (!o) return none('No outcome');
          return { key: o.slug, label: o.name, color: o.color, sort: orderOf.get(o.slug) ?? 0 };
        }
        case CallPivotDim.bucket: {
          const cat = c.outcome ? bySlug.get(c.outcome)?.category ?? null : null;
          if (!cat) return none('No outcome');
          return { key: cat, label: cat, sort: BUCKET_ORDER.indexOf(cat) };
        }
        case CallPivotDim.direction:
          if (!c.direction) return none('Unknown');
          return c.direction === CommDirection.outbound
            ? { key: 'outbound', label: 'Outgoing', sort: 0 }
            : { key: 'inbound', label: 'Incoming', sort: 1 };
        case CallPivotDim.status: {
          // Same fallback the call log shows: `status` is only set on calls that
          // came through OpenPhone, so dialler-only work reads from its end time.
          const s = c.status ?? (c.endTime ? 'completed' : 'in progress');
          return { key: s, label: s, sort: 0 };
        }
        case CallPivotDim.leadStatus:
          return c.lead ? { key: c.lead.status, label: c.lead.status.replace(/_/g, ' '), sort: 0 } : none('Unknown');
        case CallPivotDim.date: {
          // Local calendar day, to match the from/to filter's day bounds.
          const d = c.startTime;
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          return { key, label: key, sort: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() };
        }
        case CallPivotDim.weekday: {
          const i = (c.startTime.getDay() + 6) % 7; // Monday-first: the working week
          return { key: WEEKDAYS[i], label: WEEKDAYS[i], sort: i };
        }
        case CallPivotDim.hour: {
          const h = c.startTime.getHours();
          return { key: String(h), label: `${String(h).padStart(2, '0')}:00`, sort: h };
        }
      }
    };
  }

  /**
   * Calls Made — a cross-tab of the range: any two dimensions against each other.
   *
   * Cells carry the raw ingredients (calls, connected, talk seconds) rather than
   * one finished measure, so the web side can switch between call count, connect
   * rate, talk time and average handle time without re-querying — and so a total
   * is always summed from the same numbers the cells show, never from a rate.
   *
   * `connected` counts calls with an end time, the same definition the Calls Made
   * stats use, so the two tabs can't disagree about what "connected" means.
   */
  async callsMadePivot(query: CallPivotQueryDto, current: { id: string; role: Role }) {
    const pivotWhere = await this.callsMadeWhere(query, current);
    const [calls, outcomes] = await Promise.all([
      this.prisma.call.findMany({
        where: pivotWhere,
        orderBy: { startTime: 'desc' },
        take: PIVOT_MAX,
        select: {
          startTime: true,
          endTime: true,
          durationSecs: true,
          direction: true,
          status: true,
          outcome: true,
          caller: { select: { id: true, name: true } },
          lead: { select: { status: true } },
        },
      }),
      this.prisma.outcome.findMany({
        orderBy: { sortOrder: 'asc' },
        select: { slug: true, name: true, color: true, category: true },
      }),
    ]);

    const rowKey = this.pivotKeyFor(query.rows, outcomes);
    const colKey = this.pivotKeyFor(query.cols, outcomes);
    const rowKeys = new Map<string, PivotKey>();
    const colKeys = new Map<string, PivotKey>();
    const cells = new Map<string, { calls: number; connected: number; secs: number }>();

    for (const c of calls) {
      const r = rowKey(c);
      const k = colKey(c);
      if (!rowKeys.has(r.key)) rowKeys.set(r.key, r);
      if (!colKeys.has(k.key)) colKeys.set(k.key, k);
      // NUL-separated: keys are names, slugs and statuses ("in progress"),
      // any of which may contain a space — a printable separator could split a key.
      const id = `${r.key}\u0000${k.key}`;
      const cell = cells.get(id) ?? { calls: 0, connected: 0, secs: 0 };
      cell.calls += 1;
      // Same "connected" definition the stats use, so the two tabs can't disagree.
      if (c.endTime && c.status !== ABANDONED_STATUS) cell.connected += 1;
      cell.secs += c.durationSecs ?? 0;
      cells.set(id, cell);
    }

    // Only the values actually present become axes — an axis of mostly-empty rows
    // is noise. Sort key first, then label, so ties (employees, statuses) read
    // alphabetically instead of in insertion order.
    const order = (a: PivotKey, b: PivotKey) => a.sort - b.sort || a.label.localeCompare(b.label);
    const rows = [...rowKeys.values()].sort(order);
    const cols = [...colKeys.values()].sort(order);
    const rowIx = new Map(rows.map((d, i) => [d.key, i]));
    const colIx = new Map(cols.map((d, i) => [d.key, i]));
    const axis = ({ key, label, color }: PivotKey) => ({ key, label, color: color ?? null });

    return {
      rows: rows.map(axis),
      cols: cols.map(axis),
      // Sparse: a pivot of, say, employee × hour is mostly empty, and sending only
      // the cells that have calls keeps the payload proportional to the data.
      cells: [...cells].map(([id, v]) => {
        const [rk, ck] = id.split('\u0000');
        return { r: rowIx.get(rk)!, c: colIx.get(ck)!, ...v };
      }),
      scanned: calls.length,
      /** True when the range holds more calls than one pivot may read. */
      truncated: calls.length === PIVOT_MAX,
    };
  }

  /**
   * The selected rep's lead book: what they are holding, and how much of it is
   * worked off. "Completed" is a lead that reached a terminal status — the same
   * closed/rejected pair the calling queue treats as done — so the balance is
   * what's genuinely left to call.
   *
   * Deliberately *not* date-filtered. A lead book is a stock, not a flow, and the
   * Lead model records no assignment date to range it by; the date filter on this
   * dashboard governs calls. The UI says so where it shows these numbers, rather
   * than letting them look like they moved with the range.
   *
   * Scoped like every other read here: employees get their own book, managers may
   * ask for one rep's, and no filter means every assigned lead on the team.
   */
  async leadBook(userId: string | undefined, current: { id: string; role: Role }) {
    const isManager = current.role === Role.admin || current.role === Role.team_leader;
    const only = isManager ? userId : current.id;
    const where: Prisma.LeadWhereInput = {
      deletedAt: null,
      // Unassigned leads belong to nobody's book, so they're never in the count.
      ...(only ? { assignedToId: only } : { assignedToId: { not: null } }),
    };
    const [assigned, completed] = await Promise.all([
      this.prisma.lead.count({ where }),
      this.prisma.lead.count({ where: { ...where, status: { in: [LeadStatus.closed, LeadStatus.rejected] } } }),
    ]);
    return { assigned, completed, balance: Math.max(assigned - completed, 0) };
  }

  /** Read the per-employee call target (managers, or a rep reading their own). */
  async getCallTarget(userId: string) {
    const e = await this.prisma.employee.findUnique({
      where: { id: userId },
      select: { dailyCallTarget: true, targetMissReason: true },
    });
    if (!e) throw new NotFoundException('No employee record for this user');
    return e;
  }

  /** Set a rep's per-day call target and miss reason (managers only). */
  async setCallTarget(userId: string, dto: SetCallTargetDto) {
    const exists = await this.prisma.employee.findUnique({ where: { id: userId }, select: { id: true } });
    if (!exists) throw new NotFoundException('No employee record for this user');
    return this.prisma.employee.update({
      where: { id: userId },
      data: {
        ...(dto.dailyCallTarget !== undefined ? { dailyCallTarget: dto.dailyCallTarget } : {}),
        // Empty string clears the note.
        ...(dto.targetMissReason !== undefined ? { targetMissReason: dto.targetMissReason.trim() || null } : {}),
      },
      select: { dailyCallTarget: true, targetMissReason: true },
    });
  }

  /**
   * The values the Calls Made filters can offer, for the date + employee scope.
   *
   * Deliberately ignores the geography/outcome filters themselves: deriving the
   * options from already-filtered rows would collapse the State menu to the one
   * state you just picked, leaving no way to switch away from it. Scanning is
   * capped like the pivot, so a wide-open range can't read the whole call table.
   */
  async callsMadeFilterOptions(query: CallStatsQueryDto, current: { id: string; role: Role }) {
    const where = await this.callsMadeWhere({ from: query.from, to: query.to, userId: query.userId }, current);
    const calls = await this.prisma.call.findMany({
      where,
      select: { lead: { select: { timezone: true, state: true, city: true, callStatus: true } } },
      take: PIVOT_MAX,
    });

    // Whole triples, so the web side can cascade timezone → state → city without
    // another request and without offering combinations that have no calls.
    const geo = new Map<string, { timezone: string; state: string; city: string }>();
    const callStatuses = new Set<string>();
    for (const { lead } of calls) {
      if (!lead) continue;
      geo.set(`${lead.timezone} ${lead.state} ${lead.city}`, {
        timezone: lead.timezone,
        state: lead.state,
        city: lead.city,
      });
      if (lead.callStatus) callStatuses.add(lead.callStatus);
    }

    return {
      geo: [...geo.values()].sort((a, b) => a.state.localeCompare(b.state) || a.city.localeCompare(b.city)),
      /** Legacy imported statuses still present in the data, so they stay filterable. */
      callStatuses: [...callStatuses].sort((a, b) => a.localeCompare(b)),
    };
  }

  /**
   * Calls Made — the detail rows behind the stats, same filter and scope.
   *
   * PERM: `recordingUrl` is a signature-authorized provider link — whoever holds
   * it can fetch the audio with no CRM session — so it is redacted for anyone
   * below team leader, matching the Recordings tab and the audio proxy. Without
   * this, an employee could read (and export) recordings they may not play.
   */
  async callsMadeRecords(query: CallStatsQueryDto, current: { id: string; role: Role }) {
    const canViewRecordings = current.role === Role.admin || current.role === Role.team_leader;
    const calls = await this.prisma.call.findMany({
      where: await this.callsMadeWhere(query, current),
      orderBy: { startTime: 'desc' },
      take: 500,
      select: {
        id: true,
        startTime: true,
        endTime: true,
        durationSecs: true,
        direction: true,
        status: true,
        outcome: true,
        recordingUrl: true,
        lead: {
          select: {
            id: true, leadId: true, businessName: true, contactName: true, phone: true, status: true,
            timezone: true, state: true, city: true, callStatus: true, assignedToId: true,
          },
        },
        caller: { select: { id: true, name: true, email: true } },
      },
    });
    return calls.map((c) => ({
      ...c,
      // Whether a recording EXISTS is safe for anyone who can see the call, and is
      // what the export reports. The signed provider URL stays manager-only —
      // employees play their own recordings through the permission-checked proxy.
      hasRecording: !!c.recordingUrl,
      recordingUrl: canViewRecordings ? c.recordingUrl : null,
    }));
  }

  // CAL-006 — caller's assigned lead queue.
  // Single queue ordering:
  //   0 — today's PENDING callbacks (pinned, stay until completed/rescheduled)
  //   1 — active/ongoing calls (newest first — a new/received call jumps to top)
  //   2 — backlog: leads not yet called/handled (waiting)
  //   3 — completed/closed (pushed to the bottom, kept with their outcome/status)
  async myLeads(callerId: string) {
    const startOfDay = startOfToday();
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    const isToday = (d?: Date | null) => !!d && d >= startOfDay && d <= endOfToday;

    const leads = await this.prisma.lead.findMany({
      where: { assignedToId: callerId, deletedAt: null },
      orderBy: { leadId: 'asc' },
      take: 200,
    });

    // Most recent call per lead made today, to derive each lead's call state.
    const calls = await this.prisma.call.findMany({
      where: { callerId, startTime: { gte: startOfDay, lte: endOfToday } },
      orderBy: { startTime: 'desc' },
      select: { leadId: true, startTime: true, endTime: true, outcome: true },
    });
    const latestByLead = new Map<string, { startTime: Date; endTime: Date | null; outcome: string | null }>();
    for (const c of calls) {
      if (!latestByLead.has(c.leadId)) latestByLead.set(c.leadId, c); // desc order → first seen is newest
    }

    const enriched = leads.map((l) => {
      const call = latestByLead.get(l.id) ?? null;
      return {
        ...l,
        lastCallAt: call?.startTime ?? null,
        lastCallEndedAt: call?.endTime ?? null,
        lastOutcome: call?.outcome ?? null,
      };
    });
    type Row = (typeof enriched)[number];

    const rank = (l: Row) => {
      const closed = l.status === 'closed' || l.status === 'rejected';
      if (!l.callbackCompletedAt && isToday(l.callbackAt)) return 0; // today's pending callback (pinned)
      if (l.lastCallAt && !l.lastCallEndedAt) return 1; // call in progress / ongoing
      if (l.lastCallEndedAt || closed) return 3; // completed call or closed lead → bottom
      return 2; // backlog: waiting / not yet handled
    };

    return enriched.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 0) return (a.callbackAt?.getTime() ?? 0) - (b.callbackAt?.getTime() ?? 0);
      if (ra === 1) return (b.lastCallAt?.getTime() ?? 0) - (a.lastCallAt?.getTime() ?? 0);
      if (ra === 3) return (b.lastCallEndedAt?.getTime() ?? 0) - (a.lastCallEndedAt?.getTime() ?? 0);
      return a.leadId.localeCompare(b.leadId);
    });
  }
}
