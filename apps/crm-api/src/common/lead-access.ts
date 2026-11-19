import { NotFoundException } from '@nestjs/common';
import { Role } from '@crm/database';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * The one rule for "may this user see or act on this lead".
 *
 * Managers (admin, team leader) may reach any lead. An employee may reach the
 * leads assigned to them, and the ones they personally closed — the latter
 * keeps their Closed Leads rows openable after a reassignment. It is the rule
 * `LeadsService.findOne` has always applied to the lead page.
 *
 * It used to live only there. Every route that took a lead id and went straight
 * to its calls, SMS, comments, assignment history, sync log or Zoom meetings
 * skipped it, so any signed-in employee could read — and in places act on — any
 * other rep's lead by changing the id in a request. Routes now call this first.
 *
 * Refused and missing leads both answer 404, so lead ids can't be probed for
 * existence.
 */

export interface Actor {
  id: string;
  role: Role | string;
}

export const isManagerRole = (role: Role | string): boolean => role === Role.admin || role === Role.team_leader;

type LeadReader = Pick<PrismaService, 'lead'>;

/** True when `actor` may reach a lead with these owners. Pure — no lookup. */
export function canReachLead(actor: Actor, lead: { assignedToId: string | null; closedById?: string | null }): boolean {
  if (isManagerRole(actor.role)) return true;
  return lead.assignedToId === actor.id || (!!lead.closedById && lead.closedById === actor.id);
}

/** Throw 404 unless `actor` may reach the lead. */
export async function assertLeadAccess(prisma: LeadReader, actor: Actor, leadId: string): Promise<void> {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, deletedAt: null },
    select: { id: true, assignedToId: true, closedById: true },
  });
  if (!lead || !canReachLead(actor, lead)) throw new NotFoundException('Lead not found');
}
