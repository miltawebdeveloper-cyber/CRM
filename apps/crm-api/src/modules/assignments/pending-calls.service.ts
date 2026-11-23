import { Injectable } from '@nestjs/common';
import { LeadStatus, ZoomMeetingStatus } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';
import { dayInZone } from '../../common/timezone.js';
import { reachedOutcomeSlugs } from '../calls/call-status.js';
import { AssignmentsService } from './assignments.service.js';
import {
  DISPOSITION_ACTIONS,
  PENDING_MODE_KEY,
  assignedDays,
  assignmentState,
  readPendingMode,
  reachedTimes,
  type PendingMode,
} from './assignment-progress.js';

/** How many open leads one read considers. The list says when it was cut short. */
const PENDING_SCAN_MAX = 5_000;

const LIVE_MEETING_STATUSES = [ZoomMeetingStatus.scheduled, ZoomMeetingStatus.in_progress, ZoomMeetingStatus.rescheduled];

export interface PendingCall {
  /** The lead's uuid. */
  id: string;
  leadId: string;
  businessName: string;
  contactName: string | null;
  phone: string | null;
  state: string | null;
  timezone: string | null;
  owner: { id: string; name: string };
  /** The day it was assigned for, by a person — kept, never moved. */
  assignedOn: string | null;
  /** The day its active assignment is for (the same, unless Automatic re-stamped it). */
  scheduledFor: string;
  /** Outcomes saved on it since it was assigned — tries that didn't reach anyone. */
  attempts: number;
  lastOutcome: string | null;
  lastAttemptAt: Date | null;
}

/**
 * Pending Calls — assigned calls whose day has passed without being completed,
 * and the managers' choice of what happens to them.
 *
 * Automatic: the carry-forward moves each one to the next working day with the
 * same employee, so this list only holds what is waiting for that day (over a
 * weekend, say). Manual: they stay here on their original date until a manager
 * gives them to the same employee or another, for a day they choose.
 *
 * Callbacks and Zoom meetings aren't here: those are times agreed with the
 * customer, and they keep their own rescheduling.
 */
@Injectable()
export class PendingCallsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assignments: AssignmentsService,
  ) {}

  mode(): Promise<PendingMode> {
    return readPendingMode(this.prisma);
  }

  async setMode(mode: PendingMode, userId: string): Promise<PendingMode> {
    const before = await readPendingMode(this.prisma);
    await this.prisma.appSetting.upsert({
      where: { key: PENDING_MODE_KEY },
      create: { key: PENDING_MODE_KEY, value: { mode } },
      update: { value: { mode } },
    });
    if (before !== mode) {
      // It changes what happens to every rep's unfinished calls tonight — worth a trail.
      await this.prisma.activity.create({
        data: {
          leadId: null,
          userId,
          action: 'pending_mode_changed',
          oldValue: before,
          newValue: mode,
          remarks:
            mode === 'manual'
              ? 'Pending calls set to Manual: unfinished calls keep their date and wait for a manager.'
              : 'Pending calls set to Automatic: unfinished calls move to the next working day, same employee.',
        },
      });
    }
    return mode;
  }

  async list(callerId?: string): Promise<{ mode: PendingMode; items: PendingCall[]; truncated: boolean }> {
    const now = new Date();
    const rows = await this.prisma.lead.findMany({
      where: {
        deletedAt: null,
        assignedToId: callerId ? callerId : { not: null },
        status: { notIn: [LeadStatus.closed, LeadStatus.rejected] },
        // An open callback or a live meeting is the customer's time, not a pending call.
        OR: [{ callbackAt: null }, { callbackCompletedAt: { not: null } }],
        zoomMeetings: { none: { status: { in: LIVE_MEETING_STATUSES } } },
        // Given for a day that has started; whether that day has passed is
        // decided per lead, on its own calendar, below.
        assignments: { some: { isActive: true, assignedAt: { lt: now } } },
      },
      select: {
        id: true, leadId: true, businessName: true, contactName: true, phone: true, state: true, timezone: true, status: true,
        assignedTo: { select: { id: true, name: true } },
        assignments: { where: { isActive: true }, orderBy: { assignedAt: 'desc' }, take: 1, select: { assignedAt: true } },
      },
      orderBy: { importSeq: 'asc' },
      take: PENDING_SCAN_MAX + 1,
    });
    const truncated = rows.length > PENDING_SCAN_MAX;
    const leads = rows.slice(0, PENDING_SCAN_MAX);

    const stamps = leads.flatMap((l) => (l.assignments[0] ? [l.assignments[0].assignedAt.getTime()] : []));
    const since = stamps.length ? new Date(Math.min(...stamps)) : now;
    const reachedAt = await reachedTimes(this.prisma, leads.map((l) => l.id), since, await reachedOutcomeSlugs(this.prisma));

    const pending = leads.filter(
      (l) =>
        !!l.assignedTo &&
        assignmentState({ assignedAt: l.assignments[0]?.assignedAt, timezone: l.timezone, leadStatus: l.status, reachedAt: reachedAt.get(l.id), now }) === 'pending',
    );
    if (!pending.length) return { mode: await this.mode(), items: [], truncated };

    const assignedOn = await assignedDays(this.prisma, pending);
    // The tries since each was assigned: the outcomes saved, none of which reached anyone.
    const tries = await this.prisma.activity.findMany({
      where: { leadId: { in: pending.map((l) => l.id) }, action: { in: DISPOSITION_ACTIONS }, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      select: { leadId: true, createdAt: true, newValue: true },
    });
    const byLead = new Map<string, { at: Date; outcome: string | null }[]>();
    for (const t of tries) if (t.leadId) byLead.set(t.leadId, [...(byLead.get(t.leadId) ?? []), { at: t.createdAt, outcome: t.newValue }]);

    const items: PendingCall[] = pending.map((l) => {
      const from = l.assignments[0]!.assignedAt;
      const mine = (byLead.get(l.id) ?? []).filter((t) => t.at >= from);
      const last = mine[mine.length - 1];
      return {
        id: l.id,
        leadId: l.leadId,
        businessName: l.businessName,
        contactName: l.contactName,
        phone: l.phone,
        state: l.state,
        timezone: l.timezone,
        owner: { id: l.assignedTo!.id, name: l.assignedTo!.name },
        assignedOn: assignedOn.get(l.id) ?? null,
        scheduledFor: dayInZone(from, l.timezone),
        attempts: mine.length,
        lastOutcome: last?.outcome ?? null,
        lastAttemptAt: last?.at ?? null,
      };
    });
    // Employee-wise, then date-wise: oldest day first, the file's order within a day.
    items.sort(
      (a, b) =>
        a.owner.name.localeCompare(b.owner.name) ||
        a.owner.id.localeCompare(b.owner.id) ||
        (a.assignedOn ?? a.scheduledFor).localeCompare(b.assignedOn ?? b.scheduledFor),
    );
    return { mode: await this.mode(), items, truncated };
  }

  /**
   * Give pending calls to an employee for a day. No \`callerId\` keeps each with
   * the employee it's with; one moves them all to that employee. The day is
   * read on each lead's own calendar, and the original assignment stays in the
   * lead's history.
   */
  async reschedule(dto: { leadIds: string[]; callerId?: string; day: string }, managerId: string) {
    const leads = await this.prisma.lead.findMany({
      where: { id: { in: [...new Set(dto.leadIds)] }, deletedAt: null },
      select: { id: true, assignedToId: true },
    });
    const groups = new Map<string, string[]>();
    for (const l of leads) {
      const to = dto.callerId ?? l.assignedToId;
      if (to) groups.set(to, [...(groups.get(to) ?? []), l.id]);
    }
    let assigned = 0;
    const skipped: { id: string; leadId: string; assignedTo: string }[] = [];
    for (const [callerId, ids] of groups) {
      // A transfer is the point when a manager names someone else, so ownership
      // doesn't block it. The once-a-day rule can't bite: a pending call's last
      // assignment is from an earlier day by definition.
      const r = await this.assignments.assignMany(ids, callerId, managerId, undefined, true, false, {
        day: dto.day,
        remark: 'Rescheduled from Pending Calls',
      });
      assigned += r.assigned;
      skipped.push(...r.skipped);
    }
    return { assigned, skipped };
  }
}
