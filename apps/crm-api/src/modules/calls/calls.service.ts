import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CommDirection, LeadStatus, OutcomeCategory, Prisma, Role, Timezone, ZoomMeetingStatus } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OutcomesService } from '../outcomes/outcomes.service';
import { CommunicationsService } from '../communications/communications.service';
import { CallPivotDim, CallPivotQueryDto, CallStatsQueryDto, SetCallTargetDto, StartCallDto, EndCallDto, CreateNoteDto, UpdateFollowupDto } from './dto/call.dto';
import { closureFields } from '../leads/lead-closure';
import { COMPLETION_ACTIONS, completedOpenLeadCounts, productiveSeconds } from './work-time';
import { ABANDONED_STATUS, FAILED_STATUSES, MISSED_INBOUND_CALL, MISSED_STATUSES } from './call-status';
import { formatInZone, parseFutureInZone, parseInZone, timezoneWhere, tzLabel } from '../../common/timezone';

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// yyyy-mm-dd → first/last instant of that local day, so a single-day filter
// covers the whole day rather than just the midnight instant.
const dayStart = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 0, 0, 0, 0); };
const dayEnd = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 59, 999); };

// Connected / missed / failed live in call-status.ts so the dashboard's summary
// cards count calls by exactly the same rules this module reports them under.

/**
 * Most leads one calling queue will return. Generous, because the queue and the
 * Assigned Leads card describe the same book and must agree — a cap that bites
 * shows the agent fewer leads than they are told they hold.
 */
const QUEUE_MAX = 2_000;

// The queue's default order is `lead.importSeq` — the position the lead held in
// the file it was imported from. It replaced a `compareLeadId` helper that
// unpicked `L-2026-42` into a prefix and a number to sort ids in their true
// sequence: correct as far as it went, but the id is not the import order when
// an import supplies its own ids, and an integer column the database can index
// beats parsing a string on every comparison.

/**
 * How long a call may sit with no end time before it's treated as abandoned.
 * Generous: it must comfortably exceed the longest real call, because closing a
 * live call would truncate it.
 */
const ABANDONED_AFTER_MS = Number(process.env.ABANDONED_CALL_AFTER_MS ?? 4 * 60 * 60 * 1000);

/** Most calls one sweep will close, so a first run on a large backlog is bounded. */
const ABANDONED_BATCH = 500;

/** Most rows the Calls Made table carries — the tiles above it count the rest. */
const RECORDS_MAX = 500;

/**
 * The activity written when a lead is worked from the queue with no call placed.
 * These share the Calls Made log with real calls: the contact happened and the
 * team's work should be visible, but no call was dialled — so they are counted
 * apart from Total Calls Made and carry no duration.
 */
const PROCESSED_ACTION = 'lead_processed';

/** Status shown against a lead worked without a call. */
const PROCESSED_STATUS = 'processed (no call)';

/**
 * Longest processing time one lead may report, in seconds.
 *
 * The timer runs in the browser from opening a lead to pressing Save, so a tab
 * left open over lunch — or overnight — would otherwise book hours of "handling"
 * against a single lead and wreck every average built on it. An hour is far
 * beyond any genuine write-up, so anything past it is a walk-away, not work.
 */
const MAX_PROCESSING_SECS = 60 * 60;

/** Trust the client's timer only as far as a plausible processing time goes. */
function clampProcessingSecs(secs: number | undefined): number | null {
  if (secs === undefined || secs === null || !Number.isFinite(secs)) return null;
  return Math.min(Math.max(Math.round(secs), 0), MAX_PROCESSING_SECS);
}

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

    const [updated] = await this.applyDisposition(call.leadId, dto, callerId, 'call_completed', [
      this.prisma.call.update({
        where: { id: callId },
        data: { endTime, durationSecs, outcome: dto.outcome, recordingUrl: dto.recordingUrl },
      }),
    ]);
    return updated;
  }

  /**
   * Record an outcome against a lead WITHOUT a call — the queue's lead-processing
   * mode, where agents work the same queue, log the same outcomes and advance the
   * same way while dialling is switched off.
   *
   * Deliberately shares `applyDisposition` with `end`, so a lead worked in this
   * mode lands in exactly the same state as one worked on a call: same lead
   * status mapping, same closure credit, same callback scheduling and reminders.
   * The only difference is that no Call row is written — no call was made, and
   * inventing one would corrupt every calls-made figure the team reports on.
   */
  async logWithoutCall(leadId: string, dto: EndCallDto, user: { id: string; role: Role }) {
    await this.assertCanWorkLead(leadId, user);
    const [updatedLead] = await this.applyDisposition(leadId, dto, user.id, 'lead_processed');
    return updatedLead;
  }

  /**
   * Guard for the lead-processing routes: an employee may only record work
   * against a lead assigned to them.
   *
   * Without this, `POST /calls/lead/:leadId/log` took any lead id at all, so one
   * employee could disposition — and close — a lead owned by another, which is the
   * cross-assignment the panel's queue scoping is there to prevent. Managers are
   * exempt: working another rep's lead is part of their job, and every route here
   * already grants them the wider scope.
   */
  private async assertCanWorkLead(leadId: string, user: { id: string; role: Role }) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, deletedAt: null },
      select: { id: true, assignedToId: true },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    const isManager = user.role === Role.admin || user.role === Role.team_leader;
    if (!isManager && lead.assignedToId !== user.id) {
      throw new ForbiddenException('This lead is assigned to another employee.');
    }
    return lead;
  }

  /**
   * The lead-side half of a disposition: status mapping, closure credit, callback
   * (re)scheduling and the activity entry, plus the callback notification. Shared
   * by the on-call and no-call paths so the two can never drift apart.
   *
   * `extraOps` are run inside the same transaction (the call update, when there is
   * a call). The first result is returned, so callers get their own primary row.
   *
   * `callbackCarriedForward` marks a callback time that came off the lead rather
   * than from the rep — see the outcome-correction paths. It is re-saved as-is
   * and skips the "not in the past" check, because correcting last Tuesday's
   * disposition is a retrospective edit, not a new booking, and refusing it
   * would leave the rep unable to fix a typo on any callback that has since
   * come and gone.
   */
  private async applyDisposition(
    leadId: string,
    dto: EndCallDto,
    userId: string,
    action: 'call_completed' | 'lead_processed' | 'outcome_updated',
    extraOps: Prisma.PrismaPromise<unknown>[] = [],
    { callbackCarriedForward = false }: { callbackCarriedForward?: boolean } = {},
  ) {
    const oc = await this.outcomesService.bySlug(dto.outcome);
    const schedulesCallback = oc?.schedulesCallback ?? false;

    const leadObj = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { assignedToId: true, status: true, timezone: true },
    });

    // Validated before the transaction opens, so a bad time is rejected without
    // having already moved the lead's status. Both failures it catches — no zone
    // on the lead, and a time already gone in the customer's zone — used to be
    // accepted quietly and only surface later as a callback that fired at the
    // wrong hour or arrived pre-missed.
    const callbackAt = !schedulesCallback
      ? null
      : callbackCarriedForward
        ? parseInZone(dto.callbackAt, leadObj?.timezone)
        : parseFutureInZone(dto.callbackAt, leadObj?.timezone);

    // The disposition this save is REPEATING, if it is a repeat. See
    // `recentProcessedDuplicate` — only the no-call path can duplicate a row in
    // Calls Made, so only it looks.
    const supersedes = action === 'lead_processed' ? await this.recentProcessedDuplicate(leadId, userId) : null;

    /**
     * Is this a fresh contact with the lead, or a second pass at one already
     * recorded?
     *
     * A correction from the Outcome Records log is the obvious second pass, and
     * a repeated save is the other: both describe a contact that has already
     * advanced the sequence. Neither may advance it again, or fixing a typo
     * would burn a rung and a retried save would push a lead from Follow-Up 2
     * to Follow-Up 4 without anyone having called.
     */
    const revising = action === 'outcome_updated' || !!supersedes;
    const followupOps = await this.followupSequenceOps({
      leadId,
      userId,
      outcome: dto.outcome,
      callbackAt,
      schedulesCallback,
      revising,
      assignedToId: leadObj?.assignedToId ?? null,
    });

    const results = await this.prisma.$transaction([
      ...extraOps,
      this.prisma.lead.update({
        where: { id: leadId },
        data: {
          callStatus: dto.outcome,
          ...(oc?.leadStatus ? { status: oc.leadStatus } : {}),
          // An outcome that closes the lead moves it to Closed Leads, credited
          // to the caller who logged the outcome.
          ...closureFields(oc?.leadStatus ?? undefined, leadObj?.status, userId),
          // Why a lead was lost, kept in step with the disposition that lost it.
          // Nothing set this from the panel, so a lead rejected on a call showed a
          // blank Lost Reason in Lead Management and in every export — the one
          // field that explains the rejection was only fillable by hand
          // afterwards. The outcome's name IS the reason ("Not Interested",
          // "Wrong Number"), so it is recorded here and cleared again if a later
          // disposition takes the lead back out of rejected.
          ...(oc?.leadStatus === LeadStatus.rejected
            ? { lostReason: oc.name }
            : oc?.leadStatus && leadObj?.status === LeadStatus.rejected
              ? { lostReason: null }
              : {}),
          ...(schedulesCallback
            ? {
                // (Re)schedule a callback — reset reminder stamps so the cron
                // fires fresh reminders for the new date.
                //
                // The time the rep typed is the CUSTOMER's local time, so it is
                // read in the lead's zone. `new Date()` read it in the server's
                // zone, which put every callback hours out unless the server
                // happened to sit in the customer's time zone.
                callbackAt,
                callbackCompletedAt: null,
                callbackReminderDayBeforeAt: null,
                callbackReminderDueAt: null,
                callbackReminderMissedAt: null,
                // A new appointment starts with a clean on-screen slate, or the
                // popup would stay silenced by the snooze/dismiss of the old one.
                callbackSnoozedUntil: null,
                callbackDismissedAt: null,
              }
            : // Any other completed outcome clears the pin (removes it from the
              // pinned section / calling queue once the outcome is updated).
              { callbackCompletedAt: new Date() }),
        },
      }),
      // A repeat of the same no-call disposition UPDATES the row it is repeating
      // rather than adding a second one beside it. Everything the first write set
      // is re-stated, so the surviving row carries the latest outcome and the
      // latest processing time rather than a half-updated mix of the two.
      supersedes
        ? this.prisma.activity.update({
            where: { id: supersedes.id },
            data: {
              newValue: dto.outcome,
              callStatus: dto.outcome,
              assignedToId: leadObj?.assignedToId ?? null,
              remarks: 'Outcome logged from the queue while calling was disabled (no call placed).',
              durationSecs: clampProcessingSecs(dto.durationSecs),
            },
          })
        : this.prisma.activity.create({
            data: {
              leadId,
              userId,
              action,
              newValue: dto.outcome,
              callStatus: dto.outcome,
              assignedToId: leadObj?.assignedToId ?? null,
              ...(action === 'lead_processed'
                ? {
                    remarks: 'Outcome logged from the queue while calling was disabled (no call placed).',
                    // Time the agent spent on the lead — the queue times from opening
                    // it to pressing Save. With no call to measure, this is what the
                    // log and the reports use as the duration. Clamped so a tab left
                    // open overnight can't report a nine-hour "call".
                    durationSecs: clampProcessingSecs(dto.durationSecs),
                  }
                : action === 'outcome_updated'
                  ? { remarks: 'Outcome corrected from the Outcome Records log.' }
                  : {}),
            },
          }),
      // LAST, deliberately. Callers read their own row back out of `results` by
      // position — `results[correctOps.length]` is the lead update — so anything
      // added here goes on the end where it cannot shift those indices.
      ...followupOps,
    ]);

    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      include: { assignedTo: { select: { id: true, name: true, email: true } } },
    });
    if (lead?.callbackAt && schedulesCallback && dto.callbackAt) {
      // Read back off the lead rather than re-parsing the input, and stated in the
      // customer's zone with the zone named — "3:00 PM" alone is how a rep rings
      // an hour early on a lead in another part of the country.
      const callbackText = `A callback for ${lead.businessName} is scheduled for ${formatInZone(lead.callbackAt, lead.timezone)}.`;
      await this.notifications.notifyAndEmail(
        lead.assignedToId,
        'callback_reminder',
        `Callback scheduled for ${lead.businessName}`,
        callbackText,
        { email: lead.assignedTo?.email ?? null, alsoManagers: true },
      );
    }
    return results;
  }

  /**
   * The rungs a lead's follow-up ladder is expected to run to.
   *
   * Presentational, not a limit. The sequence is numbered truthfully however far
   * it runs, and a sixth callback becomes Follow-Up 6 rather than being refused:
   * an agent with a customer on the line asking to be rung again next week must
   * not be told the lead is full. What this constant does is tell the UI how many
   * rungs to lay out, so a lead on its second call shows the road ahead.
   */
  static readonly FOLLOWUP_LADDER = 5;

  /**
   * The writes that move a lead's follow-up sequence on, for one disposition.
   *
   * The sequence is the answer to "what happened, in order, and what is owed
   * next". One row per follow-up: opened when a callback is booked, closed when
   * the lead is next worked, never rewritten by the one after it.
   *
   * Four cases, and they are all the same two questions — is a follow-up open,
   * and does this outcome book another:
   *
   *  • Open one, and the agent is working it → close it with this outcome. That
   *    is the history entry: what was decided when that follow-up came due.
   *  • Outcome books a callback → open the next rung at the agreed time.
   *  • Both → close this rung and open the next, which is the ordinary
   *    Follow-Up 2 → Follow-Up 3 step.
   *  • Revising (`revising`) → the contact was already recorded, so nothing
   *    advances; a re-booked time moves the OPEN rung instead of burning a new
   *    one. Correcting a typo must not cost a lead a follow-up.
   *
   * Returned as prepared operations so they run inside the caller's transaction:
   * a sequence that advanced while the lead update rolled back would leave the
   * ladder describing a call that never happened.
   */
  private async followupSequenceOps(args: {
    leadId: string;
    userId: string;
    outcome: string;
    callbackAt: Date | null;
    schedulesCallback: boolean;
    revising: boolean;
    assignedToId: string | null;
  }): Promise<Prisma.PrismaPromise<unknown>[]> {
    const { leadId, userId, outcome, callbackAt, schedulesCallback, revising, assignedToId } = args;

    // The open rung, and the highest number used so far. They are different
    // questions: a lead whose Follow-Up 3 is closed has no open rung but has
    // certainly used 3, and the next one it books is 4, not 1.
    const [open, last] = await Promise.all([
      this.prisma.leadFollowup.findFirst({
        where: { leadId, completedAt: null },
        orderBy: { seq: 'desc' },
        select: { id: true },
      }),
      this.prisma.leadFollowup.findFirst({
        where: { leadId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      }),
    ]);

    const ops: Prisma.PrismaPromise<unknown>[] = [];

    if (revising) {
      // Re-point the open rung at the corrected time, or close it if the
      // corrected outcome no longer books a callback. Never opens a rung.
      if (open) {
        ops.push(
          this.prisma.leadFollowup.update({
            where: { id: open.id },
            data: schedulesCallback && callbackAt
              ? { scheduledAt: callbackAt, outcome, assignedToId }
              : { outcome, completedAt: new Date(), completedById: userId },
          }),
        );
      } else if (schedulesCallback && callbackAt) {
        // Nothing open to correct — the appointment has to live somewhere, so
        // this becomes the next rung rather than being lost.
        ops.push(this.createFollowup(leadId, (last?.seq ?? 0) + 1, callbackAt, assignedToId));
      }
      return ops;
    }

    if (open) {
      ops.push(
        this.prisma.leadFollowup.update({
          where: { id: open.id },
          data: { outcome, completedAt: new Date(), completedById: userId },
        }),
      );
    }
    if (schedulesCallback && callbackAt) {
      ops.push(this.createFollowup(leadId, (last?.seq ?? 0) + 1, callbackAt, assignedToId));
    }
    return ops;
  }

  /**
   * A lead's follow-up sequence, oldest rung first — the history plus whatever
   * is still owed.
   *
   * Reports `ladder` alongside so the caller doesn't hard-code how many rungs to
   * draw, and `active` so it doesn't have to work out which row is the open one
   * by scanning for a null.
   */
  async leadFollowups(leadId: string, user: { id: string; role: Role }) {
    await this.assertCanWorkLead(leadId, user);
    const rows = await this.prisma.leadFollowup.findMany({
      where: { leadId },
      orderBy: { seq: 'asc' },
      select: {
        id: true,
        seq: true,
        scheduledAt: true,
        outcome: true,
        comments: true,
        completedAt: true,
        assignedTo: { select: { id: true, name: true } },
        completedBy: { select: { id: true, name: true } },
      },
    });
    return {
      followups: rows,
      /** How many rungs the UI lays out. See `FOLLOWUP_LADDER` — not a limit. */
      ladder: CallsService.FOLLOWUP_LADDER,
      /** The rung currently owed, if any. At most one is ever open. */
      active: rows.find((r) => !r.completedAt) ?? null,
    };
  }

  /** One new rung, at `seq`, due at `scheduledAt`. */
  private createFollowup(leadId: string, seq: number, scheduledAt: Date, assignedToId: string | null) {
    return this.prisma.leadFollowup.create({
      data: { leadId, seq, scheduledAt, assignedToId },
    });
  }

  /**
   * How long after a no-call disposition a second one for the same lead, by the
   * same agent, is treated as a REPEAT of it rather than a fresh contact.
   *
   * Ten minutes is well past any retry, double-submit or replayed request, and
   * well short of a genuine second contact: an agent who works a lead, moves
   * through their queue and comes back to it is not doing that inside ten
   * minutes, and if they do, the second write is a correction of the first
   * anyway — which is exactly what it becomes.
   */
  private static readonly PROCESSED_DEDUPE_MS = 10 * 60 * 1000;

  /**
   * The no-call disposition this one would duplicate, if any.
   *
   * Why only this path needs it: a dialled call is ONE `calls` row that every
   * later write updates in place, so re-ending it cannot put a second line in
   * Calls Made. A lead worked without a call has no such row — the activity IS
   * the line — so every repeat of the write appeared as another call in the log,
   * another entry in the totals, and another item in the agent's day.
   *
   * And repeats are ordinary here, not exotic. Saving a lead is two requests,
   * the disposition and then the note; if the note fails (a follow-up time that
   * has just gone by is enough) the panel keeps the agent's work on screen and
   * invites them to press Save again — which is the right thing for it to do,
   * and which used to log the lead a second time. A refresh that replays the
   * request, a double-submit and a retried network call all land here too.
   */
  private async recentProcessedDuplicate(leadId: string, userId: string) {
    return this.prisma.activity.findFirst({
      where: {
        leadId,
        userId,
        action: PROCESSED_ACTION,
        createdAt: { gte: new Date(Date.now() - CallsService.PROCESSED_DEDUPE_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
  }

  /**
   * Correct the outcome recorded against a past call.
   *
   * A disposition is picked in seconds at the end of a call and is the single
   * field the whole funnel, the lead's status and its callback all hang off — so
   * the wrong one being picked needs a way back that isn't "ring them again".
   * The Outcome Records log is where that mistake is spotted, so it is where the
   * fix belongs.
   *
   * Goes through `applyDisposition`, exactly as ending a call does, so a
   * correction lands the lead in the state it would have been in had the right
   * outcome been chosen at the time: same status mapping, same closure credit,
   * same callback scheduling. Anything less would leave the log saying one thing
   * and the lead another, which is the problem this is meant to solve.
   *
   * The activity is logged as `outcome_updated`, deliberately NOT one of
   * COMPLETION_ACTIONS: the lead was already completed, and counting a
   * correction as a second completion would inflate the Calling Panel's figures.
   */
  async updateCallOutcome(callId: string, dto: EndCallDto, user: { id: string; role: Role }) {
    const call = await this.prisma.call.findUnique({
      where: { id: callId },
      select: { id: true, leadId: true, callerId: true, outcome: true, lead: { select: { callbackAt: true } } },
    });
    if (!call) throw new NotFoundException('Call not found');
    // Same rule the rest of this module enforces: a rep may correct their own
    // calls, a manager may correct anyone's.
    const isManager = user.role === Role.admin || user.role === Role.team_leader;
    if (!isManager && call.callerId !== user.id) throw new ForbiddenException('Not your call');

    const oc = await this.outcomesService.bySlug(dto.outcome);
    if (!oc) throw new BadRequestException('Unknown outcome');

    // An outcome that schedules a callback must end up with a date. Keep the one
    // already on the lead when the corrected outcome still schedules one and no
    // new date was given — re-picking "Call Back" shouldn't silently wipe the
    // appointment the customer is expecting. With neither, say so plainly rather
    // than writing a callback with no time on it.
    let callbackAt = dto.callbackAt;
    const carried = oc.schedulesCallback && !callbackAt;
    if (carried) {
      if (!call.lead?.callbackAt) {
        throw new BadRequestException(
          `"${oc.name}" schedules a callback, so it needs a date and time. Pick one, or set it from the Calling Panel.`,
        );
      }
      // Already an instant — parseInZone passes an explicit offset through as-is.
      callbackAt = call.lead.callbackAt.toISOString();
    }

    const [updatedCall] = await this.applyDisposition(
      call.leadId,
      { ...dto, callbackAt },
      user.id,
      'outcome_updated',
      [this.prisma.call.update({ where: { id: callId }, data: { outcome: dto.outcome } })],
      { callbackCarriedForward: carried },
    );
    return updatedCall;
  }

  /**
   * Correct a LEAD's call outcome — the inline edit on the Lead Management table.
   *
   * Same correction as `updateCallOutcome`, entered from the lead rather than
   * from a call record, so the rep can fix a mis-picked disposition while
   * scanning the list. It goes through `applyDisposition` for the same reason:
   * the outcome is not a loose label, it drives the lead's status, its closure
   * credit and its callback, and changing it anywhere has to move all of them.
   *
   * The lead's most recent CONTACT RECORD is corrected alongside it. A wrong
   * outcome was wrong on that record too, and leaving the call log saying one
   * thing while the lead says another is exactly the mismatch this is meant to
   * remove — it is also what keeps Calls Made and Analytics in step, since those
   * read the record rather than the lead.
   *
   * "Contact record", not "call", because Calls Made lists two kinds: dialled
   * calls, and leads worked from the queue with no call placed (an activity row,
   * rendered from `newValue`). This used to correct only the latest call, so a
   * lead worked while calling was switched off had nothing updated at all and
   * its row in Calls Made kept the old outcome permanently — Lead Details said
   * one thing, the log said another. Where both kinds exist, only the newer is
   * touched: an earlier call's outcome is genuine history of an earlier contact,
   * not a stale copy of this one.
   */
  async updateLeadOutcome(leadId: string, dto: EndCallDto, user: { id: string; role: Role }) {
    await this.assertCanWorkLead(leadId, user);
    const oc = await this.outcomesService.bySlug(dto.outcome);
    if (!oc) throw new BadRequestException('Unknown outcome');

    const lead = await this.prisma.lead.findUniqueOrThrow({
      where: { id: leadId },
      select: { callbackAt: true },
    });

    // An outcome that schedules a callback must end up with a date. Keep the one
    // already on the lead rather than wiping an appointment the customer is
    // expecting; with none at all, say so instead of writing a callback with no
    // time on it.
    let callbackAt = dto.callbackAt;
    const carried = oc.schedulesCallback && !callbackAt;
    if (carried) {
      if (!lead.callbackAt) {
        throw new BadRequestException(
          `"${oc.name}" schedules a callback, so it needs a date and time. Set one from the Calling Panel.`,
        );
      }
      callbackAt = lead.callbackAt.toISOString();
    }

    // The two kinds of contact record Calls Made lists, newest of each.
    const [latestCall, latestProcessed] = await Promise.all([
      this.prisma.call.findFirst({
        where: { leadId },
        orderBy: { startTime: 'desc' },
        select: { id: true, startTime: true },
      }),
      this.prisma.activity.findFirst({
        where: { leadId, action: PROCESSED_ACTION },
        orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true },
      }),
    ]);

    // Whichever happened last is the one this correction is about.
    const callAt = latestCall?.startTime.getTime() ?? -Infinity;
    const processedAt = latestProcessed?.createdAt.getTime() ?? -Infinity;
    const correctOps: Prisma.PrismaPromise<unknown>[] = [];
    if (latestProcessed && processedAt >= callAt) {
      correctOps.push(
        this.prisma.activity.update({
          where: { id: latestProcessed.id },
          // Both fields, because `applyDisposition` writes both when it creates
          // one of these rows — leaving `callStatus` behind would just move the
          // inconsistency to the Lead Activity Log.
          data: { newValue: dto.outcome, callStatus: dto.outcome },
        }),
      );
    } else if (latestCall) {
      correctOps.push(this.prisma.call.update({ where: { id: latestCall.id }, data: { outcome: dto.outcome } }));
    }

    const results = await this.applyDisposition(
      leadId,
      { ...dto, callbackAt },
      user.id,
      'outcome_updated',
      correctOps,
      { callbackCarriedForward: carried },
    );
    // The lead update sits straight after the extra ops in the transaction.
    return results[correctOps.length];
  }

  // CAL-012/013 — note after a call (lead resolved from the call record)
  async addNoteToCall(callId: string, dto: CreateNoteDto, user: { id: string; role: Role }) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Call not found');
    // Same rule `end` enforces: an employee writes up their own calls only.
    const isManager = user.role === Role.admin || user.role === Role.team_leader;
    if (!isManager && call.callerId !== user.id) throw new ForbiddenException('Not your call');
    return this.writeNote(call.leadId, callId, dto, user.id);
  }

  /**
   * The same note, written straight against the lead — used by the queue's
   * lead-processing mode, where there is no call to hang it off. Identical
   * result otherwise: a note row in the history and the lead's Comments field
   * refreshed, so Lead Management reads the same either way.
   */
  async addNoteToLead(leadId: string, dto: CreateNoteDto, user: { id: string; role: Role }) {
    await this.assertCanWorkLead(leadId, user);
    return this.writeNote(leadId, null, dto, user.id);
  }

  private async writeNote(leadId: string, callId: string | null, dto: CreateNoteDto, userId: string) {
    // A follow-up date is a wall-clock time agreed with the customer, so it is
    // read in their zone — the same rule the callback itself follows, or the note
    // and the callback it accompanies would name two different moments.
    // Held to the same two rules as the callback — the lead must have a zone,
    // and the time must not already be gone there. A note is the other way a
    // follow-up gets scheduled, so leaving it unchecked would just move the bad
    // date one field to the left. A note with no follow-up date at all is
    // unaffected: the empty value short-circuits before either check.
    const tz = (await this.prisma.lead.findUnique({ where: { id: leadId }, select: { timezone: true } }))?.timezone;
    const followUp = parseFutureInZone(dto.callbackAt ?? dto.nextFollowupDate, tz, 'follow-up');
    const note = await this.prisma.note.create({
      data: {
        leadId,
        ...(callId ? { callId } : {}),
        noteText: dto.noteText,
        ...(followUp ? { nextFollowupDate: followUp } : {}),
        createdById: userId,
      },
    });
    // Mirror the note onto the lead's Comments so Lead Management shows the latest
    // remark without opening the record. The note row above is the history; this
    // field is just the newest entry, denormalized for the list column.
    const text = dto.noteText?.trim();
    if (text) {
      await this.prisma.lead.update({ where: { id: leadId }, data: { comments: text } });
      await this.attachCommentsToFollowup(leadId, text);
    }
    return note;
  }

  /**
   * Put the agent's write-up on the follow-up it belongs to.
   *
   * Saving a lead is two requests — the disposition, then the note — so by the
   * time the words exist the sequence has already moved: `applyDisposition` has
   * closed the rung that was open. The comment belongs on THAT rung, the one the
   * agent was just working, not on the one they booked for next week, which
   * hasn't happened and has nothing to say yet.
   *
   * So: the most recently completed follow-up, and only if it is still blank —
   * a note added days later to a lead whose ladder has moved on must not rewrite
   * what was said on a call that is now history. With nothing completed yet the
   * comment simply stays on the note and the lead, where it already was.
   */
  private async attachCommentsToFollowup(leadId: string, comments: string) {
    const lastCompleted = await this.prisma.leadFollowup.findFirst({
      where: { leadId, completedAt: { not: null }, comments: null },
      orderBy: { completedAt: 'desc' },
      select: { id: true, completedAt: true },
    });
    if (!lastCompleted?.completedAt) return;
    // Only while it is still the disposition being written up. Past that it is
    // someone revisiting an old lead, and the rung keeps what it recorded.
    const age = Date.now() - lastCompleted.completedAt.getTime();
    if (age > CallsService.PROCESSED_DEDUPE_MS) return;
    await this.prisma.leadFollowup.update({ where: { id: lastCompleted.id }, data: { comments } });
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

  /**
   * CAL-001..005 — the Calling Panel's KPI cards, for the logged-in rep only.
   *
   * Assigned / Completed / Pending describe the rep's BOOK, not today: they are
   * counted from what the rep holds right now, so they survive a page refresh, a
   * logout and a new shift, and they move the moment a lead is assigned, worked or
   * reassigned. `assigned = completed + pending` always holds, because "completed"
   * is defined as a subset of the assigned leads rather than as a tally of calls.
   *
   * Productive time and the averages are today's, since they describe a sitting
   * rather than a stock.
   */
  async callerDashboard(callerId: string) {
    const today = startOfToday();
    const mine: Prisma.LeadWhereInput = { assignedToId: callerId, deletedAt: null };
    const terminal = { status: { in: [LeadStatus.closed, LeadStatus.rejected] } };

    const [assigned, closedOff, workedOpen, todaysWork, todaysCalls] = await Promise.all([
      this.prisma.lead.count({ where: mine }),
      // A lead that reached a terminal status is finished whether or not it was
      // dispositioned from this panel (a manager may have closed it).
      this.prisma.lead.count({ where: { ...mine, ...terminal } }),
      // Still-open leads this rep has saved at least once. Terminal leads are
      // excluded there, so the two counts can never double-count the same lead.
      completedOpenLeadCounts(this.prisma, [callerId]),
      // Today's saves — both the "completed today" count and the processing half
      // of productive time are derived from these.
      this.prisma.activity.findMany({
        where: { userId: callerId, action: { in: COMPLETION_ACTIONS }, createdAt: { gte: today } },
        select: { leadId: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      // Started today, not ended today: a call is productive time from the moment
      // it starts, and one still in flight has no end time to filter on.
      this.prisma.call.findMany({
        where: { callerId, startTime: { gte: today } },
        select: { startTime: true, endTime: true, durationSecs: true },
      }),
    ]);

    const completedLeads = closedOff + (workedOpen.get(callerId) ?? 0);
    const completedToday = new Set(todaysWork.map((w) => w.leadId)).size;

    // Talk time plus lead-processing time, merged so a lead dispositioned at the
    // end of its own call is counted once. See work-time.ts for the rules.
    const productiveSecs = productiveSeconds(todaysCalls, todaysWork.map((w) => w.createdAt));

    // ── Averages ──
    // Talk time only counts calls that actually finished; an in-flight call has no
    // duration yet and would drag the average to zero.
    const endedCalls = todaysCalls.filter((c) => c.endTime);
    const talkSecs = endedCalls.reduce((a, c) => a + (c.durationSecs ?? 0), 0);

    return {
      // ── Book ──
      assignedLeads: assigned,
      /** Assigned leads the rep has finished — the "Calls Completed" card. */
      callsCompleted: completedLeads,
      pendingLeads: Math.max(assigned - completedLeads, 0),
      // ── Today ──
      productiveSecs,
      /** Average talk time per finished call — shown while calling is enabled. */
      avgCallSecs: endedCalls.length > 0 ? Math.round(talkSecs / endedCalls.length) : 0,
      /** Average time per lead worked today — what the panel shows with no calls. */
      avgHandleSecs: completedToday > 0 ? Math.round(productiveSecs / completedToday) : 0,
      completedToday,
      callsToday: endedCalls.length,
      talkSecs,
    };
  }

  // CAL-016/017 — next unworked assigned lead (earliest in import order, skip
  // closed/rejected). Was `leadId: 'asc'`, a string sort that handed the rep
  // L-2026-10 before L-2026-2.
  async nextLead(callerId: string) {
    const lead = await this.prisma.lead.findFirst({
      where: {
        assignedToId: callerId,
        deletedAt: null,
        status: { notIn: ['closed', 'rejected'] },
      },
      orderBy: [{ status: 'asc' }, { importSeq: 'asc' }],
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

  /**
   * The lead a follow-up hangs off, checked against who is asking.
   *
   * Both mutations here took a bare id and acted on it. That was survivable only
   * while the Follow-Ups page was manager-only — the routes themselves have
   * always been open to any authenticated user, so an employee who knew a lead
   * id could complete or move another rep's callback. Opening the page to
   * employees turns that from a hidden edge into the front door, so the rule the
   * rest of this module enforces is enforced here too: a rep acts on their own
   * leads, a manager on anyone's.
   */
  private async assertCanWorkFollowup(kind: 'note' | 'lead', id: string, user: { id: string; role: Role }) {
    if (kind === 'lead') {
      await this.assertCanWorkLead(id, user);
      return;
    }
    const note = await this.prisma.note.findUnique({ where: { id }, select: { leadId: true } });
    if (!note) throw new NotFoundException('Follow-up not found');
    await this.assertCanWorkLead(note.leadId, user);
  }

  async updateFollowup(kind: 'note' | 'lead', id: string, dto: UpdateFollowupDto, user: { id: string; role: Role }) {
    await this.assertCanWorkFollowup(kind, id, user);
    // Rescheduling reads the new time in the LEAD's zone, exactly as the panel's
    // callback picker does — a follow-up moved from the Follow-ups page must land
    // on the same instant it would have from the Calling Panel.
    if (kind === 'note') {
      const note = await this.prisma.note.findUnique({
        where: { id },
        select: { id: true, lead: { select: { timezone: true } } },
      });
      if (!note) throw new NotFoundException('Follow-up not found');
      return this.prisma.note.update({
        where: { id },
        data: {
          ...(dto.noteText !== undefined ? { noteText: dto.noteText } : {}),
          ...(dto.followUpAt !== undefined
            ? { nextFollowupDate: parseFutureInZone(dto.followUpAt, note.lead?.timezone, 'follow-up') }
            : {}),
        },
      });
    }

    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('Follow-up not found');
    const rescheduled =
      dto.followUpAt !== undefined ? parseFutureInZone(dto.followUpAt, lead.timezone) : undefined;
    const updated = await this.prisma.lead.update({
      where: { id },
      data: {
        ...(rescheduled !== undefined ? { callbackAt: rescheduled } : {}),
        callbackCompletedAt: null,
        // A new time is a new appointment: clear the one-shot reminder stamps so
        // the cron fires against the new instant instead of staying silent because
        // it already reminded for the old one. The on-screen snooze/dismiss goes
        // with them, for the same reason — a rep who silenced this morning's
        // popup still wants the one for the time they just moved it to.
        ...(rescheduled !== undefined
          ? {
              callbackReminderDayBeforeAt: null,
              callbackReminderDueAt: null,
              callbackReminderMissedAt: null,
              callbackSnoozedUntil: null,
              callbackDismissedAt: null,
            }
          : {}),
      },
    });
    await this.prisma.activity.create({
      data: {
        leadId: id,
        userId: user.id,
        action: 'updated',
        oldValue: lead.callbackAt?.toISOString() ?? null,
        newValue: rescheduled?.toISOString() ?? null,
        remarks: rescheduled ? `Callback moved to ${formatInZone(rescheduled, lead.timezone)}` : null,
      },
    });
    return updated;
  }

  async completeFollowup(kind: 'note' | 'lead', id: string, user: { id: string; role: Role }) {
    await this.assertCanWorkFollowup(kind, id, user);
    if (kind === 'note') {
      const note = await this.prisma.note.findUnique({ where: { id } });
      if (!note) throw new NotFoundException('Follow-up not found');
      await this.prisma.activity.create({
        data: { leadId: note.leadId, userId: user.id, action: 'completed', oldValue: note.nextFollowupDate?.toISOString() ?? null, newValue: null },
      });
      return this.prisma.note.update({ where: { id }, data: { nextFollowupDate: null } });
    }

    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('Follow-up not found');
    await this.prisma.activity.create({
      data: { leadId: id, userId: user.id, action: 'completed', oldValue: lead.callbackAt?.toISOString() ?? null, newValue: null },
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
          // `timezone` so a callback rescheduled while correcting an outcome is
          // entered on the customer's clock, like everywhere else.
          select: { id: true, businessName: true, phone: true, status: true, timezone: true, callbackAt: true, callbackCompletedAt: true },
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
  /** The lead-side half of the Calls Made filter, shared with the no-call rows. */
  private leadFilter(query: CallStatsQueryDto): Prisma.LeadWhereInput {
    const lead: Prisma.LeadWhereInput = {};
    // `Unassigned` comes back from the geo options for leads with no zone and
    // has to select `timezone IS NULL`, not a zone literally named that.
    Object.assign(lead, timezoneWhere(query.timezone));
    if (query.state) lead.state = query.state;
    if (query.city) lead.city = query.city;
    if (query.leadStatus === 'assigned') lead.assignedToId = { not: null };
    else if (query.leadStatus === 'unassigned') lead.assignedToId = null;
    else if (query.leadStatus) lead.status = query.leadStatus as LeadStatus;
    return lead;
  }

  /**
   * WHERE for the leads worked WITHOUT a call — the lead-processing mode the
   * queue runs in while dialling is switched off.
   *
   * These are real contact activity and belong in the call log, but no call was
   * placed, so they carry no duration, no direction and no provider status. They
   * are sourced from the `lead_processed` activity rather than invented as call
   * rows, which is what keeps Total Calls Made honest about how much was actually
   * dialled while still showing the shift's work.
   *
   * Scoped and filtered exactly like the calls beside them: employees see their
   * own, managers may narrow to one rep, and the date, outcome and geography
   * filters all apply.
   */
  private async processedWhere(query: CallStatsQueryDto, current: { id: string; role: Role }): Promise<Prisma.ActivityWhereInput> {
    const isManager = current.role === Role.admin || current.role === Role.team_leader;
    const userId = isManager ? query.userId : current.id;
    const lead = this.leadFilter(query);

    // The disposition slug is stored in `newValue`. Legacy display names are
    // matched too, the same way the call-side outcome filter does.
    let outcomeWhere: Prisma.ActivityWhereInput = {};
    if (query.outcome) {
      const oc = await this.prisma.outcome.findUnique({ where: { slug: query.outcome }, select: { name: true } });
      outcomeWhere = { newValue: { in: [query.outcome, ...(oc?.name ? [oc.name] : [])] } };
    }

    return {
      action: PROCESSED_ACTION,
      leadId: { not: null },
      ...(userId ? { userId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: dayStart(query.from) } : {}),
              ...(query.to ? { lte: dayEnd(query.to) } : {}),
            },
          }
        : {}),
      ...(Object.keys(lead).length ? { lead } : {}),
      ...outcomeWhere,
    };
  }

  private async callsMadeWhere(query: CallStatsQueryDto, current: { id: string; role: Role }): Promise<Prisma.CallWhereInput> {
    const isManager = current.role === Role.admin || current.role === Role.team_leader;
    const callerId = isManager ? query.userId : current.id;

    // Geography / lead-status filters resolve against the call's lead.
    const lead = this.leadFilter(query);

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
      /**
       * A missed inbound call belongs to the Missed Calls module and nowhere
       * else.
       *
       * It used to appear here too — as a row in the log, in the volume tiles,
       * in the pivot and in the filter options — which double-counted it: the
       * same unanswered call was both an item of work waiting on the Missed
       * Calls tab and a "call" in a rep's totals. It also dragged the connect
       * rate down with calls nobody made: the customer rang, and the module
       * that reports what a rep DID counted the fact that nobody picked up.
       *
       * Excluded here rather than in each query, because this filter is what
       * the stats, the pivot, the records list and the filter options all build
       * on — narrowing one of them alone is how a tile starts counting rows the
       * list beneath it cannot show.
       *
       * Answered inbound calls stay. Those are real work: the rep spoke to a
       * customer, and it is only who dialled that differs.
       */
      NOT: MISSED_INBOUND_CALL,
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
    const [total, outgoing, incoming, connected, missed, failed, duration, byOutcome, outcomes, processed] = await Promise.all([
      this.prisma.call.count({ where }),
      this.prisma.call.count({ where: { ...where, direction: CommDirection.outbound } }),
      this.prisma.call.count({ where: { ...where, direction: CommDirection.inbound } }),
      // Abandoned calls carry an end time so they stop reading as "in progress",
      // but they were never dispositioned — counting them as connected would
      // inflate the connect rate with calls nobody confirmed even happened.
      // Both exclusions travel together in one AND. Spreading `...where` and
      // then writing `NOT:` beside it would REPLACE the missed-inbound
      // exclusion this filter carries rather than add to it, and the connect
      // rate would quietly go back to counting calls nobody answered.
      this.prisma.call.count({
        where: { ...where, endTime: { not: null }, AND: [{ NOT: { status: ABANDONED_STATUS } }] },
      }),
      // Unanswered — outbound calls the customer didn't pick up, plus inbound
      // ones the rep actively declined. Still shown as "Unanswered" rather than
      // "Missed Calls", and now that is simply what it holds: `where` excludes
      // missed inbound calls from this whole module, so they cannot reach this
      // bucket however wide MISSED_STATUSES is. The breakdown still adds up,
      // because those rows are outside `total` too — they are counted once, on
      // the Missed Calls tab, which is the module that owns them.
      this.prisma.call.count({ where: { ...where, status: { in: MISSED_STATUSES } } }),
      this.prisma.call.count({ where: { ...where, status: { in: FAILED_STATUSES } } }),
      this.prisma.call.aggregate({ where, _sum: { durationSecs: true }, _avg: { durationSecs: true } }),
      this.prisma.call.groupBy({ by: ['outcome'], where, _count: { _all: true } }),
      this.prisma.outcome.findMany({
        orderBy: { sortOrder: 'asc' },
        select: { slug: true, name: true, color: true, category: true },
      }),
      // Leads worked with no call placed. Counted separately from `total` on
      // purpose: they appear in the log because the contact is real work, but
      // folding them into Total Calls Made would overstate how much was dialled.
      // The time spent on them is summed apart from talk time for the same
      // reason — it is handling time, not time on the phone.
      this.prisma.activity.aggregate({
        where: await this.processedWhere(query, current),
        _count: { _all: true },
        _sum: { durationSecs: true },
        _avg: { durationSecs: true },
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
      /** Leads worked without a call — listed in the log, counted apart from `total`. */
      processed: processed._count._all,
      /** Every contact in the log, dialled or not — what the table's rows total. */
      totalContacts: total + processed._count._all,
      /** Time spent working leads in the queue. Handling time, not talk time. */
      processingSecs: processed._sum.durationSecs ?? 0,
      avgProcessingSecs: Math.round(processed._avg.durationSecs ?? 0),
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
      geo.set(`${tzLabel(lead.timezone)}\u0000${lead.state}\u0000${lead.city}`, {
        // A lead with no zone is filed under "Unassigned" rather than folded
        // into Eastern, so the cascade can still reach it.
        timezone: tzLabel(lead.timezone),
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
      take: RECORDS_MAX,
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
    // Leads worked without a call, shaped like a call row so the log reads as one
    // list. Everything a call carries is present except the things a non-call
    // genuinely hasn't got: no duration, no direction, no recording.
    const processed = await this.prisma.activity.findMany({
      where: await this.processedWhere(query, current),
      orderBy: { createdAt: 'desc' },
      take: RECORDS_MAX,
      select: {
        id: true,
        createdAt: true,
        newValue: true,
        durationSecs: true,
        lead: {
          select: {
            id: true, leadId: true, businessName: true, contactName: true, phone: true, status: true,
            timezone: true, state: true, city: true, callStatus: true, assignedToId: true,
          },
        },
        user: { select: { id: true, name: true, email: true } },
      },
    });

    const callRows = calls.map((c) => ({
      ...c,
      /** Distinguishes a dialled call from a lead worked without one. */
      kind: 'call' as const,
      // Whether a recording EXISTS is safe for anyone who can see the call, and is
      // what the export reports. The signed provider URL stays manager-only —
      // employees play their own recordings through the permission-checked proxy.
      hasRecording: !!c.recordingUrl,
      recordingUrl: canViewRecordings ? c.recordingUrl : null,
    }));

    const processedRows = processed.map((a) => ({
      // Prefixed so an activity id can never be mistaken for a call id by
      // anything keying off it — including the outcome-correction route, which
      // must not be offered on a row that has no call behind it.
      id: `processed:${a.id}`,
      kind: 'processed' as const,
      startTime: a.createdAt,
      endTime: a.createdAt,
      // How long the agent spent working the lead in the queue. Null for rows
      // written before the timer existed, which is why the column stays nullable
      // rather than defaulting to a misleading zero.
      durationSecs: a.durationSecs,
      direction: null,
      status: PROCESSED_STATUS,
      outcome: a.newValue,
      recordingUrl: null,
      hasRecording: false,
      lead: a.lead,
      caller: a.user,
    }));

    // One chronological log. Each side is capped, so the merge is capped too;
    // the tiles above the table report the true totals either way.
    return [...callRows, ...processedRows]
      .sort((x, y) => y.startTime.getTime() - x.startTime.getTime())
      .slice(0, RECORDS_MAX);
  }

  // CAL-006 — caller's assigned lead queue.
  //
  // OWNERSHIP: every row comes from `assignedToId = callerId`. A lead belongs to
  // exactly one employee, so nothing else may widen this — it is the query that
  // decides whose leads land in whose panel.
  //
  // Single queue ordering:
  //   0 — Callback leads due today (sorted by scheduled time callbackAt asc)
  //   1 — Zoom meetings scheduled for today (sorted by meeting time scheduledAt asc)
  //   2 — active/ongoing calls (newest first)
  //   3 — regular calling queue (backlog, ascending lead sequence order)
  //   4 — future scheduled Callbacks and Zoom meetings (sorted by scheduled date asc)
  //   5 — completed calls / closed leads (bottom)
  async myLeads(callerId: string) {
    const startOfDay = startOfToday();
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    const isToday = (d?: Date | null) => !!d && d >= startOfDay && d <= endOfToday;

    const leads = await this.prisma.lead.findMany({
      where: { assignedToId: callerId, deletedAt: null },
      include: {
        zoomMeetings: {
          where: {
            status: { in: [ZoomMeetingStatus.scheduled, ZoomMeetingStatus.in_progress, ZoomMeetingStatus.rescheduled] },
          },
          orderBy: { scheduledAt: 'asc' },
          take: 1,
          select: {
            id: true,
            title: true,
            scheduledAt: true,
            durationMins: true,
            status: true,
            joinUrl: true,
            meetingId: true,
          },
        },
      },
      // Import order — the sequence the leads arrived in. NOT `leadId: 'asc'`: a
      // string sort would make the cap below keep L-2026-1000..1099 and drop
      // L-2026-2, i.e. truncate the wrong end of the queue. NOT `createdAt`
      // either: an import writes hundreds of rows inside one millisecond, so the
      // cap would cut an arbitrary set of them. The final in-memory sort orders
      // what comes back.
      orderBy: { importSeq: 'asc' },
      // Was 200, which silently truncated the queue of anyone holding more — the
      // Assigned Leads card counted the whole book while the queue below it showed
      // a fraction, and the leads past the cut were unreachable from the panel.
      take: QUEUE_MAX,
    });

    // Most recent call per lead made today, to derive each lead's call state.
    const calls = await this.prisma.call.findMany({
      where: { callerId, startTime: { gte: startOfDay, lte: endOfToday } },
      orderBy: { startTime: 'desc' },
      select: { leadId: true, startTime: true, endTime: true, outcome: true },
    });
    const latestByLead = new Map<string, { startTime: Date; endTime: Date | null; outcome: string | null }>();
    for (const c of calls) {
      if (!latestByLead.has(c.leadId)) latestByLead.set(c.leadId, c);
    }

    // Leads this rep has already saved today. Without this the panel only knew a
    // lead was finished from `lastCallEndedAt`, which nothing stamps when calling
    // is off — so a reload handed the agent a lead they had just worked. Read from
    // the server, so it survives a refresh, a re-login and a queue refresh.
    const workedToday = await this.prisma.activity.findMany({
      where: {
        userId: callerId,
        action: { in: COMPLETION_ACTIONS },
        createdAt: { gte: startOfDay, lte: endOfToday },
        leadId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { leadId: true, createdAt: true },
    });
    const workedByLead = new Map<string, Date>();
    for (const w of workedToday) {
      if (w.leadId && !workedByLead.has(w.leadId)) workedByLead.set(w.leadId, w.createdAt);
    }

    const enriched = leads.map((l) => {
      const call = latestByLead.get(l.id) ?? null;
      const nextZoom = l.zoomMeetings?.[0] ?? null;
      return {
        ...l,
        lastCallAt: call?.startTime ?? null,
        lastCallEndedAt: call?.endTime ?? null,
        lastOutcome: call?.outcome ?? null,
        /** When this rep last saved the lead today — null if they haven't. */
        lastWorkedAt: workedByLead.get(l.id) ?? null,
        nextZoomMeeting: nextZoom,
      };
    });
    type Row = (typeof enriched)[number];

    /** When a finished lead was finished — the call ending, or the save. */
    const finishedAt = (l: Row) =>
      Math.max(l.lastCallEndedAt?.getTime() ?? 0, l.lastWorkedAt?.getTime() ?? 0) || null;

    const rank = (l: Row) => {
      const closed = l.status === 'closed' || l.status === 'rejected';
      // `lastWorkedAt` is what keeps a lead saved with dialling off from bobbing
      // back to the top of the queue after a refresh.
      if (closed || l.lastCallEndedAt || l.lastWorkedAt) return 5; // finished → bottom

      const isCallbackDueToday = !l.callbackCompletedAt && l.callbackAt && (isToday(l.callbackAt) || l.callbackAt < startOfDay);
      if (isCallbackDueToday) return 0; // 1. Callback leads due today (or overdue)

      const isZoomDueToday = l.nextZoomMeeting && (isToday(l.nextZoomMeeting.scheduledAt) || l.nextZoomMeeting.scheduledAt < startOfDay);
      if (isZoomDueToday) return 1; // 2. Zoom meetings scheduled for today (or overdue)

      if (l.lastCallAt && !l.lastCallEndedAt) return 2; // call in progress

      const isFutureCallback = !l.callbackCompletedAt && l.callbackAt && l.callbackAt > endOfToday;
      const isFutureZoom = l.nextZoomMeeting && l.nextZoomMeeting.scheduledAt > endOfToday;

      if (isFutureCallback || isFutureZoom) return 4; // future scheduled items

      return 3; // regular calling queue (backlog)
    };

    /**
     * Import order is the queue's default — the file's first lead first, and the
     * order the panel walks the agent through. Only genuinely time-critical work
     * overrides it, and only within its own band: an appointment at a stated hour
     * has to come before an appointment an hour later, whatever their position in
     * the file. Every other band, including the backlog the agent spends the day
     * in, reads in strict import order.
     *
     * Each comparator ends in `bySeq`, so the order is TOTAL — `importSeq` is
     * unique, so no two leads can ever compare equal. That is what stops the
     * queue reshuffling between refreshes and handing the agent a lead they have
     * already passed.
     */
    return enriched.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      const byId = a.importSeq - b.importSeq;
      // Bands 0/1 are appointments: soonest first, then ascending id.
      if (ra === 0) return (a.callbackAt?.getTime() ?? 0) - (b.callbackAt?.getTime() ?? 0) || byId;
      if (ra === 1) {
        return (a.nextZoomMeeting?.scheduledAt.getTime() ?? 0) - (b.nextZoomMeeting?.scheduledAt.getTime() ?? 0) || byId;
      }
      if (ra === 2) return (b.lastCallAt?.getTime() ?? 0) - (a.lastCallAt?.getTime() ?? 0) || byId;
      if (ra === 4) {
        const soonest = (l: Row) =>
          Math.min(
            l.callbackAt && !l.callbackCompletedAt ? l.callbackAt.getTime() : Infinity,
            l.nextZoomMeeting ? l.nextZoomMeeting.scheduledAt.getTime() : Infinity,
          );
        return soonest(a) - soonest(b) || byId;
      }
      // Finished leads sit at the bottom, most recently finished first, so the
      // agent can see what they just did without it re-entering the run.
      if (ra === 5) return (finishedAt(b) ?? 0) - (finishedAt(a) ?? 0) || byId;
      return byId; // band 3 — the backlog, strictly in import order
    });
  }
}
