import { BadRequestException, Injectable } from '@nestjs/common';
import { AssignmentType, Prisma } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { ManualAssignDto, AutoAssignDto, AssignStrategy, BatchAssignDto } from './dto/assignment.dto';
import { sameDayConfirmError } from '../leads/leads.service';

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
    confirmSameDayReassign = false,
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

    // The daily restriction: a lead is assigned once a day. Anything handed over
    // since midnight needs the assigner to confirm it explicitly before it moves
    // again, so work isn't pulled out from under someone mid-shift by accident.
    //
    // EVERY history row counts, not just the active one — reassigning twice in a
    // day closes the first, and reading only the active row would make the third
    // handover of the day look like the first.
    //
    // `confirmSameDayReassign` is the confirmation. It is separate from
    // `allowReassign` on purpose: one is about whose lead it is, the other about
    // how recently it moved, and a lead can be caught by both.
    const assignedTodayRows = await this.prisma.assignment.findMany({
      where: { leadId: { in: leadIds }, assignedAt: { gte: startOfToday() } },
      select: { leadId: true, lead: { select: { leadId: true } } },
      distinct: ['leadId'],
    });
    const sameDay = assignedTodayRows.filter((l) => !blocked.has(l.leadId));
    if (sameDay.length > 0 && !confirmSameDayReassign) {
      throw new BadRequestException(
        sameDayConfirmError(
          sameDay.map((l) => ({
            id: l.leadId,
            leadId: l.lead.leadId,
            assignedTo: priorById.get(l.leadId)?.assignedTo?.name ?? null,
          })),
        ),
      );
    }
    // Which leads the confirmation actually covers, so only their history rows
    // are annotated with it.
    const confirmedSameDay = new Set(sameDay.map((l) => l.leadId));
    leadIds = leadIds.filter((id) => !blocked.has(id));

    if (leadIds.length === 0) {
      return { assigned: 0, callerId, skipped };
    }

    /**
     * The ownership check above reads the leads before the write, so on its own it
     * leaves a window in which two managers assigning overlapping selections could
     * both pass it and the second would silently take the first's leads. The WHERE
     * below closes that window in the database: under READ COMMITTED the UPDATE
     * waits on any row a concurrent transaction is holding and then re-evaluates
     * the condition against the committed row, so a lead taken in the meantime is
     * skipped rather than stolen. It is the guarantee that a lead has one owner.
     */
    const claimable: Prisma.LeadWhereInput = allowReassign
      ? {}
      : { OR: [{ assignedToId: null }, { assignedToId: callerId }] };

    const assignedIds = await this.prisma.$transaction(async (tx) => {
      await tx.lead.updateMany({
        where: { id: { in: leadIds }, ...claimable },
        data: { assignedToId: callerId },
      });
      // Read back what is actually ours now — `updateMany` reports a count, not
      // which rows, and only the leads we really hold may get history rows.
      const owned = await tx.lead.findMany({
        where: { id: { in: leadIds }, assignedToId: callerId },
        select: { id: true },
      });
      const ids = owned.map((o) => o.id);
      if (ids.length === 0) return ids;

      // Close prior active assignments, then open one per lead, so a lead always
      // has exactly one active assignment naming its current owner.
      await tx.assignment.updateMany({ where: { leadId: { in: ids }, isActive: true }, data: { isActive: false } });
      await tx.assignment.createMany({
        data: ids.map((leadId) => {
          // The owner it came FROM, snapshotted before the update above.
          const from = priorById.get(leadId)?.assignedToId ?? null;
          const moved = !!from && from !== callerId;
          const notes = [
            batchName ? `Batch: ${batchName}` : null,
            confirmedSameDay.has(leadId) ? 'Same-day reassignment, confirmed by the assigner' : null,
          ].filter(Boolean);
          return {
            leadId,
            callerId,
            previousCallerId: moved ? from : null,
            assignedById,
            batchName,
            type: moved ? AssignmentType.reassignment : AssignmentType.new_assignment,
            remarks: notes.length ? notes.join(' · ') : null,
          };
        }),
      });
      // Lead Activity Log entry per lead (admin/TL audit trail).
      await tx.activity.createMany({
        data: ids
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
      });
      return ids;
    });

    // Anything the guard refused was claimed by someone else between the check and
    // the write. Reported like any other skip rather than counted as assigned.
    const claimed = new Set(assignedIds);
    for (const id of leadIds) {
      if (!claimed.has(id)) {
        const p = priorById.get(id);
        skipped.push({ id, leadId: p?.leadId ?? id, assignedTo: 'another employee (assigned just now)' });
      }
    }
    return { assigned: assignedIds.length, callerId, skipped };
  }

  /**
   * Single-caller assignment. `strict` (the default) refuses outright when any
   * lead is already owned elsewhere, so an accidental bulk assign fails loudly
   * instead of quietly doing half the job; `skipAssigned` assigns the free ones
   * and reports the rest; `allowReassign` is the deliberate transfer.
   */
  async manual(dto: ManualAssignDto, assignedById: string) {
    // The daily restriction is checked inside assignMany, which is the one place
    // that knows which leads survive the ownership filter — raising it here as
    // well would prompt about leads that were going to be skipped anyway.
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
    return this.assignMany(dto.leadIds, dto.callerId, assignedById, dto.batchName, dto.allowReassign, dto.confirmSameDayReassign);
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
      const res = await this.assignMany(alloc.leadIds, alloc.callerId, assignedById, dto.batchName, dto.allowReassign, dto.confirmSameDayReassign);
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
