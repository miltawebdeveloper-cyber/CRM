import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationType, Timezone } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { formatInZone } from '../../common/timezone';

const HOUR = 60 * 60 * 1000;
const MISSED_GRACE_MS = 1 * HOUR;

/**
 * Every time in a reminder is stated in the CUSTOMER's zone, with the zone named.
 * These used to render in the SERVER's zone and with no label at all, so a rep
 * working a California lead from an EST-hosted CRM was told to ring at a time
 * three hours from the one the customer had agreed to.
 */
const fmt = (d: Date, tz?: Timezone | null) => formatInZone(d, tz);

/**
 * Callback reminder engine (req 4). A cron job scans active callbacks
 * (callbackAt set, not yet completed) and fires three one-shot reminders:
 *   • day-before  — ~24h out
 *   • due         — scheduled time reached
 *   • missed      — still open >1h after the scheduled time
 * Each reminder stamps a column on the lead so it never repeats; completing
 * the call (callbackCompletedAt) drops the lead from the active set.
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
        businessName: true,
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
        // Spec body (req 9): customer, phone, scheduled time, assigned user, missed time.
        const body =
          `The scheduled callback for ${lead.businessName} at ${fmt(cb, tz)} was not completed. ` +
          `Please take the necessary follow-up action.\n\n` +
          `Customer Name: ${lead.businessName}\n` +
          `Phone Number: ${lead.phone}\n` +
          `Scheduled Callback: ${fmt(cb, tz)}\n` +
          `Assigned User: ${assignedName}\n` +
          `Missed Time: ${fmt(now, tz)}`;
        await this.fire(lead.assignedToId, email, NotificationType.callback_missed, 'Missed Callback Alert', body);
        updates.callbackReminderMissedAt = now;
        if (!lead.callbackReminderDueAt) updates.callbackReminderDueAt = now;
        fired++;
      } else if (diffMs <= 0 && !lead.callbackReminderDueAt) {
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
}
