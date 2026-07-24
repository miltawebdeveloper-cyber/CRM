import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { ManualAssignDto, AutoAssignDto, AssignStrategy, BatchAssignDto } from './dto/assignment.dto';
import { SAME_DAY_LOCK_MESSAGE } from '../leads/leads.service';

/** Midnight today — the boundary the same-day reassignment lock is measured from. */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

@Injectable()
export class AssignmentsService {
  constructor(private readonly prisma: PrismaService) {}

  /** RES-002 — per-caller active assignment counts (e.g. Frank = 200). */
  async summary() {
    const callers = await this.prisma.user.findMany({
      where: { role: 'employee', isActive: true },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    });
    const counts = await this.prisma.lead.groupBy({
      by: ['assignedToId'],
      where: { deletedAt: null, assignedToId: { not: null } },
      _count: { _all: true },
    });
    const map = new Map(counts.map((c) => [c.assignedToId, c._count._all]));
    const unassigned = await this.prisma.lead.count({
      where: { deletedAt: null, assignedToId: null },
    });
    return {
      unassigned,
      callers: callers.map((c) => ({ ...c, leadCount: map.get(c.id) ?? 0 })),
    };
  }

  /**
   * Assign a batch of leads to one caller, recording assignment history.
   *
   * A lead has exactly one owner, and bulk flows must never silently take one off
   * the employee who already holds it — so by default any lead already owned by
   * someone ELSE is skipped and reported back rather than reassigned. Passing
   * `allowReassign` is the deliberate transfer path (a manager explicitly moving a
   * lead), which is the only way ownership changes hands.
   *
   * Leads already owned by the SAME caller are not "taken" from anyone, so they
   * pass through untouched (assignMany stays idempotent).
   */
  async assignMany(
    leadIds: string[],
    callerId: string,
    assignedById: string,
    batchName?: string,
    allowReassign = false,
  ) {
    // Snapshot prior owners so we can label new assignment vs. reassignment.
    const prior = await this.prisma.lead.findMany({
      where: { id: { in: leadIds } },
      select: { id: true, leadId: true, assignedToId: true, callStatus: true, assignedTo: { select: { name: true } } },
    });
    const caller = await this.prisma.user.findUnique({ where: { id: callerId }, select: { name: true } });
    const priorById = new Map(prior.map((p) => [p.id, p]));

    // Leads held by a different employee — blocked unless this is a transfer.
    const takenBySomeoneElse = prior.filter((p) => p.assignedToId && p.assignedToId !== callerId);
    const skipped = allowReassign
      ? []
      : takenBySomeoneElse.map((p) => ({ id: p.id, leadId: p.leadId, assignedTo: p.assignedTo?.name ?? 'another employee' }));
    const blocked = new Set(skipped.map((s) => s.id));

    // Same-day lock: a lead handed over earlier today keeps its owner until
    // tomorrow, so nobody has work pulled out from under them mid-shift. This one
    // is absolute — a deliberate transfer doesn't override it either, or the rule
    // would only hold until someone ticked the box.
    const lockedToday = await this.prisma.assignment.findMany({
      where: { leadId: { in: leadIds }, isActive: true, assignedAt: { gte: startOfToday() } },
      select: { leadId: true, lead: { select: { leadId: true } } },
    });
    for (const l of lockedToday) {
      if (blocked.has(l.leadId)) continue;
      blocked.add(l.leadId);
      skipped.push({ id: l.leadId, leadId: l.lead.leadId, assignedTo: 'today (locked until tomorrow)' });
    }
    leadIds = leadIds.filter((id) => !blocked.has(id));

    if (leadIds.length === 0) {
      return { assigned: 0, callerId, skipped };
    }

    await this.prisma.$transaction([
      // close prior active assignments for these leads
      this.prisma.assignment.updateMany({
        where: { leadId: { in: leadIds }, isActive: true },
        data: { isActive: false },
      }),
      this.prisma.lead.updateMany({
        where: { id: { in: leadIds } },
        data: { assignedToId: callerId },
      }),
      this.prisma.assignment.createMany({
        data: leadIds.map((leadId) => ({ leadId, callerId, assignedById, batchName })),
      }),
      // Lead Activity Log entry per lead (admin/TL audit trail).
      this.prisma.activity.createMany({
        data: leadIds
          .filter((leadId) => priorById.get(leadId)?.assignedToId !== callerId) // skip no-op re-assigns to same owner
          .map((leadId) => {
            const p = priorById.get(leadId);
            const had = !!p?.assignedToId;
            return {
              leadId,
              userId: assignedById,
              action: had ? 'lead_reassigned' : 'lead_assigned',
              oldValue: p?.assignedToId ?? null,
              newValue: callerId,
              remarks: `${had ? 'Reassigned' : 'Assigned'} to ${caller?.name ?? 'caller'}${batchName ? ` (batch: ${batchName})` : ''}`,
              callStatus: p?.callStatus ?? null,
              assignedToId: callerId,
            };
          }),
      }),
    ]);
    return { assigned: leadIds.length, callerId, skipped };
  }

  /**
   * Single-caller assignment. `strict` (the default) refuses outright when any
   * lead is already owned elsewhere, so an accidental bulk assign fails loudly
   * instead of quietly doing half the job; `skipAssigned` assigns the free ones
   * and reports the rest; `allowReassign` is the deliberate transfer.
   */
  async manual(dto: ManualAssignDto, assignedById: string) {
    // The day lock is reported before the ownership check: it's the more specific
    // reason, and it applies even when the lead is going back to the same person.
    if (!dto.skipAssigned) {
      const locked = await this.prisma.assignment.count({
        where: { leadId: { in: dto.leadIds }, isActive: true, assignedAt: { gte: startOfToday() } },
      });
      if (locked > 0) throw new BadRequestException(SAME_DAY_LOCK_MESSAGE);
    }
    if (!dto.allowReassign && !dto.skipAssigned) {
      const taken = await this.prisma.lead.findMany({
        where: { id: { in: dto.leadIds }, assignedToId: { not: null, notIn: [dto.callerId] } },
        select: { leadId: true, assignedTo: { select: { name: true } } },
      });
      if (taken.length === 1) {
        throw new BadRequestException(
          `This lead is already assigned to ${taken[0].assignedTo?.name ?? 'another employee'}. A lead can only be assigned to one employee.`,
        );
      }
      if (taken.length > 1) {
        throw new BadRequestException(
          'Some selected leads are already assigned to other employees. Duplicate lead assignment is not allowed.',
        );
      }
    }
    return this.assignMany(dto.leadIds, dto.callerId, assignedById, dto.batchName, dto.allowReassign);
  }

  /**
   * Manual multi-employee distribution. Each allocation assigns its own slice of
   * leads to one caller. Guards against a lead landing in two allocations so no
   * lead is ever assigned twice in a single operation.
   */
  async batch(dto: BatchAssignDto, assignedById: string) {
    const seen = new Set<string>();
    for (const alloc of dto.allocations) {
      for (const id of alloc.leadIds) {
        if (seen.has(id)) {
          throw new BadRequestException('A lead cannot be assigned to more than one employee in the same operation.');
        }
        seen.add(id);
      }
    }

    const perCaller: Record<string, number> = {};
    // Leads already held by someone else are skipped per allocation, so the count
    // reported back is what was actually assigned rather than what was requested.
    const skipped: { id: string; leadId: string; assignedTo: string }[] = [];
    let assigned = 0;
    for (const alloc of dto.allocations) {
      if (!alloc.leadIds.length) continue;
      const res = await this.assignMany(alloc.leadIds, alloc.callerId, assignedById, dto.batchName, dto.allowReassign);
      perCaller[alloc.callerId] = (perCaller[alloc.callerId] ?? 0) + res.assigned;
      assigned += res.assigned;
      skipped.push(...res.skipped);
    }
    return { assigned, perCaller, skipped };
  }

  /** RES-003..005 — auto-distribute unassigned leads across callers. */
  async auto(dto: AutoAssignDto, assignedById: string) {
    const where: Prisma.LeadWhereInput = {
      deletedAt: null,
      assignedToId: null,
      timezone: dto.timezone,
      state: dto.state,
      // Auto-distribution only draws from unassigned leads, so a lead locked for
      // the day is normally out of scope already. Stated explicitly so the rule
      // still holds for one released back to the pool later the same day.
      assignments: { none: { isActive: true, assignedAt: { gte: startOfToday() } } },
    };
    const leads = await this.prisma.lead.findMany({
      where,
      select: { id: true, state: true, timezone: true },
      orderBy: { leadId: 'asc' },
    });
    if (leads.length === 0) return { assigned: 0, perCaller: {} };

    const callers = dto.callerIds;
    const buckets = new Map<string, string[]>(callers.map((c) => [c, []]));

    if (dto.strategy === AssignStrategy.equal) {
      // round-robin every lead
      leads.forEach((lead, i) => buckets.get(callers[i % callers.length])!.push(lead.id));
    } else {
      // group leads by state or timezone, then round-robin whole groups to callers
      const key = dto.strategy === AssignStrategy.state ? 'state' : 'timezone';
      const groups = new Map<string, string[]>();
      for (const lead of leads) {
        const g = lead[key];
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g)!.push(lead.id);
      }
      [...groups.values()].forEach((ids, i) => {
        const caller = callers[i % callers.length];
        buckets.get(caller)!.push(...ids);
      });
    }

    const perCaller: Record<string, number> = {};
    for (const [callerId, ids] of buckets) {
      if (ids.length) {
        await this.assignMany(ids, callerId, assignedById, dto.batchName);
        perCaller[callerId] = ids.length;
      }
    }
    return { assigned: leads.length, perCaller };
  }
}
