import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationType, Timezone, ZoomMeetingStatus } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { formatInZone } from '../../common/timezone.js';

const HOUR = 60 * 60 * 1000;

/** Meeting times are stated in the client's zone, with the zone named. */
const fmt = (d: Date, tz?: Timezone | null) => formatInZone(d, tz);

/**
 * Zoom meeting reminder engine — mirrors the callback reminder cron. Scans
 * pending meetings (scheduled/rescheduled, not completed/cancelled) and fires
 * two one-shot reminders to the organizer:
 *   • day-before — ~24h out
 *   • due        — scheduled time reached
 * Each reminder stamps a column so it never repeats; rescheduling clears the
 * stamps so reminders re-fire for the new time.
 */
@Injectable()
export class ZoomRemindersService {
  private readonly logger = new Logger(ZoomRemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async scheduledRun() {
    const { fired } = await this.runReminders();
    if (fired > 0) this.logger.log(`Zoom reminders fired: ${fired}`);
  }

  /** Scan and dispatch due reminders. Returns how many were fired. */
  async runReminders(now = new Date()): Promise<{ fired: number }> {
    const meetings = await this.prisma.zoomMeeting.findMany({
      where: {
        status: { in: [ZoomMeetingStatus.scheduled, ZoomMeetingStatus.rescheduled] },
      },
      include: {
        lead: { select: { businessName: true, timezone: true } },
        organizer: { select: { id: true, email: true } },
      },
    });

    let fired = 0;
    for (const m of meetings) {
      const at = m.scheduledAt;
      const tz = m.lead?.timezone;
      const diffMs = at.getTime() - now.getTime();
      const hrs = diffMs / HOUR;
      const client = m.lead?.businessName ?? 'the client';
      const email = m.organizer?.email ?? null;
      const updates: { reminderDayBeforeAt?: Date; reminderDueAt?: Date } = {};

      // Due — scheduled time reached and not yet reminded.
      if (diffMs <= 0 && !m.reminderDueAt) {
        await this.fire(
          m.organizerId,
          email,
          NotificationType.zoom_due,
          `Zoom meeting starting: ${client}`,
          `Your Zoom meeting with ${client} is due now (${fmt(at, tz)}).`,
        );
        updates.reminderDueAt = now;
        fired++;
      }

      // Day-before — fires once in the 23–25h window before the meeting.
      if (hrs > 23 && hrs <= 25 && !m.reminderDayBeforeAt) {
        await this.fire(
          m.organizerId,
          email,
          NotificationType.zoom_reminder,
          `Zoom meeting tomorrow: ${client}`,
          `Reminder: your Zoom meeting with ${client} is scheduled for ${fmt(at, tz)}.`,
        );
        updates.reminderDayBeforeAt = now;
        fired++;
      }

      if (Object.keys(updates).length > 0) {
        await this.prisma.zoomMeeting.update({ where: { id: m.id }, data: updates });
      }
    }
    return { fired };
  }

  private fire(userId: string | null, email: string | null, type: NotificationType, title: string, body: string) {
    return this.notifications.notifyAndEmail(userId, type, title, body, { email, alsoManagers: true });
  }
}
