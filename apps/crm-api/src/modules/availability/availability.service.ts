import { Injectable, NotFoundException } from '@nestjs/common';
import { Availability } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Work availability — who is online, who is away, and why.
 *
 * AUTOMATIC REASSIGNMENT WAS REMOVED FROM THIS MODULE. It used to move a user's
 * entire open lead book to another rep whenever they were marked unavailable, and
 * a cron ran every ten minutes marking anyone unavailable who hadn't logged in
 * within an hour of their shift start. The two together silently concentrated
 * whole books onto one person: three reps holding 150 leads each, two late to log
 * in, and one sweep left a single rep holding all 450 while the other two held
 * none — repeating every ten minutes as more reps fell out.
 *
 * Lead ownership now changes ONLY through the assignments module, where a manager
 * does it deliberately and the write is guarded so it cannot take a lead off
 * whoever already holds it. Availability is a status and nothing more: it says
 * who is at their desk, and never moves work on its own.
 *
 * The reassigned-work feed (`inbox` / `acknowledge`) is kept so handovers made
 * before this change stay readable and auditable. Nothing writes to it now.
 */
@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  async status(userId: string) {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { availability: true, availabilityReason: true, lastLoginAt: true },
    });
    return {
      availability: u?.availability ?? Availability.online,
      reason: u?.availabilityReason ?? null,
      lastLoginAt: u?.lastLoginAt ?? null,
    };
  }

  /** Mark online (also called on login) — clears the unavailable reason. */
  async setOnline(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { availability: Availability.online, availabilityReason: null, lastLoginAt: new Date() },
    });
    return { availability: Availability.online };
  }

  /**
   * Mark offline (Leave / Holiday / Unavailable).
   *
   * A status change only. The rep keeps every lead they hold and comes back to
   * them; if their work genuinely needs covering, a manager reassigns it from
   * Lead Management, which is the one place ownership changes hands.
   */
  async setOffline(userId: string, reason?: string) {
    const label = reason?.trim() || 'Offline';
    await this.prisma.user.update({
      where: { id: userId },
      data: { availability: Availability.offline, availabilityReason: label },
    });
    return { availability: Availability.offline, reason: label };
  }

  /** Sign-out / end-of-day: offline with no reason attached. */
  async signOut(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { availability: Availability.offline, availabilityReason: null },
    });
    return { availability: Availability.offline };
  }

  /**
   * Admin override — flip another user's availability from the Users page.
   *
   * Online is a plain status flip; it is NOT a login, so `lastLoginAt` is left
   * untouched. Offline is likewise just a status now — it does not move the
   * user's leads, because nothing in this module does.
   */
  async adminSetAvailability(userId: string, online: boolean, reason?: string) {
    const target = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!target) throw new NotFoundException('User not found');
    if (online) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { availability: Availability.online, availabilityReason: null },
      });
      return { availability: Availability.online };
    }
    return this.setOffline(userId, reason?.trim() || 'Set offline by admin');
  }

  /**
   * Historical reassigned-work feed for the logged-in user's dashboard.
   *
   * Read-only history: automatic reassignment is gone, so no new rows appear
   * here. Kept because the records describe real handovers that happened, and
   * the dashboard panel hides itself when the feed is empty.
   */
  inbox(userId: string) {
    return this.prisma.workReassignment.findMany({
      where: { toUserId: userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async acknowledge(id: string, userId: string) {
    await this.prisma.workReassignment.updateMany({
      where: { id, toUserId: userId },
      data: { acknowledged: true },
    });
    return { success: true };
  }
}
