import { LeadStatus, Prisma } from '@crm/database';
import { connectedCall } from '../modules/calls/call-status.js';

/** Lead statuses that mean somebody has already talked to the lead. */
export const CONTACTED_STATUSES: LeadStatus[] = [LeadStatus.contacted, LeadStatus.interested, LeadStatus.closed];

/**
 * A lead counts as contacted once someone has actually REACHED it: an answered
 * call (the same rule as Connected Calls — call-status: connectedCall), or a
 * status of contacted-or-beyond. Derived live rather than stored, so the count
 * stays right as leads progress, are reworked or removed.
 *
 * It used to be ANY finished call, so a lead rung once and marked No Answer —
 * or one whose missed incoming call was synced in — read as contacted: off the
 * "Never contacted" list, out of Balance, through the funnel's Contacted step,
 * while Connected Calls said nobody had answered. A "Not Interested" still
 * counts: the customer picked up.
 *
 * `reached` is the reached outcome slugs (call-status: reachedOutcomeSlugs).
 *
 * A fragment, never a whole WHERE — always combined with an already-scoped
 * clause. Shared by the dashboard cards (MetricsService) and the cards above
 * Lead Library / Lead Management (LeadsService.listSummary), so "Contacted"
 * means the same thing on every screen that shows it.
 *
 * Combine it with `AND`, not by spreading: it is an `OR`, and so is the list's
 * search filter — spread onto the same object, one would silently replace the
 * other.
 */
export function contactedLeadWhere(reached: string[]): Prisma.LeadWhereInput {
  return {
    OR: [
      { status: { in: CONTACTED_STATUSES } },
      { calls: { some: connectedCall(reached) } },
    ],
  };
}
