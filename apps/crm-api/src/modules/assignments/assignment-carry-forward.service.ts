import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AssignmentType, LeadStatus, Prisma, Timezone } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { dayInZone } from '../../common/timezone';

/** Dispositions that mean somebody worked the lead. Same list the queue uses. */
const COMPLETION_ACTIONS = ['call_completed', 'lead_processed', 'outcome_updated'];

/**
 * The widest the US can be behind the server. IST is UTC+5:30 and Hawaii is
 * UTC-10, so a lead's local day can start up to ~15.5h after the server's. Used
 * only to keep the candidate query small — the decision itself is made per lead
 * against its own calendar, never against this number.
 */
const MAX_US_LAG_HOURS = 24;

export interface CarryForwardResult {
  /** Leads re-stamped into their own new day. */
  carried: number;
  /** Reps those leads belong to — unchanged by this sweep, only counted. */
  callers: number;
  /** Considered but left alone because their local day hasn't turned yet. */
  notYetTheirTomorrow: number;
  ranAt: Date;
}

/**
 * Roll an untouched lead into ITS OWN next day, with its owner unchanged.
 *
 * A lead assigned on the 13th that nobody got to is still the 13th's assignment
 * as far as the record is concerned, so every view asking "what is assigned
 * today" answers no, and the rep's day looks empty while their book is full.
 * This re-stamps those leads so they read as the current day's work.
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
 *  3. It never touches a lead somebody has worked. One call, one saved outcome,
 *     and the lead is out of scope — the assignment did its job and the
 *     follow-up machinery owns what happens next.
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
      this.logger.log(`Carried ${r.carried} unworked lead(s) into their new local day across ${r.callers} rep(s)`);
    }
  }

  /**
   * Leads eligible to be considered.
   *
   * "Never worked" is read from the activity trail rather than from a field on
   * the lead: a status can be edited by hand, whereas an activity row is written
   * when the work actually happened.
   *
   * The date test is NOT here. It cannot be — the boundary depends on each row's
   * own `timezone`, which SQL would have to evaluate per row against a different
   * offset each time. This query casts a slightly wide net and `run` makes the
   * real decision per lead. The net is bounded by MAX_US_LAG_HOURS, so it is a
   * day's worth of rows, not the whole book.
   */
  private where(now: Date): Prisma.LeadWhereInput {
    return {
      deletedAt: null,
      assignedToId: { not: null },
      // A closed or rejected lead is finished, not pending. Carrying one would
      // put dead leads into the day's numbers every morning, forever.
      status: { notIn: [LeadStatus.closed, LeadStatus.rejected] },
      activities: { none: { action: { in: COMPLETION_ACTIONS } } },
      // Nothing stamped within the last day can possibly need carrying yet, in
      // any zone. Cheap pre-filter only; the per-zone test below is the rule.
      assignments: {
        none: { assignedAt: { gte: new Date(now.getTime() - MAX_US_LAG_HOURS * 3600_000) } },
      },
    };
  }

  /** How many leads the next run would carry — read-only, for the admin view. */
  async preview(): Promise<number> {
    const { due } = await this.due(new Date());
    return due.length;
  }

  /**
   * Split the candidates into those whose own day has turned and those still
   * living in the day they were stamped for.
   *
   * The comparison is between two calendar DAYS read in the lead's zone: the day
   * its latest assignment falls on there, and the day it is there now. A lead
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
        assignments: {
          orderBy: { assignedAt: 'desc' },
          take: 1,
          select: { assignedAt: true },
        },
      },
      // Bounded: a first run against a long-neglected book shouldn't open a
      // transaction over tens of thousands of rows. The rest are picked up by
      // the next hourly run.
      take: 5_000,
    });

    const due: Array<{ id: string; assignedToId: string; timezone: Timezone | null }> = [];
    let notYet = 0;
    for (const l of leads) {
      const last = l.assignments[0]?.assignedAt;
      // No assignment row at all — the lead was assigned by a route that predates
      // the history table. Treat it as due, so it starts being stamped properly.
      if (!last) {
        due.push({ id: l.id, assignedToId: l.assignedToId!, timezone: l.timezone });
        continue;
      }
      if (dayInZone(last, l.timezone) < dayInZone(now, l.timezone)) {
        due.push({ id: l.id, assignedToId: l.assignedToId!, timezone: l.timezone });
      } else {
        notYet++;
      }
    }
    return { due, notYet };
  }

  async run(): Promise<CarryForwardResult> {
    const ranAt = new Date();
    const { due, notYet } = await this.due(ranAt);
    if (due.length === 0) {
      return { carried: 0, callers: 0, notYetTheirTomorrow: notYet, ranAt };
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
        remarks: `Carried forward automatically — not worked, and the ${dayInZone(ranAt, l.timezone)} local day has begun in the lead's time zone. Owner unchanged.`,
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

    return { carried: due.length, callers: callers.size, notYetTheirTomorrow: notYet, ranAt };
  }
}
