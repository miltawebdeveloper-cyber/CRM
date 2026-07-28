/**
 * What counts as a connected, missed or failed call — one definition, shared by
 * the Calls Made dashboard and the role-based summary cards.
 *
 * These lived as private constants inside CallsService, so the dashboard had no
 * way to reuse them and would have had to restate the rules. A validation rule
 * for the summary cards is that they match the module they summarise, and two
 * copies of "what is a connected call" is exactly how that stops being true.
 */

/** Provider call statuses that mean the call never connected. */
export const MISSED_STATUSES = ['missed', 'no-answer', 'no_answer', 'rejected', 'declined'];

/** Provider call statuses that mean the attempt errored rather than went unanswered. */
export const FAILED_STATUSES = ['failed', 'busy', 'canceled', 'cancelled'];

/**
 * Status stamped on a call the agent started but never dispositioned — they shut
 * the tab, the browser died, or the dial never happened. Distinct from any
 * provider status so these are identifiable in the log rather than looking like
 * a normal completed call.
 */
export const ABANDONED_STATUS = 'abandoned';

/**
 * A call counts as connected when it has an end time and was not abandoned.
 *
 * End time rather than provider status: every call logged through the dialer gets
 * one, while `status` is only set on calls that came through OpenPhone — so
 * counting status alone reports zero for manually dialled work. Abandoned calls
 * carry an end time so they stop reading as "in progress", but nobody confirmed
 * they happened, so counting them would inflate the connect rate.
 */
export const CONNECTED_CALL = {
  endTime: { not: null },
  NOT: { status: ABANDONED_STATUS },
} as const;
