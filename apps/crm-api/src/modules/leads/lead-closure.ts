import { LeadStatus, Prisma } from '@crm/database';

/**
 * Closure stamps for a lead whose status is changing.
 *
 * A lead entering `closed` records when it was closed and who closed it — the
 * Closed Leads module reads both (admins see every closure with its owner;
 * employees are scoped to `closedById`). Leaving `closed` clears them, so a
 * reopened lead returns to Lead Management with no stale closure attached.
 *
 * `nextStatus` is the status being written (undefined when unchanged),
 * `prevStatus` the lead's current one, and `actorId` whoever performed the
 * close (null when no user is attributable, e.g. an import).
 */
export function closureFields(
  nextStatus: LeadStatus | undefined,
  prevStatus: LeadStatus | undefined,
  actorId: string | null,
): Prisma.LeadUpdateInput {
  if (!nextStatus || nextStatus === prevStatus) return {};
  if (nextStatus === LeadStatus.closed) {
    return {
      closedAt: new Date(),
      closedBy: actorId ? { connect: { id: actorId } } : { disconnect: true },
    };
  }
  if (prevStatus === LeadStatus.closed) {
    return { closedAt: null, closedBy: { disconnect: true } };
  }
  return {};
}

/**
 * Closure stamps for a lead created directly in `closed` — an import row or a
 * manual entry for an already-won deal. A create input has no prior value to
 * clear, so a close with no attributable user records the time alone.
 */
export function closureCreateFields(
  status: LeadStatus | undefined,
  actorId: string | null,
): Partial<Prisma.LeadCreateInput> {
  if (status !== LeadStatus.closed) return {};
  return {
    closedAt: new Date(),
    ...(actorId ? { closedBy: { connect: { id: actorId } } } : {}),
  };
}
