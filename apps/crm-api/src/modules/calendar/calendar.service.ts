import { Injectable } from '@nestjs/common';
import { Prisma, Role, TaskStatus } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';
import { businessDay, businessDayEnd, businessDayStart, dayInZone, formatInZone } from '../../common/timezone.js';
import { callbackStatus, type CallbackStatus } from '../callbacks/callback-status.js';

/** The kinds of scheduled activity the calendar consolidates. */
export type ActivityType = 'call' | 'callback' | 'zoom' | 'task';

export interface CalendarEvent {
  id: string;
  day: number; // day-of-month on the LEAD's calendar, for the grid
  /** `yyyy-mm-dd` on the lead's calendar — which month/day cell the event sits in. */
  ymd: string;
  date: string; // ISO — the scheduled date & time
  type: ActivityType;
  /** Contact person at the company (the "lead name"). */
  leadName: string | null;
  companyName: string;
  leadId: string;
  /** Employee the activity belongs to. */
  assignedTo: string | null;
  /** That employee's user id — what the team view groups by (names can repeat). */
  ownerId: string | null;
  /** Where the activity currently stands. */
  status: string;
  /** One-line summary for the compact month cell. */
  label: string;
  /** The customer's zone, or null when the lead has none configured. */
  timezone: string | null;
  /**
   * The scheduled time already rendered on the CUSTOMER's clock, zone named
   * (`Aug 5, 10:00 AM EDT`).
   *
   * Sent pre-rendered because the grid was formatting `date` with a bare
   * `toLocaleTimeString`, which shows the REP's local hour with no zone on it —
   * so a Pacific callback read as though it were three hours from when it is.
   * One conversion, done where the zone is known for certain.
   */
  atLabel: string;
  /**
   * `upcoming` | `due` | `overdue` | `completed` for a callback; null for the
   * other activity types, which have no such lifecycle.
   */
  callbackStatus: CallbackStatus | null;
  /** The lead's own id (uuid), for links and actions; null for a meeting with no lead. */
  leadRef: string | null;
  /** The meeting's id, for a Zoom event. */
  meetingId: string | null;
  /** The Zoom join link, when the meeting has one. */
  joinUrl: string | null;
  /** How long it runs, for a meeting; null for a call (the grid draws those at 30 minutes). */
  durationMins: number | null;
  /** The task's id, for a task event. */
  taskId: string | null;
  /** A task's priority; null for the other types. */
  priority: string | null;
}

export interface CalendarResult {
  events: CalendarEvent[];
  summary: { calls: number; callbacks: number; zooms: number; tasks: number; total: number };
}

// The grid cell an event belongs in is the day it falls on for the CUSTOMER.
// `getDate()` read the server's own clock, which filed a US evening callback
// under the next day whenever the server ran on IST.
function leadDay(at: Date, tz?: string | null) {
  const ymd = dayInZone(at, tz);
  return { ymd, day: Number(ymd.slice(8, 10)) };
}

@Injectable()
export class CalendarService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every scheduled activity in a window — planned calls, callbacks, Zoom
   * meetings and the viewer's own tasks with a due date — in one feed.
   *
   * Scoping is by role and enforced here rather than in the UI: an employee only
   * ever sees activities that belong to them, while an admin/team-leader sees the
   * whole organisation and may narrow to one employee with `userId`. The previous
   * version leaked — it read every call and every follow-up note in the month
   * regardless of who owned them.
   */
  async events(
    range: { from?: string; to?: string },
    user: { id: string; role: Role },
    userId?: string,
  ): Promise<CalendarResult> {
    // Default window: the current month, so an unfiltered calendar still opens on
    // something useful.
    // Days are BUSINESS days (BUSINESS_TIMEZONE): `from`/`to` arrive as plain
    // days and the whole of `to` is included, the same on any server clock.
    const now = new Date();
    const today = businessDay(now);
    const [y, m] = today.split('-').map(Number);
    const monthStart = `${today.slice(0, 7)}-01`;
    const monthEnd = `${today.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
    const start = businessDayStart(range.from || monthStart);
    const end = businessDayEnd(range.to || monthEnd);

    // Managers may scope to one employee; employees are always scoped to self.
    const isManager = user.role === Role.admin || user.role === Role.team_leader;
    const ownerId = isManager ? userId : user.id;

    const leadWhere: Prisma.LeadWhereInput = {
      deletedAt: null,
      ...(ownerId ? { assignedToId: ownerId } : {}),
    };

    // Tasks are a personal board — the Tasks page never shows anyone else's —
    // so they appear only on the viewer's OWN schedule: always for an employee,
    // and for a manager unless they've narrowed the calendar to someone else.
    const showTasks = !ownerId || ownerId === user.id;

    const [scheduledCalls, callbacks, zooms, tasks] = await Promise.all([
      // Scheduled call = a lead with a next follow-up date booked.
      this.prisma.lead.findMany({
        where: { ...leadWhere, nextFollowUpDate: { gte: start, lte: end } },
        select: {
          id: true, leadId: true, businessName: true, contactName: true, status: true, timezone: true,
          nextFollowUpDate: true, assignedToId: true, assignedTo: { select: { name: true } },
        },
      }),
      // Callback = a booked callback not yet dealt with.
      this.prisma.lead.findMany({
        where: { ...leadWhere, callbackAt: { gte: start, lte: end }, callbackCompletedAt: null },
        select: {
          id: true, leadId: true, businessName: true, contactName: true, status: true, timezone: true,
          callbackAt: true, callbackCompletedAt: true, assignedToId: true, assignedTo: { select: { name: true } },
        },
      }),
      this.prisma.zoomMeeting.findMany({
        where: {
          scheduledAt: { gte: start, lte: end },
          // A meeting belongs to whoever organised it; fall back to the lead's owner
          // so meetings created before organisers were recorded still scope correctly.
          ...(ownerId ? { OR: [{ organizerId: ownerId }, { lead: { assignedToId: ownerId } }] } : {}),
        },
        select: {
          id: true, scheduledAt: true, status: true, title: true, joinUrl: true, durationMins: true, organizerId: true,
          organizer: { select: { name: true } },
          lead: { select: { id: true, leadId: true, businessName: true, contactName: true, timezone: true, assignedToId: true, assignedTo: { select: { name: true } } } },
        },
      }),
      showTasks
        ? this.prisma.task.findMany({
            where: {
              ownerId: user.id,
              dueDate: { gte: start, lte: end },
              status: { not: TaskStatus.done },
              // A meeting files a task due at its own time; the meeting is
              // already on the calendar, so its task would show it twice.
              zoomMeeting: { is: null },
            },
            select: { id: true, title: true, status: true, priority: true, dueDate: true, ownerId: true, owner: { select: { name: true } } },
          })
        : Promise.resolve([]),
    ]);

    const events: CalendarEvent[] = [];

    /**
     * One appointment, shown once. Booking a callback writes the same time into
     * the lead's Next Follow-up (calls: the callback IS the next follow-up), and
     * the calendar used to list both — a "Scheduled Call" and a "Callback" for
     * the same lead at the same minute, counted twice in the summary. Where a
     * pending callback and the follow-up coincide, the callback stands for both.
     */
    const pendingCallbackAt = new Map(callbacks.flatMap((l) => (l.callbackAt ? [[l.id, l.callbackAt.getTime()] as const] : [])));
    const sameAsCallback = (leadId: string, at: Date) => {
      const cb = pendingCallbackAt.get(leadId);
      return cb !== undefined && Math.abs(cb - at.getTime()) < 60_000;
    };

    for (const l of scheduledCalls) {
      if (!l.nextFollowUpDate) continue;
      if (sameAsCallback(l.id, l.nextFollowUpDate)) continue;
      events.push({
        id: `call-${l.id}`,
        ...leadDay(l.nextFollowUpDate, l.timezone),
        date: l.nextFollowUpDate.toISOString(),
        type: 'call',
        leadName: l.contactName,
        companyName: l.businessName,
        leadId: l.leadId,
        assignedTo: l.assignedTo?.name ?? null,
        ownerId: l.assignedToId ?? null,
        status: l.status,
        label: `Call: ${l.businessName}`,
        timezone: l.timezone,
        atLabel: formatInZone(l.nextFollowUpDate, l.timezone),
        callbackStatus: null,
        leadRef: l.id,
        meetingId: null,
        joinUrl: null,
        durationMins: null,
        taskId: null,
        priority: null,
      });
    }

    for (const l of callbacks) {
      if (!l.callbackAt) continue;
      events.push({
        id: `callback-${l.id}`,
        ...leadDay(l.callbackAt, l.timezone),
        date: l.callbackAt.toISOString(),
        type: 'callback',
        leadName: l.contactName,
        companyName: l.businessName,
        leadId: l.leadId,
        assignedTo: l.assignedTo?.name ?? null,
        ownerId: l.assignedToId ?? null,
        status: l.status,
        label: `Callback: ${l.businessName}`,
        timezone: l.timezone,
        atLabel: formatInZone(l.callbackAt, l.timezone),
        callbackStatus: callbackStatus(l.callbackAt, l.callbackCompletedAt, now),
        leadRef: l.id,
        meetingId: null,
        joinUrl: null,
        durationMins: null,
        taskId: null,
        priority: null,
      });
    }

    for (const z of zooms) {
      events.push({
        id: `zoom-${z.id}`,
        ...leadDay(z.scheduledAt, z.lead?.timezone),
        date: z.scheduledAt.toISOString(),
        type: 'zoom',
        leadName: z.lead?.contactName ?? null,
        companyName: z.lead?.businessName ?? 'Meeting',
        leadId: z.lead?.leadId ?? '',
        // The organiser runs the meeting; the lead's owner is the sensible fallback.
        assignedTo: z.organizer?.name ?? z.lead?.assignedTo?.name ?? null,
        ownerId: z.organizerId ?? z.lead?.assignedToId ?? null,
        status: z.status,
        label: `Zoom: ${z.lead?.businessName ?? z.title ?? 'Meeting'}`,
        timezone: z.lead?.timezone ?? null,
        atLabel: formatInZone(z.scheduledAt, z.lead?.timezone),
        callbackStatus: null,
        leadRef: z.lead?.id ?? null,
        meetingId: z.id,
        joinUrl: z.joinUrl ?? null,
        durationMins: z.durationMins,
        taskId: null,
        priority: null,
      });
    }

    for (const t of tasks) {
      if (!t.dueDate) continue;
      events.push({
        id: `task-${t.id}`,
        // No customer, so no customer clock: the business day, like the rest of the CRM's own dates.
        ...leadDay(t.dueDate, null),
        date: t.dueDate.toISOString(),
        type: 'task',
        leadName: null,
        companyName: t.title,
        leadId: '',
        assignedTo: t.owner?.name ?? null,
        ownerId: t.ownerId,
        status: t.status,
        label: `Task: ${t.title}`,
        timezone: null,
        atLabel: formatInZone(t.dueDate, null),
        callbackStatus: null,
        leadRef: null,
        meetingId: null,
        joinUrl: null,
        durationMins: null,
        taskId: t.id,
        priority: t.priority,
      });
    }

    events.sort((a, b) => a.date.localeCompare(b.date));

    // Counts come from the same filtered set the grid renders, so the cards and the
    // calendar can never disagree.
    return {
      events,
      summary: {
        calls: events.filter((e) => e.type === 'call').length,
        callbacks: events.filter((e) => e.type === 'callback').length,
        zooms: events.filter((e) => e.type === 'zoom').length,
        tasks: events.filter((e) => e.type === 'task').length,
        total: events.length,
      },
    };
  }
}
