import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { NotificationType, Prisma, Role, TaskPriority, TaskStatus, Timezone, ZoomMeetingStatus } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { CompleteZoomMeetingDto, CreateZoomMeetingDto, UpdateZoomMeetingDto, ZoomQueryDto } from './dto/zoom.dto.js';
import { formatInZone, parseInZone } from '../../common/timezone.js';

/**
 * Meeting times are always stated in the CLIENT's zone, with the zone named.
 * Rendering in the server's zone (as this did) means the invite, the reminder and
 * the client's own calendar disagree about when the meeting is.
 */
const fmtWhen = (d: Date, tz?: Timezone | null) => formatInZone(d, tz);

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

// Client (lead) fields surfaced on the dashboard / call panel.
const leadSelect = {
  select: {
    id: true,
    leadId: true,
    businessName: true,
    phone: true,
    email: true,
    city: true,
    state: true,
    // The client's zone travels with the meeting: it is the zone the meeting was
    // booked in, and the one every screen and reminder states the time in.
    timezone: true,
    industry: true,
    status: true,
  },
} as const;
const organizerSelect = { select: { id: true, name: true, email: true } } as const;
const include = { lead: leadSelect, organizer: organizerSelect } as const;

@Injectable()
export class ZoomService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // Dashboard list. Employees see their own meetings; managers/admins see all.
  dashboard(query: ZoomQueryDto, current: { id: string; role: Role }) {
    const isManager = current.role === Role.admin || current.role === Role.team_leader;
    return this.prisma.zoomMeeting.findMany({
      where: {
        ...(isManager ? {} : { organizerId: current.id }),
        ...(query.status ? { status: query.status } : {}),
        ...(query.leadId ? { leadId: query.leadId } : {}),
        ...(query.from || query.to
          ? {
              scheduledAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
        ...(query.q ? { lead: { businessName: { contains: query.q, mode: 'insensitive' } } } : {}),
      },
      orderBy: { scheduledAt: 'desc' },
      take: 300,
      include,
    });
  }

  // Call Panel — the caller's meetings scheduled for today that still need
  // action (not completed/cancelled). Pinned like a callback.
  dueToday(userId: string) {
    return this.prisma.zoomMeeting.findMany({
      where: {
        organizerId: userId,
        status: { in: [ZoomMeetingStatus.scheduled, ZoomMeetingStatus.in_progress, ZoomMeetingStatus.rescheduled] },
        scheduledAt: { gte: startOfToday(), lte: endOfToday() },
      },
      orderBy: { scheduledAt: 'asc' },
      include,
    });
  }

  // Full chronological history for one client (timeline).
  byLead(leadId: string) {
    return this.prisma.zoomMeeting.findMany({
      where: { leadId },
      orderBy: { scheduledAt: 'desc' },
      include,
    });
  }

  async get(id: string) {
    const m = await this.prisma.zoomMeeting.findUnique({ where: { id }, include });
    if (!m) throw new NotFoundException('Zoom meeting not found');
    return m;
  }

  // Audit trail for a single meeting (newest first).
  activities(meetingId: string) {
    return this.prisma.zoomMeetingActivity.findMany({
      where: { meetingId },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  }

  async create(dto: CreateZoomMeetingDto, userId: string) {
    const lead = await this.prisma.lead.findFirst({ where: { id: dto.leadId, deletedAt: null } });
    if (!lead) throw new NotFoundException('Lead not found');
    const organizerId = dto.organizerId ?? userId;
    // The picker sends the wall-clock time agreed with the client, so it is read
    // in the CLIENT's zone — not the browser's and not the server's, which is
    // what made the Zoom form and the callback form book different instants from
    // the same typed time.
    const scheduledAt = parseInZone(dto.scheduledAt, lead.timezone);
    if (!scheduledAt) throw new BadRequestException('A valid meeting date and time is required.');

    // Auto-create a linked task in the organizer's task list, due at meeting time.
    const task = await this.prisma.task.create({
      data: {
        title: this.taskTitle(lead.businessName, ZoomMeetingStatus.scheduled),
        status: TaskStatus.todo,
        priority: TaskPriority.medium,
        dueDate: scheduledAt,
        ownerId: organizerId,
      },
    });

    const m = await this.prisma.zoomMeeting.create({
      data: {
        leadId: dto.leadId,
        organizerId,
        title: dto.title ?? null,
        scheduledAt,
        durationMins: dto.durationMins ?? 30,
        joinUrl: dto.joinUrl ?? null,
        meetingId: dto.meetingId ?? null,
        passcode: dto.passcode ?? null,
        participants: dto.participants ?? null,
        agenda: dto.agenda ?? null,
        reason: dto.reason ?? null,
        notes: dto.notes ?? null,
        status: ZoomMeetingStatus.scheduled,
        taskId: task.id,
      },
      include,
    });
    await this.log(m.id, userId, 'created', {
      field: 'scheduledAt',
      newValue: m.scheduledAt.toISOString(),
      remarks: `Meeting scheduled for ${fmtWhen(m.scheduledAt, lead.timezone)}`,
    });
    await this.notify(
      m,
      NotificationType.zoom_scheduled,
      `Zoom meeting scheduled: ${lead.businessName}`,
      `A Zoom meeting with ${lead.businessName} is scheduled for ${fmtWhen(m.scheduledAt, lead.timezone)}.`,
    );
    await this.logLeadActivity(m, userId, 'zoom_scheduled', {
      newValue: m.scheduledAt.toISOString(),
      remarks: `Zoom meeting scheduled for ${fmtWhen(m.scheduledAt, lead.timezone)}`,
    });
    await this.syncLeadMeetingDate(m.leadId);
    return m;
  }

  async update(id: string, dto: UpdateZoomMeetingDto, userId: string) {
    const existing = await this.prisma.zoomMeeting.findUnique({
      where: { id },
      include: { lead: { select: { timezone: true } } },
    });
    if (!existing) throw new NotFoundException('Zoom meeting not found');
    const tz = existing.lead?.timezone;
    // Rescheduling reads the new time in the client's zone, the same rule create
    // follows — otherwise moving a meeting by an hour could silently shift it by
    // the difference between the server's zone and the client's.
    const rescheduledAt = dto.scheduledAt !== undefined ? parseInZone(dto.scheduledAt, tz) : undefined;
    if (dto.scheduledAt !== undefined && !rescheduledAt) {
      throw new BadRequestException('A valid meeting date and time is required.');
    }
    // Editing the time on a still-pending meeting implies a reschedule.
    const reschedule = dto.scheduledAt && dto.status === undefined;
    const timeChanged = !!rescheduledAt && rescheduledAt.getTime() !== existing.scheduledAt.getTime();
    const m = await this.tryUpdate(id, {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(rescheduledAt ? { scheduledAt: rescheduledAt } : {}),
      ...(dto.durationMins !== undefined ? { durationMins: dto.durationMins } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : reschedule ? { status: ZoomMeetingStatus.rescheduled } : {}),
      ...(dto.joinUrl !== undefined ? { joinUrl: dto.joinUrl } : {}),
      ...(dto.meetingId !== undefined ? { meetingId: dto.meetingId } : {}),
      ...(dto.passcode !== undefined ? { passcode: dto.passcode } : {}),
      ...(dto.organizerId !== undefined ? { organizerId: dto.organizerId } : {}),
      ...(dto.participants !== undefined ? { participants: dto.participants } : {}),
      ...(dto.agenda !== undefined ? { agenda: dto.agenda } : {}),
      ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      // Rescheduling resets reminder stamps so the cron re-fires for the new time.
      ...(timeChanged ? { reminderDayBeforeAt: null, reminderDueAt: null } : {}),
    });
    await this.logChanges(id, userId, existing, dto, rescheduledAt);
    await this.syncTask(m);
    // A reschedule moves the Meeting Date & Time and only that. Next Follow-Up
    // is a separate commitment and is left exactly where it was.
    await this.syncLeadMeetingDate(m.leadId);
    if (timeChanged) {
      await this.notify(
        m,
        NotificationType.zoom_scheduled,
        `Zoom meeting rescheduled: ${m.lead?.businessName ?? 'Client'}`,
        `The Zoom meeting with ${m.lead?.businessName ?? 'the client'} has been rescheduled to ${fmtWhen(m.scheduledAt, m.lead?.timezone)}.`,
      );
      await this.logLeadActivity(m, userId, 'zoom_rescheduled', {
        oldValue: existing.scheduledAt.toISOString(),
        newValue: m.scheduledAt.toISOString(),
        remarks: `Zoom meeting rescheduled to ${fmtWhen(m.scheduledAt, m.lead?.timezone)}`,
      });
    }
    return m;
  }

  async start(id: string, userId: string) {
    const existing = await this.prisma.zoomMeeting.findUnique({ where: { id } });
    const m = await this.tryUpdate(id, { status: ZoomMeetingStatus.in_progress, startedAt: new Date() });
    await this.log(id, userId, 'started', { field: 'status', oldValue: existing?.status ?? null, newValue: 'in_progress' });
    await this.logLeadActivity(m, userId, 'zoom_started', { remarks: 'Zoom meeting started' });
    await this.syncTask(m);
    return m;
  }

  async complete(id: string, dto: CompleteZoomMeetingDto, userId: string) {
    const existing = await this.prisma.zoomMeeting.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Zoom meeting not found');
    // The follow-up time agreed at the end of the meeting is the client's local
    // time, like every other scheduled time on this record.
    const followUpTz = (
      await this.prisma.lead.findUnique({ where: { id: existing.leadId }, select: { timezone: true } })
    )?.timezone;
    const followUpAt = dto.followUpAt !== undefined ? parseInZone(dto.followUpAt, followUpTz) : undefined;
    const m = await this.tryUpdate(id, {
      status: ZoomMeetingStatus.completed,
      endedAt: new Date(),
      ...(dto.outcome !== undefined ? { outcome: dto.outcome } : {}),
      ...(dto.agenda !== undefined ? { agenda: dto.agenda } : {}),
      ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
      ...(dto.summary !== undefined ? { summary: dto.summary } : {}),
      ...(dto.clientFeedback !== undefined ? { clientFeedback: dto.clientFeedback } : {}),
      ...(dto.decisions !== undefined ? { decisions: dto.decisions } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      ...(dto.actionItems !== undefined ? { actionItems: dto.actionItems } : {}),
      ...(followUpAt !== undefined ? { followUpAt } : {}),
    });
    await this.log(id, userId, 'completed', { field: 'status', oldValue: existing.status, newValue: 'completed' });
    if (dto.outcome !== undefined && dto.outcome !== (existing.outcome ?? undefined)) {
      await this.log(id, userId, 'outcome_updated', { field: 'outcome', oldValue: existing.outcome ?? null, newValue: dto.outcome });
    }
    if (followUpAt) {
      await this.log(id, userId, 'follow_up_created', { field: 'followUpAt', newValue: followUpAt.toISOString() });
      // Store the follow-up in the Follow-Ups module (a Note with a next date),
      // so every follow-up lives in one place.
      const client = m.lead?.businessName ?? 'client';
      let text = `Follow-up from Zoom meeting with ${client}`;
      if (dto.outcome) text += ` — ${dto.outcome}`;
      if (dto.actionItems) text += `\nAction items:\n${dto.actionItems}`;
      await this.prisma.note.create({
        data: {
          leadId: m.leadId,
          noteText: text,
          nextFollowupDate: followUpAt,
          createdById: userId,
        },
      });
    }
    await this.logLeadActivity(m, userId, 'zoom_completed', {
      newValue: dto.outcome ?? null,
      remarks: dto.outcome ? `Zoom meeting completed — ${dto.outcome}` : 'Zoom meeting completed',
    });
    await this.syncTask(m);
    // A meeting that has happened is no longer scheduled, so the column moves to
    // the next pending one — or clears. The follow-up agreed at the end of it
    // was recorded above as a Note, which is a different field on purpose.
    await this.syncLeadMeetingDate(m.leadId);
    return m;
  }

  async cancel(id: string, userId: string) {
    const existing = await this.prisma.zoomMeeting.findUnique({ where: { id } });
    const m = await this.tryUpdate(id, { status: ZoomMeetingStatus.cancelled });
    await this.log(id, userId, 'cancelled', { field: 'status', oldValue: existing?.status ?? null, newValue: 'cancelled' });
    await this.syncTask(m);
    await this.notify(
      m,
      NotificationType.zoom_cancelled,
      `Zoom meeting cancelled: ${m.lead?.businessName ?? 'Client'}`,
      `The Zoom meeting with ${m.lead?.businessName ?? 'the client'} on ${fmtWhen(m.scheduledAt, m.lead?.timezone)} has been cancelled.`,
    );
    await this.logLeadActivity(m, userId, 'zoom_cancelled', {
      oldValue: existing?.status ?? null,
      remarks: `Zoom meeting on ${fmtWhen(m.scheduledAt, m.lead?.timezone)} cancelled`,
    });
    // The grid must stop advertising a meeting that is not happening.
    await this.syncLeadMeetingDate(m.leadId);
    return m;
  }

  async remove(id: string) {
    try {
      const m = await this.prisma.zoomMeeting.delete({ where: { id } });
      // Drop the linked task too (the FK is SET NULL, so do it explicitly).
      if (m.taskId) await this.prisma.task.delete({ where: { id: m.taskId } }).catch(() => undefined);
      await this.syncLeadMeetingDate(m.leadId);
      return { success: true };
    } catch (e) {
      throw this.notFoundOr(e);
    }
  }

  /**
   * Statuses that mean a meeting is still going to happen.
   *
   * The same three the calling queue treats as pending, deliberately — the
   * Meeting Date & Time in Lead Management and the Zoom badge on the queue row
   * are two views of one appointment, and a lead cannot be shown a meeting on
   * one screen and none on the other.
   */
  private static readonly PENDING_MEETING = [
    ZoomMeetingStatus.scheduled,
    ZoomMeetingStatus.in_progress,
    ZoomMeetingStatus.rescheduled,
  ];

  /**
   * Re-point the lead's Meeting Date & Time at its next pending meeting.
   *
   * Lead Management's Meeting Date column was a lead-sheet field and nothing
   * else: it held whatever the import wrote and was editable by hand, so a Zoom
   * booked through the CRM never reached it. A manager reading the grid saw no
   * meeting on a lead that had one in the calendar.
   *
   * Recomputed from the meetings table rather than written from whichever
   * operation happened to run. Scheduling, rescheduling, cancelling and
   * completing all change the answer to the same question — "when is this lead's
   * next meeting?" — so asking it once, here, is what stops the column drifting
   * out of step after a cancellation nobody remembered to handle. Earliest
   * pending meeting wins; no pending meeting means no meeting date.
   *
   * It writes THIS FIELD AND NOTHING ELSE. In particular it must never touch
   * `nextFollowUpDate`: a meeting and a follow-up call are separate commitments
   * to the customer, kept in separate columns, and a Zoom booked for Friday must
   * not silently become the answer to "when are we ringing them back".
   */
  private async syncLeadMeetingDate(leadId: string) {
    const next = await this.prisma.zoomMeeting.findFirst({
      where: { leadId, status: { in: ZoomService.PENDING_MEETING } },
      orderBy: { scheduledAt: 'asc' },
      select: { scheduledAt: true },
    });
    await this.prisma.lead
      .update({ where: { id: leadId }, data: { meetingDate: next?.scheduledAt ?? null } })
      // A lead deleted from under a meeting is not a reason to fail the meeting
      // operation the caller actually asked for.
      .catch(() => undefined);
  }

  // ── Linked-task sync ──
  // Keep the auto-created task aligned with the meeting: due date tracks the
  // scheduled time and status maps so completing/cancelling closes the task.
  private async syncTask(m: {
    taskId: string | null;
    scheduledAt: Date;
    status: ZoomMeetingStatus;
    lead?: { businessName: string } | null;
  }) {
    if (!m.taskId) return;
    const statusMap: Record<ZoomMeetingStatus, TaskStatus> = {
      [ZoomMeetingStatus.scheduled]: TaskStatus.todo,
      [ZoomMeetingStatus.rescheduled]: TaskStatus.todo,
      [ZoomMeetingStatus.in_progress]: TaskStatus.in_progress,
      [ZoomMeetingStatus.completed]: TaskStatus.done,
      [ZoomMeetingStatus.cancelled]: TaskStatus.done,
    };
    await this.prisma.task
      .update({
        where: { id: m.taskId },
        data: {
          dueDate: m.scheduledAt,
          status: statusMap[m.status],
          title: this.taskTitle(m.lead?.businessName ?? 'Client', m.status),
        },
      })
      .catch(() => undefined); // task may have been deleted by the user
  }

  private taskTitle(businessName: string, status: ZoomMeetingStatus) {
    const suffix = status === ZoomMeetingStatus.cancelled ? ' (cancelled)' : '';
    return `Zoom meeting — ${businessName}${suffix}`;
  }

  // Mirror a Zoom event onto the lead's central Activity Log (admin/TL audit).
  private logLeadActivity(
    m: { leadId: string },
    userId: string,
    action: string,
    opts?: { oldValue?: string | null; newValue?: string | null; remarks?: string | null },
  ) {
    return this.prisma.activity.create({
      data: {
        leadId: m.leadId,
        userId,
        action,
        oldValue: opts?.oldValue ?? null,
        newValue: opts?.newValue ?? null,
        remarks: opts?.remarks ?? null,
      },
    });
  }

  // In-app + email notification to the meeting organizer (managers cc'd).
  private notify(
    m: { organizerId: string | null; organizer?: { email: string | null } | null },
    type: NotificationType,
    title: string,
    body: string,
  ) {
    return this.notifications.notifyAndEmail(m.organizerId, type, title, body, {
      email: m.organizer?.email ?? null,
      alsoManagers: true,
    });
  }

  // ── Audit logging ──
  private log(
    meetingId: string,
    userId: string | null,
    action: string,
    opts?: { field?: string; oldValue?: string | null; newValue?: string | null; remarks?: string | null },
  ) {
    return this.prisma.zoomMeetingActivity.create({
      data: {
        meetingId,
        userId,
        action,
        field: opts?.field ?? null,
        oldValue: opts?.oldValue ?? null,
        newValue: opts?.newValue ?? null,
        remarks: opts?.remarks ?? null,
      },
    });
  }

  /**
   * Diff an update against the existing record and log one entry per change.
   *
   * `resolvedAt` is the instant the reschedule actually landed on, already read in
   * the client's zone. The audit entry has to use it rather than re-parsing the
   * raw input, or the trail records a different moment from the one stored.
   */
  private async logChanges(
    id: string,
    userId: string,
    existing: Record<string, unknown>,
    dto: UpdateZoomMeetingDto,
    resolvedAt?: Date | null,
  ) {
    const fields: { key: keyof UpdateZoomMeetingDto; label: string; date?: boolean }[] = [
      { key: 'title', label: 'title' },
      { key: 'scheduledAt', label: 'scheduledAt', date: true },
      { key: 'durationMins', label: 'duration' },
      { key: 'status', label: 'status' },
      { key: 'joinUrl', label: 'join link' },
      { key: 'meetingId', label: 'meeting id' },
      { key: 'passcode', label: 'passcode' },
      { key: 'organizerId', label: 'organizer' },
      { key: 'participants', label: 'participants' },
      { key: 'agenda', label: 'agenda' },
      { key: 'reason', label: 'reason' },
      { key: 'notes', label: 'notes' },
    ];
    const statusAction: Record<string, string> = {
      in_progress: 'started',
      completed: 'completed',
      cancelled: 'cancelled',
      scheduled: 'scheduled',
      rescheduled: 'rescheduled',
    };
    const str = (v: unknown): string | null => {
      if (v === null || v === undefined) return null;
      if (v instanceof Date) return v.toISOString();
      return String(v);
    };
    for (const f of fields) {
      const raw = dto[f.key];
      if (raw === undefined) continue;
      const oldV = str(existing[f.key]);
      const newV = f.date ? (resolvedAt?.toISOString() ?? null) : str(raw);
      if (oldV === newV) continue;
      let action = 'updated';
      if (f.key === 'scheduledAt') action = 'rescheduled';
      else if (f.key === 'notes') action = 'notes_updated';
      else if (f.key === 'status') action = statusAction[String(raw)] ?? 'updated';
      await this.log(id, userId, action, { field: f.label, oldValue: oldV, newValue: newV });
    }
  }

  private async tryUpdate(id: string, data: Prisma.ZoomMeetingUpdateInput) {
    try {
      return await this.prisma.zoomMeeting.update({ where: { id }, data, include });
    } catch (e) {
      throw this.notFoundOr(e);
    }
  }

  private notFoundOr(e: unknown) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      return new NotFoundException('Zoom meeting not found');
    }
    return e;
  }
}
