/**
 * Where a lead stands in the call lifecycle: New Call → In Progress → Completed.
 *
 * One definition, in one file, because there used to be three. The Calling Panel
 * worked out whether a lead was finished in order to draw a tick on its row, the
 * same panel worked it out again — differently, ignoring closed leads — to
 * decide which lead to hand over next, and the API ranked the queue by a third
 * rule of its own. The three agreed most of the time, which is worse than
 * disagreeing always: a lead the agent had just saved could sit in the queue
 * wearing a tick AND a badge reading "New Call", because one rule said it was
 * done and another had nothing better to fall back on.
 *
 * The answer is computed on the server and travels with the lead, so the panel
 * renders a verdict rather than reaching one.
 */

/** What the lifecycle needs to know about a lead. */
export interface QueueLeadState {
  /** The lead's own status — `closed` and `rejected` are terminal. */
  status: string;
  /** Start of the most recent call TODAY, if there was one. */
  lastCallAt: Date | null;
  /** When that call ended. Null while it is still live. */
  lastCallEndedAt: Date | null;
  /** When the agent last saved this lead today — the no-call path's equivalent. */
  lastWorkedAt: Date | null;
  /** A booked call-back, and whether it has been answered. */
  callbackAt: Date | null;
  callbackCompletedAt: Date | null;
  /** The next scheduled Zoom meeting, if one is booked. */
  nextZoomMeeting: { scheduledAt: Date } | null;
}

export type QueueStatus = 'new' | 'in_progress' | 'completed';

/**
 * Is work owed on this lead RIGHT NOW, despite it having been worked today?
 *
 * The one thing that brings a finished lead back. An agent who rings at 10am and
 * books a callback for 2pm has finished with the lead for now — but not for the
 * day, and at 2pm the customer is expecting the phone to ring.
 *
 * Compared against the CLOCK, not the calendar day. "Due today" would mean a
 * lead worked at 10am with a 2pm appointment never left the queue at all, which
 * is the state this rule exists to end: the agent finishes the call and the lead
 * stays on the list, indistinguishable from work still to do.
 */
export function owedNow(lead: QueueLeadState, now: Date): boolean {
  const callbackDue = !lead.callbackCompletedAt && !!lead.callbackAt && lead.callbackAt <= now;
  const zoomDue = !!lead.nextZoomMeeting && lead.nextZoomMeeting.scheduledAt <= now;
  return callbackDue || zoomDue;
}

/**
 * The lead's position in the lifecycle.
 *
 * Order matters, and each step is a claim the one below it cannot make:
 *
 *  1. A live call outranks everything. A lead saved this morning and rung again
 *     now is being worked NOW, whatever happened earlier.
 *  2. Closed and rejected are terminal — no further call is owed on them by
 *     anyone, so they are completed however they got there (a manager may have
 *     closed the lead from Lead Management).
 *  3. Worked today, with nothing owed back yet → completed. This is the ordinary
 *     case, and \`owedNow\` is the exception that reopens it.
 *  4. Otherwise the lead is still to be called.
 */
export function queueStatusOf(lead: QueueLeadState, now: Date): QueueStatus {
  if (lead.lastCallAt && !lead.lastCallEndedAt) return 'in_progress';
  if (lead.status === 'closed' || lead.status === 'rejected') return 'completed';
  if ((lead.lastCallEndedAt || lead.lastWorkedAt) && !owedNow(lead, now)) return 'completed';
  return 'new';
}
