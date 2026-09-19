import { describe, expect, it, jest } from '@jest/globals';
import { AssignmentType, Timezone } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AssignmentCarryForwardService } from './assignment-carry-forward.service.js';

/**
 * The carry-forward re-stamps an unfinished lead for its own new day. The rules
 * that matter are about what it must NOT do — move a lead between people, look
 * like a handover, duplicate the lead, or move anything on the Indian calendar
 * rather than the lead's — and about which leads count as unfinished, which is
 * where "a call that never completed" belongs and used not to.
 */
describe('AssignmentCarryForwardService', () => {
  type LeadRow = {
    id: string;
    assignedToId: string;
    timezone: Timezone | null;
    callStatus: string | null;
    callbackAt: Date | null;
    callbackCompletedAt: Date | null;
    zoomMeetings: { scheduledAt: Date }[];
    assignments: { assignedAt: Date }[];
  };

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

  /** An open lead nobody has reached, stamped for the day it was assigned. */
  const lead = (id: string, tz: Timezone | null, assignedAt: string, over: Partial<LeadRow> = {}): LeadRow => ({
    id,
    assignedToId: `rep-${id}`,
    timezone: tz,
    callStatus: null,
    callbackAt: null,
    callbackCompletedAt: null,
    zoomMeetings: [],
    assignments: [{ assignedAt: new Date(assignedAt) }],
    ...over,
  });

  it('leaves a lead alone while its own US day is still running', async () => {
    // Assigned 15:00 EDT on the 13th, read at 01:00 IST on the 14th — India has
    // turned over, New York has not. The spec's example, exactly.
    //
    // Pinned, like every other dated case here. Read against the real clock this
    // scenario only holds for the few hours the machine happens to agree with
    // it, and a rule about which calendar day a lead falls on is the last thing
    // that should be decided by when the suite is run.
    const { service, createMany } = harness([lead('a', Timezone.EST, '2026-08-13T19:00:00Z')]);
    jest.useFakeTimers().setSystemTime(new Date('2026-08-13T19:30:00Z'));
    try {
      const res = await service.run();

      expect(res.carried).toBe(0);
      expect(res.notYetTheirTomorrow).toBe(1);
      // Nothing written — the lead is still an August 13 lead.
      expect(createMany).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
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

  it('writes one assignment row per lead and never a second lead', async () => {
    // The whole move is one row in the assignment trail. Nothing here creates a
    // lead, and the write names the SAME lead id — a carried lead is the same
    // record on a new day, so its calls, notes and created date stay put.
    const { service, createMany, updateMany } = harness([
      lead('a', Timezone.EST, '2026-08-01T12:00:00Z'),
      lead('b', Timezone.EST, '2026-08-01T12:00:00Z'),
    ]);
    const res = await service.run();

    expect(res.carried).toBe(2);
    const rows = createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.leadId)).toEqual(['a', 'b']);
    // The old active rows are closed in the same transaction, so no lead is ever
    // briefly shown with two active assignments.
    expect(updateMany.mock.calls[0][0]).toMatchObject({ where: { isActive: true } });
  });

  it('only considers open, owned leads — not "never worked" ones', async () => {
    const { service, findMany } = harness([]);
    await service.run();
    const where = (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.deletedAt).toBeNull();
    expect(where.assignedToId).toEqual({ not: null });
    expect(where.status).toEqual({ notIn: ['closed', 'rejected'] });
    // The rule that a lead dialled once was out of scope for life is gone: a
    // call that rang out is pending work, not a finished lead.
    expect(where.activities).toBeUndefined();
  });

  it('excludes far-future appointments in SQL, without excluding leads that have none', async () => {
    // The read is capped at 5,000 rows and a booked lead is never carried, so
    // it would sit in the candidate window forever and eventually crowd out the
    // leads that do need moving. They are dropped in the query instead.
    const { service, findMany } = harness([]);
    await service.run();
    const where = (findMany.mock.calls[0][0] as { where: Record<string, unknown>; orderBy: unknown }).where;

    // Positive branches only: a `NOT (…)` phrasing evaluates to NULL for a lead
    // with no callback at all and would drop every such lead — i.e. most of the
    // book — which is exactly the bug this shape avoids.
    const or = where.OR as Array<Record<string, unknown>>;
    expect(or).toHaveLength(3);
    expect(or[0]).toEqual({ callbackAt: null });
    expect(or[1]).toEqual({ callbackCompletedAt: { not: null } });
    expect(or[2]).toHaveProperty('callbackAt.lte');
    expect(where.zoomMeetings).toHaveProperty('none.scheduledAt.gt');

    // And a stable order, so a capped sweep clears the oldest part of the book
    // instead of whatever the planner happened to return.
    expect((findMany.mock.calls[0][0] as { orderBy: unknown }).orderBy).toEqual({ importSeq: 'asc' });
  });

  it('carries a lead whose call was made but never completed', async () => {
    // Dialled yesterday, dispositioned "no answer", still open, nothing booked.
    // Under the old "never worked" rule this lead was dropped from every
    // following day's queue; it is exactly the pending work tomorrow is for.
    const { service, createMany } = harness([
      lead('a', Timezone.EST, '2026-08-01T12:00:00Z', { callStatus: 'no_answer' }),
    ]);

    const res = await service.run();

    expect(res.carried).toBe(1);
    // The remark names the reason, so the trail explains the move on its own.
    expect(createMany.mock.calls[0][0].data[0].remarks).toContain('no_answer');
  });

  it('leaves a lead booked for a later day where it is', async () => {
    // A callback agreed for next week is scheduled FOR next week. Re-stamping it
    // into today would have every "assigned today" view claim a call nobody
    // intends to make yet.
    const { service, createMany } = harness([
      lead('a', Timezone.EST, '2026-08-01T12:00:00Z', { callbackAt: new Date('2026-08-20T14:00:00Z') }),
    ]);
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T15:00:00Z'));
    try {
      const res = await service.run();
      expect(res.carried).toBe(0);
      expect(res.bookedForALaterDay).toBe(1);
      expect(createMany).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('carries a lead whose booked call is overdue', async () => {
    // The appointment's day has been and gone without the call — pending work,
    // and today's. (The callback rollover moves the appointment itself; the two
    // agree, because once it is in the future the test above parks the lead.)
    const { service, createMany } = harness([
      lead('a', Timezone.EST, '2026-08-01T12:00:00Z', { callbackAt: new Date('2026-08-10T14:00:00Z') }),
    ]);
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T15:00:00Z'));
    try {
      const res = await service.run();
      expect(res.carried).toBe(1);
      expect(createMany.mock.calls[0][0].data[0].leadId).toBe('a');
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores a future callback that has already been completed', async () => {
    // A completed appointment is history, not a commitment — `callbackAt` alone
    // would park this lead forever on the strength of a call that happened.
    const { service, createMany } = harness([
      lead('a', Timezone.EST, '2026-08-01T12:00:00Z', {
        callbackAt: new Date('2026-08-20T14:00:00Z'),
        callbackCompletedAt: new Date('2026-08-12T14:00:00Z'),
      }),
    ]);
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T15:00:00Z'));
    try {
      expect((await service.run()).carried).toBe(1);
      expect(createMany).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves a lead alone while a Zoom meeting is booked ahead of it', async () => {
    const { service } = harness([
      lead('a', Timezone.EST, '2026-08-01T12:00:00Z', { zoomMeetings: [{ scheduledAt: new Date('2026-08-21T15:00:00Z') }] }),
    ]);
    jest.useFakeTimers().setSystemTime(new Date('2026-08-14T15:00:00Z'));
    try {
      const res = await service.run();
      expect(res.carried).toBe(0);
      expect(res.bookedForALaterDay).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('writes nothing at all when there is nothing to carry', async () => {
    const { service, createMany, updateMany } = harness([]);
    const res = await service.run();
    expect(res).toMatchObject({ carried: 0, callers: 0 });
    expect(createMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
