import { OutcomeCategory, type Prisma } from '@crm/database';
import type { PrismaService } from '../../prisma/prisma.service.js';

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
 * Outcome groups that mean the rep REACHED someone — everything past "cold".
 *
 * "Cold" is the group the shipped outcomes where nobody was reached sit in (No
 * Answer, Voice Mail, Answering Machine, Disconnected, Wrong Number, Dormant,
 * Not Available, Do Not Disturb); every other group is a conversation, a "not
 * interested" included. The Calls Made "contact rate" already counts exactly
 * these groups as contact. An outcome with no group counts as not reached until
 * an admin assigns it one (Admin → Outcomes).
 */
export const REACHED_CATEGORIES: OutcomeCategory[] = [
  OutcomeCategory.warm,
  OutcomeCategory.hot,
  OutcomeCategory.connected,
  OutcomeCategory.closed_positive,
  OutcomeCategory.closed_negative,
];

/** Provider statuses that mean the line was picked up. */
export const ANSWERED_STATUSES = ['completed', 'answered', 'in-progress', 'in_progress', 'connected'];

/**
 * A CONNECTED call is an ANSWERED one: the customer picked up.
 *
 * It used to mean "finished and not abandoned", so a call the rep marked No
 * Answer counted as connected and the connect rate read as a completion rate.
 * Now, for a finished call:
 *  • with an outcome, the rep's word decides — an outcome in a reached group
 *    (REACHED_CATEGORIES) is connected, anything else is not. The rep wins over
 *    the phone system: a voicemail the line reports as "completed" was not a
 *    conversation;
 *  • with no outcome, the phone system's word — an answered status with talk
 *    time. A call with neither (dialled by hand and never dispositioned) can't
 *    be shown to have been answered, so it isn't counted.
 *
 * `reached` is the slugs of the reached outcomes (reachedOutcomeSlugs) — the
 * list is admin-configured, so it is read, not hard-coded. Combine this with
 * COUNTED_CALL in an AND list, never by spreading: it carries an `OR`, and so
 * may the filter it joins.
 */
export function connectedCall(reached: string[]): Prisma.CallWhereInput {
  return {
    endTime: { not: null },
    OR: [
      { outcome: { in: reached } },
      { outcome: null, status: { in: ANSWERED_STATUSES }, durationSecs: { gt: 0 } },
    ],
  };
}

/** The same rule for a call in hand — the Calls Made pivot counts in memory. */
export function isConnectedCall(
  c: { endTime: Date | null; outcome: string | null; status: string | null; durationSecs: number | null },
  reached: ReadonlySet<string>,
): boolean {
  if (!c.endTime) return false;
  if (c.outcome != null) return reached.has(c.outcome);
  return !!c.status && ANSWERED_STATUSES.includes(c.status) && (c.durationSecs ?? 0) > 0;
}

/** Slugs of the outcomes that mean someone was reached — retired ones too, so old calls keep their meaning. */
export async function reachedOutcomeSlugs(prisma: Pick<PrismaService, 'outcome'>): Promise<string[]> {
  const rows = await prisma.outcome.findMany({ where: { category: { in: REACHED_CATEGORIES } }, select: { slug: true } });
  return rows.map((r) => r.slug);
}

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

/**
 * A call that counts toward call totals: everything except a missed inbound
 * call on a known lead.
 *
 * That call belongs to the Missed Calls module and is counted there, once. Calls
 * Made has always left it out (CallsService.callsMadeWhere); the dashboard's
 * call cards did not, so one unanswered call from a customer was counted in
 * Total Calls, in Connected Calls (it has an end time and isn't abandoned) and
 * in Missed Calls at the same time. A missed call from an UNKNOWN number stays
 * in: Missed Calls lists lead-linked calls only, so this is where that one is
 * counted.
 *
 * Every call total — Calls Made, the dashboard cards and trend, the Call
 * Summary and the dashboard's leaderboard — builds on this, and "connected" is
 * this plus connectedCall(). Combine the two in an AND list (see above).
 */
export const COUNTED_CALL = {
  NOT: { ...MISSED_INBOUND_CALL, leadId: { not: null } },
} as const;

/** The same rule for a single call in hand, e.g. when a webhook arrives. */
export function isMissedInbound(direction: string | null | undefined, status: string | null | undefined): boolean {
  return direction === 'inbound' && !!status && MISSED_INBOUND_STATUSES.includes(status);
}
