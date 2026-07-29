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

/**
 * Provider statuses that mean an INCOMING call rang and nobody picked it up.
 *
 * Narrower than MISSED_STATUSES on purpose. That list also carries `rejected`
 * and `declined`, which describe a call the user actively refused rather than
 * one they missed, and it is applied to outbound calls too — where "no answer"
 * means the CUSTOMER didn't pick up, which is an outbound result, not a missed
 * call. The Missed Calls tab must not mix the two.
 */
export const MISSED_INBOUND_STATUSES = ['missed', 'no-answer', 'no_answer'];

/**
 * A genuine missed call: the customer rang in, and the user did not answer.
 *
 * Deliberately driven by the PROVIDER's status and nothing else. The previous
 * rule also treated any inbound call of zero duration as missed, which quietly
 * swept in two things that are not missed calls:
 *
 *  • rows the abandoned-call cron had closed — it stamps `durationSecs: 0` on a
 *    call the agent never dispositioned, so queue processing leaked straight
 *    into the tab;
 *  • inbound calls that WERE answered and happened to last under a second.
 *
 * Outbound results — no answer, busy, failed, cancelled, rejected — can never
 * match, because direction is checked first.
 */
export const MISSED_INBOUND_CALL = {
  direction: 'inbound',
  status: { in: MISSED_INBOUND_STATUSES },
} as const;

/** The same rule for a single call in hand, e.g. when a webhook arrives. */
export function isMissedInbound(direction: string | null | undefined, status: string | null | undefined): boolean {
  return direction === 'inbound' && !!status && MISSED_INBOUND_STATUSES.includes(status);
}
