import { describe, expect, it, jest } from '@jest/globals';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AssignmentsService } from './assignments.service.js';

/**
 * Bulk Unassign — Lead Management's way of returning leads to the pool.
 */
describe('AssignmentsService.unassign', () => {
  type Row = { id: string; assignedToId: string | null; callStatus: string | null; assignedTo: { name: string } | null };

  function harness(owned: Row[], stillFreeAfterWrite?: string[]) {
    const leadFindMany = jest
      .fn<(a: unknown) => Promise<unknown[]>>()
      // 1st: the owner read before the write.
      .mockResolvedValueOnce(owned)
      // 2nd (inside the transaction): which of them really are free now.
      .mockResolvedValueOnce((stillFreeAfterWrite ?? owned.map((l) => l.id)).map((id) => ({ id })));
    const leadUpdateMany = jest.fn(async (_a: unknown) => ({ count: 1 }));
    const assignmentUpdateMany = jest.fn(async (_a: unknown) => ({ count: 1 }));
    const activityCreateMany = jest.fn(async (_a: unknown) => ({ count: 1 }));
    const tx = {
      lead: { findMany: leadFindMany, updateMany: leadUpdateMany },
      assignment: { updateMany: assignmentUpdateMany },
      activity: { createMany: activityCreateMany },
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;
    return { service: new AssignmentsService(prisma), leadUpdateMany, assignmentUpdateMany, activityCreateMany };
  }

  const ROWS: Row[] = [
    { id: 'l1', assignedToId: 'u-ann', callStatus: 'no_answer', assignedTo: { name: 'Ann' } },
    { id: 'l2', assignedToId: 'u-ann', callStatus: null, assignedTo: { name: 'Ann' } },
    { id: 'l3', assignedToId: 'u-bob', callStatus: null, assignedTo: { name: 'Bob' } },
  ];

  it('clears the owner, closes the active assignment and logs each lead', async () => {
    const h = harness(ROWS);
    const res = await h.service.unassign(['l1', 'l2', 'l3'], 'mgr-1');

    expect(res).toEqual({ unassigned: 3, skipped: 0 });
    // One guarded write per owner — never a blanket "set null" over the ids.
    expect(h.leadUpdateMany.mock.calls.map((c) => c[0])).toEqual([
      { where: { id: { in: ['l1', 'l2'] }, assignedToId: 'u-ann' }, data: { assignedToId: null } },
      { where: { id: { in: ['l3'] }, assignedToId: 'u-bob' }, data: { assignedToId: null } },
    ]);
    expect(h.assignmentUpdateMany).toHaveBeenCalledWith({
      where: { leadId: { in: ['l1', 'l2', 'l3'] }, isActive: true },
      data: { isActive: false },
    });
    const logged = (h.activityCreateMany.mock.calls[0][0] as { data: Array<Record<string, unknown>> }).data;
    expect(logged).toHaveLength(3);
    expect(logged[0]).toMatchObject({ leadId: 'l1', userId: 'mgr-1', action: 'lead_unassigned', oldValue: 'u-ann', newValue: null });
  });

  it('writes nothing when none of the leads has an owner', async () => {
    const h = harness([]);
    expect(await h.service.unassign(['l9'], 'mgr-1')).toEqual({ unassigned: 0, skipped: 1 });
    expect(h.leadUpdateMany).not.toHaveBeenCalled();
    expect(h.activityCreateMany).not.toHaveBeenCalled();
  });

  it('leaves a lead alone that changed hands between the read and the write', async () => {
    // l3 was reassigned to someone else in the meantime, so the guarded write
    // skipped it and it is not free afterwards.
    const h = harness(ROWS, ['l1', 'l2']);
    const res = await h.service.unassign(['l1', 'l2', 'l3'], 'mgr-1');

    expect(res).toEqual({ unassigned: 2, skipped: 1 });
    expect(h.assignmentUpdateMany).toHaveBeenCalledWith({
      where: { leadId: { in: ['l1', 'l2'] }, isActive: true },
      data: { isActive: false },
    });
    const logged = (h.activityCreateMany.mock.calls[0][0] as { data: Array<{ leadId: string }> }).data;
    expect(logged.map((a) => a.leadId)).toEqual(['l1', 'l2']);
  });
});
