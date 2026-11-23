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

/** Every activity row a saved outcome writes — a save, a call, or a correction. `newValue` is the outcome's slug. */
export const DISPOSITION_ACTIONS = ['call_completed', 'lead_processed', 'outcome_updated'];

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
 * Per user: how many of the leads they CURRENTLY hold, still open, are COMPLETED
 * — the customer was reached (an outcome in a reached group, `reached`) since
 * the lead's active assignment was made. The same rule as the Calling Panel
 * queue and Pending Calls (assignments/assignment-progress): a call that rang
 * out, went to voicemail or was never answered is still owed, so it's pending,
 * not completed, however many times it was dialled.
 *
 * Terminal leads are deliberately excluded — those are counted from the lead's
 * status instead, so the two halves of "completed" can never count the same lead
 * twice. Measured from the ACTIVE assignment, so a lead reached under an earlier
 * assignment — before it was handed over, or before a manager gave it again for
 * a new day — is genuinely still pending for whoever holds it now.
 *
 * Raw because it compares each lead's outcomes with its own assignment's time
 * and counts per owner, which neither `groupBy` nor `distinct` can express
 * without dragging every matching activity row into memory — and the activity
 * table only ever grows.
 */
export async function completedOpenLeadCounts(
  prisma: RawClient,
  userIds: string[],
  reached: readonly string[],
): Promise<Map<string, number>> {
  if (userIds.length === 0 || reached.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ user_id: string; n: bigint }[]>(Prisma.sql`
    SELECT l.assigned_to AS user_id, COUNT(DISTINCT l.id) AS n
    FROM leads l
    LEFT JOIN assignments s ON s.lead_id = l.id AND s.is_active
    WHERE l.assigned_to IN (${Prisma.join(userIds)})
      AND l.deleted_at IS NULL
      AND l.status NOT IN ('closed', 'rejected')
      AND EXISTS (
        SELECT 1 FROM activities a
        WHERE a.lead_id = l.id
          AND a.action IN (${Prisma.join(DISPOSITION_ACTIONS)})
          AND a.new_value IN (${Prisma.join([...reached])})
          AND (s.assigned_at IS NULL OR a.created_at >= s.assigned_at)
      )
    GROUP BY l.assigned_to
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
  /** Recorded talk time — the figure Calls Made totals and averages. */
  durationSecs?: number | null;
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
      const wallClock = c.endTime ? c.endTime.getTime() : Math.min(now, start + SESSION_GAP_MS);
      // Never shorter than the talk time the call actually recorded. `endTime` is
      // stamped when the wrap-up is SAVED while `durationSecs` is the length the
      // agent ended the call at, and the two are set independently — so taking
      // the wall clock alone could report less productive time than the very same
      // dashboard shows as talk time, with Avg Call contradicting Productive Time
      // on adjacent cards.
      const end = Math.max(wallClock, start + Math.max(c.durationSecs ?? 0, 0) * 1000);
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
