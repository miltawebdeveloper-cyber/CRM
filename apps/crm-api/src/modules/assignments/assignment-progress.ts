import { AssignmentType, LeadStatus } from '@crm/database';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { dayInZone, parseInZone } from '../../common/timezone.js';
import { DISPOSITION_ACTIONS } from '../calls/work-time.js';

export { DISPOSITION_ACTIONS };

/**
 * Where an assigned call stands, stated once for the Calling Panel queue, the
 * overnight carry-forward and the managers' Pending Calls list — the three
 * places that used to each have an opinion.
 *
 * An assignment is a call a rep is given FOR A DAY (the day of its active
 * assignment row, read on the lead's own calendar). It is:
 *
 *   completed — the customer was REACHED since it was assigned (an outcome in a
 *               reached group: Call Back, Email, Interested, Follow-up, Meeting,
 *               Closed…), or the lead is closed or rejected. It leaves the queue
 *               for good; only a booked appointment or a new assignment brings
 *               the lead back. No Answer, Voice Mail, Answering Machine, Not
 *               Available, Disconnected and Dormant do NOT complete it: the rep
 *               tried, nobody was reached, and the call is still owed.
 *   today     — due today and not completed.
 *   pending   — its day has passed and it was never completed.
 *   upcoming  — assigned for a later day (a manager rescheduled it ahead).
 *
 * What happens to a pending call is the managers' choice (`PendingMode`):
 * Automatic moves it to the next working day with the same rep; Manual leaves it
 * on its original date, in the Pending Calls list, until a manager reassigns it.
 */
export type AssignmentState = 'completed' | 'today' | 'pending' | 'upcoming';

export type PendingMode = 'automatic' | 'manual';
export const PENDING_MODE_KEY = 'calling:pending-mode';
/**
 * Automatic is how the CRM has always behaved, so it's what a fresh install —
 * and the first day after this shipped — does until a manager chooses Manual.
 */
export const PENDING_MODE_DEFAULT: PendingMode = 'automatic';

const FINISHED: string[] = [LeadStatus.closed, LeadStatus.rejected];

export async function readPendingMode(prisma: Pick<PrismaService, 'appSetting'>): Promise<PendingMode> {
  const row = await prisma.appSetting.findUnique({ where: { key: PENDING_MODE_KEY } });
  const mode = (row?.value as { mode?: unknown } | null | undefined)?.mode;
  return mode === 'manual' || mode === 'automatic' ? mode : PENDING_MODE_DEFAULT;
}

/**
 * The latest moment each lead was REACHED, from `since` on — one query over the
 * outcome log, so a dialled call, a save with calling off and a corrected
 * outcome all count the same way.
 */
export async function reachedTimes(
  prisma: Pick<PrismaService, 'activity'>,
  leadIds: string[],
  since: Date,
  reached: readonly string[],
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (!leadIds.length || !reached.length) return out;
  const rows = await prisma.activity.findMany({
    where: { leadId: { in: leadIds }, action: { in: DISPOSITION_ACTIONS }, newValue: { in: [...reached] }, createdAt: { gte: since } },
    select: { leadId: true, createdAt: true, newValue: true },
  });
  const ok = new Set(reached);
  for (const r of rows) {
    // Re-checked here, not only in the WHERE: the outcome is the whole decision.
    if (!r.leadId || !r.newValue || !ok.has(r.newValue)) continue;
    const prev = out.get(r.leadId);
    if (!prev || r.createdAt > prev) out.set(r.leadId, r.createdAt);
  }
  return out;
}

/**
 * The day each lead was last ASSIGNED for — by a person, not by the overnight
 * carry-forward, which only re-stamps. This is the "original assignment date" a
 * pending call keeps, and what the queue is ordered by.
 */
export async function assignedDays(
  prisma: Pick<PrismaService, 'assignment'>,
  leads: { id: string; timezone: string | null }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!leads.length) return out;
  const rows = await prisma.assignment.findMany({
    where: { leadId: { in: leads.map((l) => l.id) }, type: { not: AssignmentType.carry_forward } },
    orderBy: { assignedAt: 'desc' },
    distinct: ['leadId'],
    select: { leadId: true, assignedAt: true },
  });
  const tz = new Map(leads.map((l) => [l.id, l.timezone]));
  for (const r of rows) out.set(r.leadId, dayInZone(r.assignedAt, tz.get(r.leadId)));
  return out;
}

/**
 * The rule. `assignedAt` is the active assignment's stamp (none for a lead
 * assigned before the history table existed, which counts as today's work).
 */
export function assignmentState(a: {
  assignedAt: Date | null | undefined;
  timezone: string | null;
  leadStatus: string;
  reachedAt: Date | null | undefined;
  now: Date;
}): AssignmentState {
  if (FINISHED.includes(a.leadStatus)) return 'completed';
  if (a.reachedAt && (!a.assignedAt || a.reachedAt >= a.assignedAt)) return 'completed';
  if (!a.assignedAt) return 'today';
  const day = dayInZone(a.assignedAt, a.timezone);
  const today = dayInZone(a.now, a.timezone);
  if (day < today) return 'pending';
  if (day > today) return 'upcoming';
  return 'today';
}

/**
 * The stamp for an assignment made FOR `day` (yyyy-mm-dd on the lead's calendar).
 * Today means now; a later day means the start of that day on the lead's clock,
 * so every view that reads "the day a lead is scheduled for" off the active
 * assignment — Lead Management's Scheduled Date, the queue, the carry-forward —
 * already files it under the right day without learning a second field. An
 * earlier day is refused: a call can't be given for a day that has gone.
 */
export function stampFor(day: string, timezone: string | null, now: Date): Date | null {
  const today = dayInZone(now, timezone);
  if (day < today) return null;
  if (day === today) return now;
  return parseInZone(`${day}T00:00`, timezone);
}
