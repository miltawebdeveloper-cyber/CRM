import { describe, expect, it, jest } from '@jest/globals';
import { AssignmentType, Timezone } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { AssignmentCarryForwardService } from './assignment-carry-forward.service';

/**
 * The carry-forward re-stamps an untouched lead for its own new day. The rules
 * that matter are about what it must NOT do — move a lead, look like a handover,
 * or move anything on the Indian calendar rather than the lead's.
 */
describe('AssignmentCarryForwardService', () => {
  type LeadRow = { id: string; assignedToId: string; timezone: Timezone | null; assignments: { assignedAt: Date }[] };

  function harness(leads: LeadRow[]) {
    const createMany = jest.fn(async (_a: { data: Array<Record<string, unknown>> }) => ({ count: _a.data.length }));
    const updateMany = jest.fn(async (_a: unknown) => ({ count: 1 }));
    const findMany = jest.fn(async (_a: unknown) => leads);
    const prisma = {
      lead: { findMany },
      assignment: { createMany, updateMany },
      $transaction: jest.fn(async (ops: unknown[]) => ops),
    } as unknown as PrismaService;
    return { service: new AssignmentCarryForwardService(prisma), createMany, updateMany, findMany };
  }

  const lead = (id: string, tz: Timezone | null, assignedAt: string): LeadRow => ({
    id,
    assignedToId: `rep-${id}`,
    timezone: tz,
    assignments: [{ assignedAt: new Date(assignedAt) }],
  });

  it('leaves a lead alone while its own US day is still running', async () => {
    // Assigned 15:00 EDT on the 13th. It is now 00:30 IST on the 14th — India
    // has turned over, New York has not. The spec's example, exactly.
    const { service, createMany } = harness([lead('a', Timezone.EST, '2026-08-13T19:00:00Z')]);

    const res = await service.run();

    expect(res.carried).toBe(0);
    expect(res.notYetTheirTomorrow).toBe(1);
    // Nothing written — the lead is still an August 13 lead.
    expect(createMany).not.toHaveBeenCalled();
  });

  it('carries the lead once ITS zone reaches the next day', async () => {
    // Same assignment, but now read at 01:00 EDT on the 14th.
    const { service, createMany } = harness([lead('a', Timezone.EST, '2026-08-13T19:00:00Z')]);
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T05:00:00Z'));
    try {
      const res = await service.run();
      expect(res.carried).toBe(1);
      expect(createMany.mock.calls[0][0].data[0].leadId).toBe('a');
    } finally {
      jest.useRealTimers();
    }
  });

  it('turns each zone over at its own moment', async () => {
    // 01:00 EDT on the 14th is still 22:00 PDT on the 13th.
    const { service, createMany } = harness([
      lead('east', Timezone.EST, '2026-08-13T19:00:00Z'),
      lead('west', Timezone.PST, '2026-08-13T19:00:00Z'),
    ]);
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T05:00:00Z'));
    try {
      const res = await service.run();
      // The east coast lead moves; the west coast one is still on the 13th.
      expect(res.carried).toBe(1);
      expect(res.notYetTheirTomorrow).toBe(1);
      expect(createMany.mock.calls[0][0].data.map((r) => r.leadId)).toEqual(['east']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the lead with the same rep — it is a re-stamp, not a handover', async () => {
    const { service, createMany } = harness([lead('a', Timezone.EST, '2026-08-01T12:00:00Z')]);
    await service.run();
    const row = createMany.mock.calls[0][0].data[0];
    expect(row.callerId).toBe('rep-a');
    // No previous caller: recording one would imply the lead changed hands.
    expect(row.previousCallerId).toBeNull();
    // Attributed to the owner, not to a manager who did nothing.
    expect(row.assignedById).toBe('rep-a');
  });

  it('marks the rows carry_forward so the same-day lock ignores them', async () => {
    const { service, createMany } = harness([lead('a', Timezone.EST, '2026-08-01T12:00:00Z')]);
    await service.run();
    expect(createMany.mock.calls[0][0].data[0].type).toBe(AssignmentType.carry_forward);
  });

  it('only considers open, assigned leads nobody has ever worked', async () => {
    const { service, findMany } = harness([]);
    await service.run();
    const where = (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.deletedAt).toBeNull();
    expect(where.assignedToId).toEqual({ not: null });
    expect(where.activities).toEqual({
      none: { action: { in: ['call_completed', 'lead_processed', 'outcome_updated'] } },
    });
    expect(where.status).toEqual({ notIn: ['closed', 'rejected'] });
  });

  it('writes nothing at all when there is nothing to carry', async () => {
    const { service, createMany, updateMany } = harness([]);
    const res = await service.run();
    expect(res).toMatchObject({ carried: 0, callers: 0 });
    expect(createMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
