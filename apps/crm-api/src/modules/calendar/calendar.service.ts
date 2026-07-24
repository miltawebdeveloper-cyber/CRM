import { Injectable } from '@nestjs/common';
import { Prisma, Role } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';

/** The three kinds of scheduled activity the calendar consolidates. */
export type ActivityType = 'call' | 'callback' | 'zoom';

export interface CalendarEvent {
  id: string;
  day: number; // day-of-month, for the grid
  date: string; // ISO — the scheduled date & time
  type: ActivityType;
  /** Contact person at the company (the "lead name"). */
  leadName: string | null;
  companyName: string;
  leadId: string;
  /** Employee the activity belongs to. */
  assignedTo: string | null;
  /** Where the activity currently stands. */
  status: string;
  /** One-line summary for the compact month cell. */
  label: string;
}

export interface CalendarResult {
  events: CalendarEvent[];
  summary: { calls: number; callbacks: number; zooms: number; total: number };
}

@Injectable()
export class CalendarService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every scheduled activity in a window — planned calls, callbacks and Zoom
   * meetings — in one feed.
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
    const now = new Date();
    const start = range.from ? new Date(range.from) : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = range.to ? new Date(range.to) : new Date(now.getFullYear(), now.getMonth() + 1, 0);
    // `to` arrives as a plain day — include all of it.
    end.setHours(23, 59, 59, 999);

    // Managers may scope to one employee; employees are always scoped to self.
    const isManager = user.role === Role.admin || user.role === Role.team_leader;
    const ownerId = isManager ? userId : user.id;

    const leadWhere: Prisma.LeadWhereInput = {
      deletedAt: null,
      ...(ownerId ? { assignedToId: ownerId } : {}),
    };

    const [scheduledCalls, callbacks, zooms] = await Promise.all([
      // Scheduled call = a lead with a next follow-up date booked.
      this.prisma.lead.findMany({
        where: { ...leadWhere, nextFollowUpDate: { gte: start, lte: end } },
        select: {
          id: true, leadId: true, businessName: true, contactName: true, status: true,
          nextFollowUpDate: true, assignedTo: { select: { name: true } },
        },
      }),
      // Callback = a booked callback not yet dealt with.
      this.prisma.lead.findMany({
        where: { ...leadWhere, callbackAt: { gte: start, lte: end }, callbackCompletedAt: null },
        select: {
          id: true, leadId: true, businessName: true, contactName: true, status: true,
          callbackAt: true, assignedTo: { select: { name: true } },
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
          id: true, scheduledAt: true, status: true, title: true,
          organizer: { select: { name: true } },
          lead: { select: { leadId: true, businessName: true, contactName: true, assignedTo: { select: { name: true } } } },
        },
      }),
    ]);

    const events: CalendarEvent[] = [];

    for (const l of scheduledCalls) {
      if (!l.nextFollowUpDate) continue;
      events.push({
        id: `call-${l.id}`,
        day: l.nextFollowUpDate.getDate(),
        date: l.nextFollowUpDate.toISOString(),
        type: 'call',
        leadName: l.contactName,
        companyName: l.businessName,
        leadId: l.leadId,
        assignedTo: l.assignedTo?.name ?? null,
        status: l.status,
        label: `Call: ${l.businessName}`,
      });
    }

    for (const l of callbacks) {
      if (!l.callbackAt) continue;
      events.push({
        id: `callback-${l.id}`,
        day: l.callbackAt.getDate(),
        date: l.callbackAt.toISOString(),
        type: 'callback',
        leadName: l.contactName,
        companyName: l.businessName,
        leadId: l.leadId,
        assignedTo: l.assignedTo?.name ?? null,
        status: l.status,
        label: `Callback: ${l.businessName}`,
      });
    }

    for (const z of zooms) {
      events.push({
        id: `zoom-${z.id}`,
        day: z.scheduledAt.getDate(),
        date: z.scheduledAt.toISOString(),
        type: 'zoom',
        leadName: z.lead?.contactName ?? null,
        companyName: z.lead?.businessName ?? 'Meeting',
        leadId: z.lead?.leadId ?? '',
        // The organiser runs the meeting; the lead's owner is the sensible fallback.
        assignedTo: z.organizer?.name ?? z.lead?.assignedTo?.name ?? null,
        status: z.status,
        label: `Zoom: ${z.lead?.businessName ?? z.title ?? 'Meeting'}`,
      });
    }

    events.sort((a, b) => a.date.localeCompare(b.date));

    // Counts come from the same filtered set the grid renders, so the cards and the
    // calendar can never disagree.
    return {
      events,
      summary: {
        calls: scheduledCalls.length,
        callbacks: callbacks.length,
        zooms: zooms.length,
        total: events.length,
      },
    };
  }
}
