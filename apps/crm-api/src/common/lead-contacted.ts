import { LeadStatus, Prisma } from '@crm/database';

/**
 * A lead counts as contacted once someone has actually reached it: a call that
 * completed, or a status of contacted-or-beyond. Derived live rather than
 * stored, so the count stays right as leads progress, are reworked or removed.
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
export const CONTACTED_LEAD_WHERE: Prisma.LeadWhereInput = {
  OR: [
    { status: { in: [LeadStatus.contacted, LeadStatus.interested, LeadStatus.closed] } },
    { calls: { some: { endTime: { not: null } } } },
  ],
};
