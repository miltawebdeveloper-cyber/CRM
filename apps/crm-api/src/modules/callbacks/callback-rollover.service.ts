import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LeadStatus, NotificationType, Timezone } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { dayInZone, formatInZone, nextWorkingDay, parseInZone, timeInZone, workingDays } from '../../common/timezone.js';

/** Activity action for an automatic move, so the trail separates it from a human reschedule. */
export const ROLLED_OVER_ACTION = 'callback_rolled_over';

/** How many leads one sweep will move. A safety valve, not a business rule. */
const BATCH = 500;

/**
 * Statuses whose callbacks are NOT worth carrying forward.
 *
 * A closed or rejected lead can still have a stale appointment on it — the rep
 * closed the lead without clearing the date. Rolling those forward every night
 * would keep dead leads permanently on tomorrow's list, which is the opposite of
 * what an automatic rescheduler is for.
 */
const DEAD_STATUSES = [LeadStatus.closed, LeadStatus.rejected];

/**
 * Automatic rollover of scheduled calls that the day ended without.
 *
 * A callback is booked for a moment on the customer's clock. If that day passes
 * where the CUSTOMER is and the call was never completed, the appointment is
 * moved to the next working day at the same time, and the agent it belongs to is
 * told. Nobody has to notice the miss or re-book it by hand.
 *
 * Three things move together, because they are three views of one appointment
 * and Lead Management reads them side by side:
 *   • `Lead.callbackAt`         — the scheduled call (queue, popup, reminders)
 *   • `Lead.nextFollowUpDate`   — the "Next Follow-up" column in Lead Management
 *   • the open `LeadFollowup`   — this rung of the lead's follow-up sequence
 *
 * The lead KEEPS its agent. "Reassign" here means the pending call stays on the
 * same person's plate for the next working day — handing another rep a call they
 * never agreed to make is a different decision, and not one a cron should take.
 */
@Injectable()
export class CallbackRolloverService {
  private readonly logger = new Logger(CallbackRolloverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Hourly, not nightly.
   *
   * "End of day" is not one instant: the CRM carries leads in zones from Hawaii
   * to India, so a single midnight sweep would run mid-afternoon for some
   * customers and long after midnight for others. Running hourly and testing
   * each lead against its OWN calendar means every appointment moves shortly
   * after the day genuinely ends where that customer is.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async scheduledRun() {
    if (process.env.CALLBACK_ROLLOVER_CRON === 'off') return;
    const { moved } = await this.rollOverPending();
    if (moved > 0) this.logger.log(`Rolled ${moved} pending call(s) to the next working day`);
  }

  /**
   * Move every pending scheduled call whose day has ended.
   *
   * Safe to run repeatedly: a call is only moved when its scheduled day is
   * strictly BEFORE today in the customer's zone, and the new date is always in
   * the future — so a second sweep an hour later finds nothing left to do.
   */
  async rollOverPending(now = new Date()): Promise<{ moved: number }> {
    const leads = await this.prisma.lead.findMany({
      where: {
        deletedAt: null,
        callbackAt: { not: null, lt: now },
        // Not completed — the whole definition of "pending".
        callbackCompletedAt: null,
        status: { notIn: DEAD_STATUSES },
      },
      select: {
        id: true,
        leadId: true,
        businessName: true,
        timezone: true,
        callbackAt: true,
        nextFollowUpDate: true,
        assignedToId: true,
        assignedTo: { select: { email: true, name: true } },
      },
      // Oldest misses first, so a capped sweep always clears the longest-waiting.
      orderBy: { callbackAt: 'asc' },
      take: BATCH,
    });

    const working = workingDays();
    let moved = 0;
    for (const lead of leads) {
      const from = lead.callbackAt!;
      const next = this.nextSlot(from, lead.timezone, now, working);
      // The day hasn't ended where this customer is — it is still today's call.
      if (!next) continue;
      try {
        await this.move(lead, from, next);
        moved++;
      } catch (err) {
        // One bad lead must not stop the sweep: the rest of the team's calls
        // still need moving tonight.
        this.logger.warn(`Rollover failed for lead ${lead.leadId}: ${(err as Error).message}`);
      }
    }
    return { moved };
  }

  /**
   * Where a missed call lands, or null if it isn't missed yet.
   *
   * Returns null while the scheduled day is still running in the customer's zone
   * — an appointment at 09:00 is not "not completed at the end of the day" at
   * 09:05, it is simply late, and the reminder engine already says so.
   *
   * Keeps the same wall-clock time and steps forward a working day at a time
   * until it finds one in the future. Normally that is a single step. It loops
   * for the case that matters after an outage: a call missed last Tuesday must
   * not be re-booked into last Wednesday, which is over too.
   */
  private nextSlot(from: Date, tz: Timezone | null, now: Date, working: Set<number>): Date | null {
    const scheduledDay = dayInZone(from, tz);
    if (scheduledDay >= dayInZone(now, tz)) return null;

    const time = timeInZone(from, tz);
    let day = scheduledDay;
    // A fortnight of steps is far more than the one this normally takes, and it
    // bounds the loop against a zone/parse combination that never advances.
    for (let i = 0; i < 14; i++) {
      day = nextWorkingDay(day, working);
      const at = parseInZone(`${day}T${time}`, tz);
      if (at && at.getTime() > now.getTime()) return at;
    }
    return null;
  }

  /** Write the move: the lead, its open follow-up rung, the trail, the notice. */
  private async move(
    lead: {
      id: string;
      leadId: string;
      businessName: string;
      timezone: Timezone | null;
      nextFollowUpDate: Date | null;
      assignedToId: string | null;
      assignedTo: { email: string | null; name: string } | null;
    },
    from: Date,
    to: Date,
  ) {
    // The open rung of the sequence — the row that IS this appointment. Only the
    // open one moves: a completed follow-up is history of a call that happened.
    const openFollowup = await this.prisma.leadFollowup.findFirst({
      where: { leadId: lead.id, completedAt: null },
      orderBy: { seq: 'desc' },
      select: { id: true, seq: true },
    });
    // Resolved before the transaction opens — an unassigned lead still needs
    // somebody to carry the activity entry, and that lookup is not part of the
    // write it belongs to.
    const userId = lead.assignedToId ?? (await this.systemUserId());

    await this.prisma.$transaction([
      this.prisma.lead.update({
        where: { id: lead.id },
        data: {
          callbackAt: to,
          // Lead Management's own "Next Follow-up" column. Moved with the
          // callback so the module the rep is looking at doesn't keep showing
          // yesterday's date beside a call that is now booked for tomorrow.
          nextFollowUpDate: to,
          // A new date is a new appointment: reminders must fire again for it,
          // and yesterday's snooze/dismiss must not silence tomorrow's call.
          callbackReminderDayBeforeAt: null,
          callbackReminderDueAt: null,
          callbackReminderMissedAt: null,
          callbackSnoozedUntil: null,
          callbackDismissedAt: null,
        },
      }),
      ...(openFollowup
        ? [this.prisma.leadFollowup.update({ where: { id: openFollowup.id }, data: { scheduledAt: to } })]
        : []),
      this.prisma.activity.create({
        data: {
          leadId: lead.id,
          // Attributed to the agent who owed the call, so it reads as their
          // pending work moving rather than as an edit by a person.
          userId,
          action: ROLLED_OVER_ACTION,
          oldValue: from.toISOString(),
          newValue: to.toISOString(),
          assignedToId: lead.assignedToId,
          remarks:
            `Scheduled call not completed on ${formatInZone(from, lead.timezone)} — automatically moved to the ` +
            `next working day, ${formatInZone(to, lead.timezone)}.`,
        },
      }),
    ]);

    // Told, not silently moved: a rep whose call slid to tomorrow needs to know
    // it is on tomorrow's list, and their manager needs to see the slippage.
    if (lead.assignedToId) {
      await this.notifications.notifyAndEmail(
        lead.assignedToId,
        NotificationType.callback_reminder,
        `Callback moved to the next working day: ${lead.businessName}`,
        `The scheduled call for ${lead.businessName} (${lead.leadId}) was not completed on ` +
          `${formatInZone(from, lead.timezone)}. It has been rescheduled automatically for ` +
          `${formatInZone(to, lead.timezone)} and is back on your queue for that day.`,
        { email: lead.assignedTo?.email ?? null, alsoManagers: true },
      );
    }
  }

  /**
   * Who an unassigned lead's rollover is recorded against.
   *
   * `Activity.userId` is required, so an unassigned lead still needs somebody to
   * carry the entry. An admin is used, and the remark says the move was
   * automatic — the alternative is dropping the trail entry for exactly the
   * leads nobody is watching.
   */
  private cachedSystemUserId: string | null = null;
  private async systemUserId(): Promise<string> {
    if (this.cachedSystemUserId) return this.cachedSystemUserId;
    const admin =
      (await this.prisma.user.findFirst({ where: { role: 'admin' }, select: { id: true } })) ??
      (await this.prisma.user.findFirst({ select: { id: true } }));
    if (!admin) throw new Error('No user exists to attribute an automatic reschedule to');
    this.cachedSystemUserId = admin.id;
    return admin.id;
  }
}
