import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationType, Role, Timezone } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { dayInZone, formatInZone, TIMEZONE_LABELS, UNSET_TIMEZONE_LABEL } from '../../common/timezone';
import { callbackStatus, type CallbackStatus } from './callback-status';

const HOUR = 60 * 60 * 1000;
const MISSED_GRACE_MS = 1 * HOUR;

/**
 * Every time in a reminder is stated in the CUSTOMER's zone, with the zone named.
 * These used to render in the SERVER's zone and with no label at all, so a rep
 * working a California lead from an EST-hosted CRM was told to ring at a time
 * three hours from the one the customer had agreed to.
 */
const fmt = (d: Date, tz?: Timezone | null) => formatInZone(d, tz);

/** The lead's zone written out in full, for the missed-callback e-mail. */
const zoneName = (tz?: Timezone | null) => (tz ? TIMEZONE_LABELS[tz] : UNSET_TIMEZONE_LABEL);

/**
 * Callback reminder engine (req 4). A cron job scans active callbacks
 * (callbackAt set, not yet completed) and fires three one-shot milestones:
 *   • day-before  — ~24h out
 *   • due         — scheduled time reached
 *   • missed      — still open >1h after the scheduled time
 * Each stamps a column on the lead so it never repeats; completing the call
 * (callbackCompletedAt) drops the lead from the active set before any of them.
 *
 * WHICH OF THESE EMAIL: only `missed`. The other two raise the CRM notification
 * and stop there, and so does booking the callback in the first place — see
 * `CALLBACK_EMAIL_TYPES` in notifications.service.ts, which is where that rule
 * is enforced for every caller rather than being restated at each one.
 */
@Injectable()
export class CallbacksService {
  private readonly logger = new Logger(CallbacksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async scheduledRun() {
    const { fired } = await this.runReminders();
    if (fired > 0) this.logger.log(`Callback reminders fired: ${fired}`);
  }

  /** Scan and dispatch due reminders. Returns how many were fired. */
  async runReminders(now = new Date()): Promise<{ fired: number }> {
    const leads = await this.prisma.lead.findMany({
      where: { callbackAt: { not: null }, callbackCompletedAt: null, deletedAt: null },
      select: {
        id: true,
        // Carried for the missed-callback e-mail, which has to identify the lead
        // and the person to ring well enough to act on without opening the CRM.
        leadId: true,
        businessName: true,
        contactName: true,
        phone: true,
        timezone: true,
        callbackAt: true,
        callbackReminderDayBeforeAt: true,
        callbackReminderDueAt: true,
        callbackReminderMissedAt: true,
        assignedToId: true,
        assignedTo: { select: { email: true, name: true } },
      },
    });

    let fired = 0;
    for (const lead of leads) {
      const cb = lead.callbackAt!;
      const tz = lead.timezone;
      const diffMs = cb.getTime() - now.getTime();
      const hrs = diffMs / HOUR;
      const email = lead.assignedTo?.email ?? null;
      const assignedName = lead.assignedTo?.name ?? 'Unassigned';
      const updates: {
        callbackReminderDayBeforeAt?: Date;
        callbackReminderDueAt?: Date;
        callbackReminderMissedAt?: Date;
      } = {};

      // Missed (>1h overdue) takes priority over Due so we don't double-fire.
      if (diffMs <= -MISSED_GRACE_MS && !lead.callbackReminderMissedAt) {
        // CLAIM THE ALERT BEFORE SENDING IT. This is the one notification in the
        // system that reaches an inbox, so "don't send it twice" has to survive
        // more than a well-behaved loop: the stamp used to be written in the
        // batched update at the bottom, which left the whole send-then-stamp
        // sequence open to a crash, a redeploy mid-scan, or a run still going
        // when the next 10-minute tick starts — any of which re-sent the same
        // alert. `updateMany` filtered on the column still being null is atomic
        // in the database, so exactly one caller can ever win it, and only the
        // winner mails.
        const claimed = await this.prisma.lead.updateMany({
          where: { id: lead.id, callbackReminderMissedAt: null },
          data: {
            callbackReminderMissedAt: now,
            // A callback that was never even marked due has now gone straight
            // past both milestones; stamping it here stops the Due branch
            // firing afterwards for an appointment that is already missed.
            ...(lead.callbackReminderDueAt ? {} : { callbackReminderDueAt: now }),
          },
        });
        if (claimed.count === 0) continue; // another run got there first

        // Everything the recipient needs to act without opening the CRM, and
        // labelled so it cannot be mistaken for a reminder about a call that is
        // still to come: what was missed, for whom, by whom, and when — stated
        // on the CUSTOMER's clock with the zone named, because that is the
        // appointment that was actually broken.
        const body =
          `MISSED CALLBACK — the scheduled callback for ${lead.businessName} at ${fmt(cb, tz)} ` +
          `was not completed. Please take the necessary follow-up action.\n\n` +
          `Callback Status: Missed\n` +
          `Lead ID: ${lead.leadId}\n` +
          `Customer Name: ${lead.businessName}\n` +
          (lead.contactName ? `Contact Name: ${lead.contactName}\n` : '') +
          `Phone Number: ${lead.phone}\n` +
          `Assigned Agent: ${assignedName}\n` +
          `Scheduled Callback: ${fmt(cb, tz)}\n` +
          `Lead Time Zone: ${zoneName(tz)}\n` +
          `Missed Time: ${fmt(now, tz)}`;
        await this.fire(lead.assignedToId, email, NotificationType.callback_missed, 'Missed Callback', body);
        fired++;
        // The claim above already wrote this lead's stamps, so it skips the
        // batched update at the bottom of the loop.
        continue;
      } else if (diffMs <= 0 && !lead.callbackReminderDueAt && !lead.callbackReminderMissedAt) {
        // Never "due now" for a callback already reported missed. The missed
        // branch above stamps both columns together, so a lead that has one
        // without the other is an older row — and telling a rep a call is due
        // an hour after telling them they missed it is a notification that
        // contradicts the one before it.
        await this.fire(
          lead.assignedToId,
          email,
          NotificationType.callback_due,
          `Callback due now: ${lead.businessName}`,
          `Your callback for ${lead.businessName} is due (${fmt(cb, tz)}).`,
        );
        updates.callbackReminderDueAt = now;
        fired++;
      }

      // Day-before is in the future relative to due/missed, evaluated separately.
      if (hrs > 23 && hrs <= 25 && !lead.callbackReminderDayBeforeAt) {
        await this.fire(
          lead.assignedToId,
          email,
          NotificationType.callback_reminder,
          `Callback tomorrow: ${lead.businessName}`,
          `Reminder: callback for ${lead.businessName} is scheduled for ${fmt(cb, tz)}.`,
        );
        updates.callbackReminderDayBeforeAt = now;
        fired++;
      }

      if (Object.keys(updates).length > 0) {
        await this.prisma.lead.update({ where: { id: lead.id }, data: updates });
      }
    }
    return { fired };
  }

  private fire(userId: string | null, email: string | null, type: NotificationType, title: string, body: string) {
    return this.notifications.notifyAndEmail(userId, type, title, body, { email, alsoManagers: true });
  }

  // ── On-screen reminders (req 4, 5, 7) ──
  //
  // The cron above is the e-mail/notification half and fires once per milestone.
  // What follows is the half the browser polls: it re-answers "what should be on
  // this rep's screen right now" every time it's asked, which is why the popup
  // can keep a callback in front of the rep until they act on it rather than
  // showing once and vanishing.

  /**
   * Callbacks this user should be looking at now — due or overdue, still open,
   * and not currently silenced.
   *
   * Scoped to the rep's own leads even for managers. A team leader with fifty
   * reps' callbacks would be buried under popups for calls that are not theirs
   * to make; the manager's view of everyone's callbacks is the Follow-ups page,
   * which is a list, not an interruption.
   */
  async due(userId: string, now = new Date()) {
    const leads = await this.prisma.lead.findMany({
      where: {
        assignedToId: userId,
        deletedAt: null,
        callbackAt: { not: null, lte: now },
        callbackCompletedAt: null,
        callbackDismissedAt: null,
        // Prisma reads `null` here as "no snooze set", which is the common case,
        // so both branches are needed: never snoozed, or snoozed until a moment
        // that has since passed.
        OR: [{ callbackSnoozedUntil: null }, { callbackSnoozedUntil: { lte: now } }],
      },
      orderBy: { callbackAt: 'asc' },
      take: 20,
      select: CALLBACK_SELECT,
    });
    return leads.map((l) => this.toCallback(l, now));
  }

  /**
   * Every open callback on this user's plate for today in the customer's zone,
   * plus anything still overdue from before. Powers the Today's Callbacks list
   * and the dashboard indicator, so it includes the ones the popup is hiding —
   * a snoozed callback is still on the rep's day.
   */
  async today(userId: string, now = new Date()) {
    // Widened by a day and a half at each end, then filtered on the customer's
    // calendar below: "today" is a different 24 hours for an EST lead and a PST
    // one, and a single UTC range can't express both.
    const from = new Date(now.getTime() - 36 * HOUR);
    const to = new Date(now.getTime() + 36 * HOUR);
    const open = { assignedToId: userId, deletedAt: null, callbackCompletedAt: null };

    // Two queries rather than one OR, because they need opposite orderings and
    // separate limits. Asked as a single ascending page, a rep carrying a long
    // overdue backlog would have the whole limit filled by their oldest
    // stragglers and today's callbacks — the ones they can still make on time —
    // would fall off the end of the list entirely.
    const [window, overdue] = await Promise.all([
      this.prisma.lead.findMany({
        where: { ...open, callbackAt: { gte: from, lte: to } },
        orderBy: { callbackAt: 'asc' },
        take: 100,
        select: CALLBACK_SELECT,
      }),
      this.prisma.lead.findMany({
        where: { ...open, callbackAt: { lt: from } },
        // Most recently missed first: a callback missed yesterday is far more
        // recoverable than one missed in March.
        orderBy: { callbackAt: 'desc' },
        take: 50,
        select: CALLBACK_SELECT,
      }),
    ]);

    const items = [...window, ...overdue].map((l) => this.toCallback(l, now));
    return items
      .filter((c) => c.status === 'overdue' || c.status === 'due' || this.isTodayThere(c, now))
      .sort((a, b) => a.callbackAt.getTime() - b.callbackAt.getTime());
  }

  /** Silence the popup for a while. Minutes, so "15" and "60" are both natural. */
  async snooze(leadId: string, minutes: number, user: { id: string; role: Role }) {
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) {
      throw new BadRequestException('Snooze must be between 1 minute and 24 hours.');
    }
    const lead = await this.assertOwn(leadId, user);
    if (!lead.callbackAt) throw new BadRequestException('This lead has no callback scheduled.');

    const until = new Date(Date.now() + minutes * 60 * 1000);
    await this.prisma.lead.update({
      where: { id: leadId },
      data: { callbackSnoozedUntil: until },
    });
    await this.prisma.activity.create({
      data: {
        leadId,
        userId: user.id,
        action: 'updated',
        remarks: `Callback reminder snoozed ${minutes} min (until ${formatInZone(until, lead.timezone)})`,
      },
    });
    return { snoozedUntil: until };
  }

  /**
   * Stop reminding about this appointment without completing it.
   *
   * Deliberately does NOT clear `callbackAt`: the callback is still scheduled,
   * still on the Follow-ups page and still counts as overdue in the lists. All
   * dismissing does is stop the popup, which is what a rep who has seen it and
   * intends to deal with it later actually wants. Rescheduling clears the
   * dismissal, so the next appointment interrupts again.
   */
  async dismiss(leadId: string, user: { id: string; role: Role }) {
    const lead = await this.assertOwn(leadId, user);
    if (!lead.callbackAt) throw new BadRequestException('This lead has no callback scheduled.');

    const at = new Date();
    await this.prisma.lead.update({ where: { id: leadId }, data: { callbackDismissedAt: at } });
    await this.prisma.activity.create({
      data: {
        leadId,
        userId: user.id,
        action: 'updated',
        remarks: `Callback reminder dismissed — still scheduled for ${formatInZone(lead.callbackAt, lead.timezone)}`,
      },
    });
    return { dismissedAt: at };
  }

  /** Employees are held to their own leads; managers may act on any. */
  private async assertOwn(leadId: string, user: { id: string; role: Role }) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, deletedAt: null },
      select: { id: true, assignedToId: true, callbackAt: true, timezone: true },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    const isManager = user.role === Role.admin || user.role === Role.team_leader;
    if (!isManager && lead.assignedToId !== user.id) {
      throw new NotFoundException('Lead not found');
    }
    return lead;
  }

  /** Does this callback fall on today's date where the CUSTOMER is? */
  private isTodayThere(c: { callbackAt: Date; timezone: Timezone | null }, now: Date) {
    return dayInZone(c.callbackAt, c.timezone) === dayInZone(now, c.timezone);
  }

  /**
   * The shape both feeds return. Every time is sent as an instant plus a
   * pre-rendered label in the customer's zone, so no client has to re-derive the
   * conversion — that duplication is what let the panel and the reminders
   * disagree in the first place.
   */
  private toCallback(lead: CallbackLead, now: Date) {
    const at = lead.callbackAt!;
    return {
      leadId: lead.id,
      businessName: lead.businessName,
      contactName: lead.contactName,
      phone: lead.phone,
      timezone: lead.timezone,
      callbackAt: at,
      /** e.g. `Aug 5, 10:00 AM EDT` — the customer's clock, zone named. */
      callbackAtLabel: formatInZone(at, lead.timezone),
      status: callbackStatus(at, lead.callbackCompletedAt, now) as CallbackStatus,
      snoozedUntil: lead.callbackSnoozedUntil,
      dismissedAt: lead.callbackDismissedAt,
    };
  }
}

const CALLBACK_SELECT = {
  id: true,
  businessName: true,
  contactName: true,
  phone: true,
  timezone: true,
  callbackAt: true,
  callbackCompletedAt: true,
  callbackSnoozedUntil: true,
  callbackDismissedAt: true,
} as const;

type CallbackLead = {
  id: string;
  businessName: string;
  contactName: string | null;
  phone: string;
  timezone: Timezone | null;
  callbackAt: Date | null;
  callbackCompletedAt: Date | null;
  callbackSnoozedUntil: Date | null;
  callbackDismissedAt: Date | null;
};
