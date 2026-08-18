import type { Lead } from './leads';

/**
 * Which of an agent's leads Your Queue actually shows.
 *
 * The rule is one line long and still worth a module of its own, because it is
 * the seam between two authorities that used to fight. The API decides whether a
 * lead is finished (`queueStatus`); the panel knows about a save it has just
 * written and the API has not been asked about yet. Getting the hand-off between
 * them wrong is invisible for a few seconds and then wrong for hours.
 */

/**
 * Has the server seen this lead worked?
 *
 * `lastWorkedAt` is stamped by saving with dialling off, `lastCallEndedAt` by
 * ending a call. Either one means the save has landed, and from that moment the
 * server's verdict is the only one that counts.
 */
export function serverSawWork(lead: Pick<Lead, 'lastWorkedAt' | 'lastCallEndedAt'>): boolean {
  return !!lead.lastWorkedAt || !!lead.lastCallEndedAt;
}

/**
 * Is this lead finished with, for now?
 *
 * `processed` holds the leads saved in this sitting. It exists to cover one
 * short window — between the agent pressing Save and the queue refetch coming
 * back — during which the lead must already be gone from the list and the API
 * has not yet been told anything.
 *
 * It then gets out of the way. The moment the server has seen the work, its
 * `queueStatus` is the whole answer. Without that hand-off the in-memory Set
 * becomes a second, competing definition that never expires: a lead worked at
 * 10am with a callback booked for 2pm would stay hidden past 2pm, because the
 * server would be saying the customer is owed a call and a Set from four hours
 * earlier would quietly outvote it.
 */
export function isLeadCompleted(lead: Lead, processed: ReadonlySet<string>): boolean {
  if (lead.queueStatus === 'completed') return true;
  return processed.has(lead.id) && !serverSawWork(lead);
}

/**
 * Your Queue: the agent's book minus what is finished, in the server's order.
 *
 * A filter, never a sort. The API has already ranked these — appointments due
 * today above the backlog, import order within each band — and re-ordering them
 * here is how the list you are looking at stops matching the lead the panel
 * hands you next.
 */
export function activeQueue(leads: Lead[], processed: ReadonlySet<string>): Lead[] {
  return leads.filter((l) => !isLeadCompleted(l, processed));
}
