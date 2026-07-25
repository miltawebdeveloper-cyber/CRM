import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  Availability,
  LeadStatus,
  NotificationType,
  Prisma,
  ReassignType,
  Role,
  TaskStatus,
  ZoomMeetingStatus,
} from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

const NIL = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async status(userId: string) {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { availability: true, availabilityReason: true, lastLoginAt: true },
    });
    return { availability: u?.availability ?? Availability.online, reason: u?.availabilityReason ?? null, lastLoginAt: u?.lastLoginAt ?? null };
  }

  /** Mark online (also called on login) — clears the unavailable reason. */
  async setOnline(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { availability: Availability.online, availabilityReason: null, lastLoginAt: new Date() },
    });
    return { availability: Availability.online };
  }

  /** Mark offline (Leave/Holiday/Unavailable) and reassign all pending work. */
  async setOffline(userId: string, reason?: string) {
    const label = reason?.trim() || 'Offline';
    await this.prisma.user.update({
      where: { id: userId },
      data: { availability: Availability.offline, availabilityReason: label },
    });
    const result = await this.reassignAllWork(userId, label);
    return { availability: Availability.offline, reason: label, ...result };
  }

  /**
   * Sign-out / end-of-day: flips status to offline WITHOUT reassigning work
   * (reassignment is only for planned unavailability — Leave/Holiday/No-login).
   */
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
   * Online is a plain status flip; it is NOT a login, so lastLoginAt is left
   * untouched (stamping it would mask a genuine no-login). Offline goes through
   * the normal offline path, so the user's pending work is reassigned just as if
   * they had marked themselves unavailable.
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

  /** Reassigned-work feed for the logged-in user's dashboard. */
  inbox(userId: string) {
    return this.prisma.workReassignment.findMany({
      where: { toUserId: userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async acknowledge(id: string, userId: string) {
    await this.prisma.workReassignment.updateMany({ where: { id, toUserId: userId }, data: { acknowledged: true } });
    return { success: true };
  }

  // ── Core reassignment engine ──
  async reassignAllWork(fromUserId: string, reason: string) {
    const fromUser = await this.prisma.user.findUnique({ where: { id: fromUserId }, select: { name: true } });
    const toUser = await this.pickNextUser(fromUserId);
    if (!fromUser || !toUser) return { reassigned: 0, toUserId: null as string | null, toUserName: null as string | null };

    const base = { fromUserId, fromUserName: fromUser.name, toUserId: toUser.id, reason };
    const records: Prisma.WorkReassignmentCreateManyInput[] = [];

    // 1) Open leads → covers pending calls, callbacks and follow-ups.
    const leads = await this.prisma.lead.findMany({
      where: { assignedToId: fromUserId, deletedAt: null, status: { notIn: [LeadStatus.closed, LeadStatus.rejected] } },
      select: { id: true, businessName: true, callbackAt: true, callbackCompletedAt: true },
    });
    const leadIds = leads.map((l) => l.id);
    const followNotes = leadIds.length
      ? await this.prisma.note.findMany({
          where: { leadId: { in: leadIds }, nextFollowupDate: { not: null } },
          select: { leadId: true, nextFollowupDate: true },
        })
      : [];
    const followByLead = new Map<string, Date>();
    for (const n of followNotes) if (n.nextFollowupDate && !followByLead.has(n.leadId)) followByLead.set(n.leadId, n.nextFollowupDate);

    if (leadIds.length) {
      await this.prisma.lead.updateMany({ where: { id: { in: leadIds } }, data: { assignedToId: toUser.id } });
      for (const l of leads) {
        const isCallback = !!(l.callbackAt && !l.callbackCompletedAt);
        const followDate = followByLead.get(l.id) ?? null;
        const type = isCallback ? ReassignType.callback : followDate ? ReassignType.followup : ReassignType.call;
        records.push({ ...base, type, leadId: l.id, clientName: l.businessName, scheduledAt: isCallback ? l.callbackAt : followDate });
      }
    }

    // 2) Scheduled Zoom meetings (+ their linked tasks).
    const meetings = await this.prisma.zoomMeeting.findMany({
      where: {
        organizerId: fromUserId,
        status: { in: [ZoomMeetingStatus.scheduled, ZoomMeetingStatus.rescheduled, ZoomMeetingStatus.in_progress] },
      },
      select: { id: true, scheduledAt: true, taskId: true, lead: { select: { businessName: true } } },
    });
    const zoomTaskIds = meetings.map((m) => m.taskId).filter((x): x is string => !!x);
    if (meetings.length) {
      await this.prisma.zoomMeeting.updateMany({ where: { id: { in: meetings.map((m) => m.id) } }, data: { organizerId: toUser.id } });
      if (zoomTaskIds.length) await this.prisma.task.updateMany({ where: { id: { in: zoomTaskIds } }, data: { ownerId: toUser.id } });
      for (const m of meetings) {
        records.push({ ...base, type: ReassignType.zoom, zoomMeetingId: m.id, taskId: m.taskId, clientName: m.lead?.businessName ?? null, scheduledAt: m.scheduledAt });
      }
    }

    // 3) Remaining pending tasks (exclude the Zoom-linked ones handled above).
    const tasks = await this.prisma.task.findMany({
      where: { ownerId: fromUserId, status: { not: TaskStatus.done }, id: { notIn: zoomTaskIds.length ? zoomTaskIds : [NIL] } },
      select: { id: true, title: true, dueDate: true },
    });
    if (tasks.length) {
      await this.prisma.task.updateMany({ where: { id: { in: tasks.map((t) => t.id) } }, data: { ownerId: toUser.id } });
      for (const t of tasks) records.push({ ...base, type: ReassignType.task, taskId: t.id, clientName: t.title, scheduledAt: t.dueDate });
    }

    if (records.length) {
      await this.prisma.workReassignment.createMany({ data: records });
      await this.notifications.notifyAndEmail(
        toUser.id,
        NotificationType.new_leads,
        'Work reassigned to you',
        `${records.length} item(s) were reassigned from ${fromUser.name} (${reason}). See your dashboard.`,
      );
    }
    return { reassigned: records.length, toUserId: toUser.id, toUserName: toUser.name };
  }

  /** Next available user = least-loaded online, active caller (excluding the offline one). */
  private async pickNextUser(excludeId: string) {
    const candidates = await this.prisma.user.findMany({
      where: { role: Role.employee, isActive: true, availability: Availability.online, id: { not: excludeId } },
      select: { id: true, name: true },
    });
    if (candidates.length === 0) return null;
    const counts = await this.prisma.lead.groupBy({
      by: ['assignedToId'],
      where: { assignedToId: { in: candidates.map((c) => c.id) }, deletedAt: null },
      _count: { _all: true },
    });
    const load = new Map(counts.map((c) => [c.assignedToId, c._count._all]));
    return candidates.sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0))[0];
  }

  // ── No-login auto-reassignment ──
  @Cron(CronExpression.EVERY_10_MINUTES)
  async noLoginSweep() {
    const n = await this.runNoLoginCheck();
    if (n > 0) this.logger.log(`No-login reassignments: ${n}`);
  }

  /**
   * Treat users who haven't logged in within 1h of their shift start as
   * unavailable. Opt-in: only users with an explicit `shiftStart` are eligible
   * (you can't be "late" without a scheduled start time).
   */
  async runNoLoginCheck(now = new Date()): Promise<number> {
    const users = await this.prisma.user.findMany({
      where: { role: Role.employee, isActive: true, availability: Availability.online, shiftStart: { not: null } },
      select: { id: true, shiftStart: true, lastLoginAt: true, noLoginHandledOn: true },
    });
    const todayStr = now.toDateString();
    let count = 0;
    for (const u of users) {
      const [h, m] = (u.shiftStart ?? '09:00').split(':').map((x) => Number(x));
      const shift = new Date(now);
      shift.setHours(Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0, 0, 0);
      const threshold = new Date(shift.getTime() + 60 * 60 * 1000);
      const loggedInToday = !!(u.lastLoginAt && u.lastLoginAt >= shift);
      const handledToday = !!(u.noLoginHandledOn && new Date(u.noLoginHandledOn).toDateString() === todayStr);
      if (now > threshold && !loggedInToday && !handledToday) {
        await this.prisma.user.update({ where: { id: u.id }, data: { noLoginHandledOn: now } });
        await this.setOffline(u.id, 'No Login');
        count++;
      }
    }
    return count;
  }
}
