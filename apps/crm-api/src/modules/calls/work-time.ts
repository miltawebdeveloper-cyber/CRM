import { Prisma } from '@crm/database';

/**
 * One definition of "the rep finished this lead", and one definition of "the rep
 * was working", shared by the Calling Panel's own KPI cards and the manager-facing
 * per-caller table.
 *
 * They live here rather than in either service because the two views describe the
 * same work from different sides: an employee's Completed / Pending must be the
 * same numbers their team leader sees against their name, or one of the two is
 * lying. Keeping the rules in one file is what stops them drifting apart.
 */

/**
 * Activity actions written when an agent saves a lead in the panel — one per
 * mode, on a call and with dialling off. A lead counts as completed once one of
 * these exists, which is precisely "the agent updated the record and saved it".
 *
 * Counting Call rows instead reports a permanent zero whenever calling is
 * disabled, and double-counts a lead that was rung twice.
 */
export const COMPLETION_ACTIONS = ['call_completed', 'lead_processed'];

/**
 * Longest pause that still reads as one continuous sitting. A longer gap means
 * the agent stepped away, so the time is not counted as productive.
 */
export const SESSION_GAP_MS = 15 * 60 * 1000;

/**
 * Credited to the first lead of a sitting. Nothing records when the agent opened
 * the panel, so the only honest answer for the first save is a nominal minute
 * rather than back-dating it to whenever the session might have started.
 */
export const FIRST_LEAD_MS = 60 * 1000;

/** The subset of PrismaService this file needs, so it stays a plain helper. */
type RawClient = { $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T> };

/**
 * Per user: how many of the leads they CURRENTLY hold, and that are still open,
 * they have already worked at least once.
 *
 * Terminal leads are deliberately excluded — those are counted from the lead's
 * status instead, so the two halves of "completed" can never count the same lead
 * twice. `l.assigned_to = a.user_id` is what ties the work to the current owner:
 * a lead someone else worked before it was handed over is genuinely still pending
 * for whoever holds it now.
 *
 * Raw because this is a COUNT(DISTINCT …) per user, which neither `groupBy` nor
 * `distinct` can express without dragging every matching activity row into
 * memory — and the activity table only ever grows.
 */
export async function completedOpenLeadCounts(
  prisma: RawClient,
  userIds: string[],
): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ user_id: string; n: bigint }[]>(Prisma.sql`
    SELECT a.user_id AS user_id, COUNT(DISTINCT a.lead_id) AS n
    FROM activities a
    JOIN leads l ON l.id = a.lead_id
    WHERE a.user_id IN (${Prisma.join(userIds)})
      AND a.action IN (${Prisma.join(COMPLETION_ACTIONS)})
      AND l.deleted_at IS NULL
      AND l.assigned_to = a.user_id
      AND l.status NOT IN ('closed', 'rejected')
    GROUP BY a.user_id
  `);
  return new Map(rows.map((r) => [r.user_id, Number(r.n)]));
}

/** A window of time the agent was working, in epoch ms. */
export interface WorkInterval {
  start: number;
  end: number;
}

/** The slice of a call that productive time is derived from. */
export interface CallSpan {
  startTime: Date;
  endTime: Date | null;
}

/**
 * Total length of a set of possibly-overlapping work windows, in seconds.
 *
 * Overlap is the norm, not the exception: dispositioning a lead at the end of a
 * call produces a call window and a processing window covering the same minutes.
 * Merging first is what stops productive time exceeding the wall clock.
 */
export function mergedSeconds(intervals: WorkInterval[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let { start, end } = sorted[0];
  for (const iv of sorted.slice(1)) {
    if (iv.start <= end) {
      end = Math.max(end, iv.end);
    } else {
      total += end - start;
      ({ start, end } = iv);
    }
  }
  return Math.round((total + (end - start)) / 1000);
}

/**
 * Time an agent actually spent working, from the two kinds of evidence the CRM
 * holds: calls (which occupy them for their whole length) and saves (which mean
 * they were working that lead from the end of the previous piece of work up to
 * the save). The windows are merged, so a lead dispositioned at the end of its
 * own call is counted once rather than twice.
 *
 * This is why the panel reports real productive time with dialling switched off,
 * where summing call durations — as it used to — could only ever report zero.
 */
export function productiveSeconds(calls: CallSpan[], saves: Date[], now = Date.now()): number {
  const events = [
    ...calls.map((c) => {
      const start = c.startTime.getTime();
      // A call still in flight counts from its start, so productive time ticks up
      // during the call rather than jumping when it ends. Bounded, because nothing
      // closes a call the agent abandoned until the sweep runs hours later — and
      // the real end time replaces this the moment it's wrapped up.
      const end = c.endTime ? c.endTime.getTime() : Math.min(now, start + SESSION_GAP_MS);
      return { at: end, span: { start, end } as WorkInterval | null };
    }),
    ...saves.map((at) => ({ at: at.getTime(), span: null as WorkInterval | null })),
  ].sort((a, b) => a.at - b.at);

  const intervals: WorkInterval[] = [];
  let prevEnd: number | null = null;
  for (const e of events) {
    if (e.span) {
      if (e.span.end > e.span.start) intervals.push(e.span);
    } else {
      const gap = prevEnd === null ? Infinity : e.at - prevEnd;
      // A gap inside the session IS the time spent on this lead. A longer one
      // means the agent was away, so only the nominal first-lead minute counts.
      const span = gap > 0 && gap <= SESSION_GAP_MS ? gap : FIRST_LEAD_MS;
      intervals.push({ start: e.at - span, end: e.at });
    }
    prevEnd = prevEnd === null ? e.at : Math.max(prevEnd, e.at);
  }
  return mergedSeconds(intervals);
}
