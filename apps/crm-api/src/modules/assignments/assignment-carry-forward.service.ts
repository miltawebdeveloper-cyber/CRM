import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AssignmentType, LeadStatus, Prisma, Timezone, ZoomMeetingStatus } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { dayInZone } from '../../common/timezone';

/**
 * The widest the US can be behind the server. IST is UTC+5:30 and Hawaii is
 * UTC-10, so a lead's local day can start up to ~15.5h after the server's. Used
 * only to keep the candidate query small — the decision itself is made per lead
 * against its own calendar, never against this number.
 */
const MAX_US_LAG_HOURS = 24;

/**
 * Beyond this many hours ahead, an appointment is certainly on a later calendar
 * day in every zone the CRM carries — so the lead holding it can be dropped in
 * SQL rather than fetched and rejected per-zone.
 *
 * The reasoning: "today" in some zone is a day that CONTAINS now, so it ends at
 * most one day-length after now. 26 rather than 24 because a day is 25 hours
 * long on the autumn clock change, and this filter has to be conservative in one
 * direction only — including a lead that turns out to be booked costs one
 * comparison in `due()`, whereas excluding one that was genuinely due costs it
 * its place in a day's queue.
 */
const APPOINTMENT_HORIZON_HOURS = 26;

/** Meeting states that still represent an appointment somebody intends to keep. */
const LIVE_MEETING_STATUSES = [
  ZoomMeetingStatus.scheduled,
  ZoomMeetingStatus.in_progress,
  ZoomMeetingStatus.rescheduled,
];

export interface CarryForwardResult {
  /** Leads re-stamped into their own new day. */
  carried: number;
  /** Reps those leads belong to — unchanged by this sweep, only counted. */
  callers: number;
  /** Considered but left alone because their local day hasn't turned yet. */
  notYetTheirTomorrow: number;
  /** Left alone because they already hold an appointment on a later day. */
  bookedForALaterDay: number;
  ranAt: Date;
}

/**
 * Roll a lead with unfinished work into ITS OWN next day, owner unchanged.
 *
 * A lead assigned on the 13th that nobody got to is still the 13th's assignment
 * as far as the record is concerned, so every view asking "what is assigned
 * today" answers no, and the rep's day looks empty while their book is full.
 * This re-stamps those leads so they read as the current day's work.
 *
 * UNFINISHED, NOT MERELY UNTOUCHED. The sweep used to require that nobody had
 * EVER worked the lead — one call, one saved outcome, and the lead was out of
 * scope for the rest of its life. That is right for a lead that reached a
 * conclusion and wrong for the far commoner one that did not: a call that rang
 * out, a number that was busy, a call the agent started and never dispositioned.
 * Those leads were worked, are still open, and nobody has agreed a time to try
 * again — they are exactly the pending work tomorrow's queue is for, and they
 * were the leads the old rule dropped. What takes a lead out of scope now is
 * being FINISHED (closed or rejected) or being BOOKED (an appointment on a later
 * day), never merely having been dialled once.
 *
 * NOTHING ABOUT THE LEAD ITSELF MOVES. This writes one assignment row and reads
 * everything else. In particular `Lead.createdAt` — the original creation
 * timestamp Lead Management shows as Created Date & Time — is not in the write
 * at all and cannot be disturbed by a carry-forward, however many days a lead is
 * carried. Neither is any call, note, comment or activity: the lead is the same
 * record on a new day, never a copy of one.
 *
 * THE DAY IS THE LEAD'S, NOT THE SERVER'S. This runs on an Indian clock against
 * American leads: IST is 9.5–13.5 hours ahead, so for the entire Indian evening
 * the server's date is already tomorrow while every US lead is still on
 * yesterday's. A server-local midnight boundary would sweep the whole book
 * forward at 00:00 IST — which is lunchtime on the east coast and still the
 * previous morning in Hawaii — moving leads off a date they are still being
 * worked on. So each lead is compared against the calendar in ITS OWN zone, and
 * moves only once that zone genuinely reaches the next day.
 *
 * THREE THINGS THIS DELIBERATELY DOES NOT DO:
 *
 *  1. It never moves a lead between people. The new row names the SAME caller,
 *     always. Handing an unworked lead to somebody else overnight is precisely
 *     the automatic redistribution that was removed from the availability module
 *     for concentrating whole books onto one rep.
 *  2. It never rewrites history. Yesterday's rows stay exactly as they were, so
 *     the trail still shows when the lead was first assigned, by whom, and every
 *     day it has been carried since.
 *  3. It never duplicates a lead. One lead has one record; carrying it forward
 *     changes which day that record is scheduled for and nothing else. A second
 *     row for tomorrow would split the lead's calls, notes and history across
 *     two leads that are the same company.
 */
@Injectable()
export class AssignmentCarryForwardService {
  private readonly logger = new Logger(AssignmentCarryForwardService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Hourly, not nightly. "The day ended" is not one instant across a book that
   * runs from Hawaii to the east coast — there are five hours between the first
   * zone turning midnight and the last. An hourly sweep moves each lead shortly
   * after ITS day genuinely ends; a single nightly run would have to pick one
   * moment and be wrong for every zone but one.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async scheduledRun() {
    if (process.env.ASSIGNMENT_CARRY_FORWARD_CRON === 'off') return;
    const r = await this.run();
    if (r.carried > 0) {
      this.logger.log(`Carried ${r.carried} unfinished lead(s) into their new local day across ${r.callers} rep(s)`);
    }
  }

  /**
   * Leads eligible to be considered.
   *
   * Deliberately only the two tests SQL can answer for every lead identically:
   * the lead is open and owned, and its last stamp is old enough to be worth
   * looking at. Everything else depends on the lead's own zone, which SQL would
   * have to evaluate per row against a different offset each time, so `due()`
   * makes the real decision. The net is bounded by MAX_US_LAG_HOURS, so it is a
   * day's worth of rows, not the whole book.
   *
   * Note what is NOT here any more: a test that nobody has ever worked the lead.
   * A lead dialled once and left open — no answer, busy, a call that was never
   * dispositioned — is pending work, and excluding it was what kept it out of
   * every following day's queue.
   */
  private where(now: Date): Prisma.LeadWhereInput {
    const horizon = new Date(now.getTime() + APPOINTMENT_HORIZON_HOURS * 3600_000);
    return {
      deletedAt: null,
      assignedToId: { not: null },
      // A closed or rejected lead is finished, not pending. Carrying one would
      // put dead leads into the day's numbers every morning, forever. This is
      // the outcome list doing the work: a disposition that ends a lead maps to
      // one of these statuses, so "finished" is read from where the rep put the
      // lead rather than from a second list of endings kept in this file.
      status: { notIn: [LeadStatus.closed, LeadStatus.rejected] },
      // Nothing stamped within the last day can possibly need carrying yet, in
      // any zone. Cheap pre-filter only; the per-zone test below is the rule.
      assignments: {
        none: { assignedAt: { gte: new Date(now.getTime() - MAX_US_LAG_HOURS * 3600_000) } },
      },
      /**
       * Drop the leads booked well into the future here rather than in `due()`.
       *
       * They are never carried, so their assignment stamp never moves, so they
       * match the window above forever — and the read below is capped at 5,000
       * rows. A book with more than 5,000 appointments on it would fill that cap
       * with leads the sweep is only going to reject, and the leads that DO need
       * carrying would never be reached. That is starvation, and it would get
       * quietly worse as the book grew.
       *
       * Written as a positive OR, not as a NOT. `NOT (completed IS NULL AND
       * callback > horizon)` is the obvious phrasing and is wrong in SQL: for a
       * lead with no callback at all the comparison is NULL, the conjunction is
       * NULL, and NOT NULL is not true — so the filter would silently exclude
       * every lead that has never had an appointment, which is most of them.
       */
      OR: [
        { callbackAt: null },
        { callbackCompletedAt: { not: null } },
        { callbackAt: { lte: horizon } },
      ],
      zoomMeetings: { none: { status: { in: LIVE_MEETING_STATUSES }, scheduledAt: { gt: horizon } } },
    };
  }

  /** How many leads the next run would carry — read-only, for the admin view. */
  async preview(): Promise<number> {
    const { due } = await this.due(new Date());
    return due.length;
  }

  /**
   * Decide, per lead, between three answers: carry it, its day hasn't turned
   * yet, or it is already booked for a later day.
   *
   * Every comparison is between calendar DAYS read in the lead's zone. A lead
   * assigned at 18:00 IST on the 14th is stamped at an instant that is still the
   * 13th in New York — so it reads as a 13th lead and stays one until New York
   * itself reaches the 14th, which is the example in the spec.
   */
  private async due(now: Date) {
    const leads = await this.prisma.lead.findMany({
      where: this.where(now),
      select: {
        id: true,
        assignedToId: true,
        timezone: true,
        // The lead's own outcome, used only to word the remark: a lead that has
        // been dialled carries one, a lead nobody has reached does not. Reading
        // it off the lead costs nothing, where counting activity rows to say the
        // same thing would be a join per candidate.
        callStatus: true,
        // The appointment side of "is this lead already spoken for". `callbackAt`
        // is the scheduled call and `callbackCompletedAt` is what makes it open;
        // the open LeadFollowup rung mirrors this pair, so the scalar answers it
        // without the join.
        callbackAt: true,
        callbackCompletedAt: true,
        zoomMeetings: {
          where: { status: { in: LIVE_MEETING_STATUSES } },
          orderBy: { scheduledAt: 'desc' },
          take: 1,
          select: { scheduledAt: true },
        },
        assignments: {
          orderBy: { assignedAt: 'desc' },
          take: 1,
          select: { assignedAt: true },
        },
      },
      // Bounded: a first run against a long-neglected book shouldn't open a
      // transaction over tens of thousands of rows. The rest are picked up by
      // the next hourly run — carrying a lead stamps it for today, which takes
      // it out of the window above, so successive runs work through the backlog
      // rather than re-reading the same rows.
      //
      // Ordered so "the first 5,000" is a stable, meaningful set rather than
      // whatever the planner returns: import order is this CRM's default
      // everywhere, so a capped sweep clears the oldest part of the book first.
      orderBy: { importSeq: 'asc' },
      take: 5_000,
    });

    const due: Array<{ id: string; assignedToId: string; timezone: Timezone | null; callStatus: string | null }> = [];
    let notYet = 0;
    let booked = 0;
    for (const l of leads) {
      const today = dayInZone(now, l.timezone);
      const last = l.assignments[0]?.assignedAt;
      // A lead with an assignment stamped for today is today's work already;
      // nothing to move. (No assignment row at all means the lead was assigned
      // by a route that predates the history table — carry it, so it starts
      // being stamped properly.)
      if (last && dayInZone(last, l.timezone) >= today) {
        notYet++;
        continue;
      }

      /**
       * Already booked for a later day — leave it there.
       *
       * A lead with an appointment beyond today is scheduled FOR that day, by
       * agreement with the customer, and re-stamping it into today would make
       * every "assigned today" view claim a call nobody intends to make until
       * next Tuesday. An appointment due TODAY or already overdue is the
       * opposite: that is pending work, and it belongs on today's queue.
       *
       * The overdue case also has its own machinery — CallbackRolloverService
       * moves the appointment itself to the next working day and tells the rep.
       * The two agree by construction: once that has run, the appointment is in
       * the future and this test parks the lead until the day arrives.
       */
      const appointment = this.nextAppointment(l);
      if (appointment && dayInZone(appointment, l.timezone) > today) {
        booked++;
        continue;
      }

      due.push({ id: l.id, assignedToId: l.assignedToId!, timezone: l.timezone, callStatus: l.callStatus });
    }
    return { due, notYet, booked };
  }

  /** The furthest-out commitment on a lead: a scheduled call still open, or a
   *  live Zoom meeting. Null when the lead is on nobody's calendar. */
  private nextAppointment(lead: {
    callbackAt: Date | null;
    callbackCompletedAt: Date | null;
    zoomMeetings: { scheduledAt: Date }[];
  }): Date | null {
    const callback = lead.callbackCompletedAt ? null : lead.callbackAt;
    const meeting = lead.zoomMeetings[0]?.scheduledAt ?? null;
    if (!callback) return meeting;
    if (!meeting) return callback;
    return callback > meeting ? callback : meeting;
  }

  async run(): Promise<CarryForwardResult> {
    const ranAt = new Date();
    const { due, notYet, booked } = await this.due(ranAt);
    if (due.length === 0) {
      return { carried: 0, callers: 0, notYetTheirTomorrow: notYet, bookedForALaterDay: booked, ranAt };
    }

    const callers = new Set<string>();
    const rows = due.map((l) => {
      callers.add(l.assignedToId);
      return {
        leadId: l.id,
        callerId: l.assignedToId,
        // Same person on both sides: this is a re-stamp, not a handover, and
        // recording a "previous caller" would imply the lead changed hands.
        previousCallerId: null,
        // Attributed to the owner rather than to a manager who did nothing. The
        // column is non-null, and inventing an assigner is how an audit trail
        // starts naming people for actions they never took.
        assignedById: l.assignedToId,
        type: AssignmentType.carry_forward,
        // Says which day the lead moved TO and why it was still outstanding, so
        // the row reads as an account of the move on its own — this is what the
        // lead's Assignment History shows and what the export reports.
        remarks:
          `Moved to the next day (${dayInZone(ranAt, l.timezone)} in the lead's time zone) — ` +
          `${l.callStatus ? `last call left incomplete (${l.callStatus})` : 'not yet worked'}. ` +
          `Same lead, same owner; original created date unchanged.`,
        isActive: true,
        assignedAt: ranAt,
      };
    });

    // The previous active row is closed and the new one opened together, so a
    // lead is never briefly shown as having two active assignments (or none).
    await this.prisma.$transaction([
      this.prisma.assignment.updateMany({
        where: { leadId: { in: due.map((l) => l.id) }, isActive: true },
        data: { isActive: false },
      }),
      this.prisma.assignment.createMany({ data: rows }),
    ]);

    return {
      carried: due.length,
      callers: callers.size,
      notYetTheirTomorrow: notYet,
      bookedForALaterDay: booked,
      ranAt,
    };
  }
}
