import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AssignmentsService } from './assignments.service.js';
import { PendingCallsService } from './pending-calls.service.js';
import { assignmentState, readPendingMode, stampFor } from './assignment-progress.js';

/**
 * Pending calls: an assigned call whose day passed without the customer being
 * reached. The managers choose whether those move on by themselves (Automatic)
 * or wait for them (Manual), and can give them to anyone for a new day.
 */
describe('assignmentState — one rule for the queue, the carry-forward and Pending Calls', () => {
  const now = new Date('2026-11-24T15:00:00Z'); // Tue 10:00 in New York
  const base = { timezone: 'EST', leadStatus: 'contacted', reachedAt: null, now };

  it('is today’s work, pending once its day has passed, upcoming before its day', () => {
    expect(assignmentState({ ...base, assignedAt: new Date('2026-11-24T13:00:00Z') })).toBe('today');
    expect(assignmentState({ ...base, assignedAt: new Date('2026-11-23T20:00:00Z') })).toBe('pending');
    expect(assignmentState({ ...base, assignedAt: new Date('2026-11-25T05:00:00Z') })).toBe('upcoming');
    // Read on the lead's calendar: 02:00 UTC on the 24th is still the 23rd in New York.
    expect(assignmentState({ ...base, assignedAt: new Date('2026-11-24T02:00:00Z') })).toBe('pending');
  });

  it('is completed once the customer was reached since it was assigned — not by an earlier reach', () => {
    const assignedAt = new Date('2026-11-23T14:00:00Z');
    expect(assignmentState({ ...base, assignedAt, reachedAt: new Date('2026-11-23T16:00:00Z') })).toBe('completed');
    expect(assignmentState({ ...base, assignedAt, reachedAt: new Date('2026-11-20T16:00:00Z') })).toBe('pending');
  });

  it('is completed for a closed or rejected lead, however it got there', () => {
    expect(assignmentState({ ...base, leadStatus: 'closed', assignedAt: new Date('2026-11-20T14:00:00Z') })).toBe('completed');
    expect(assignmentState({ ...base, leadStatus: 'rejected', assignedAt: new Date('2026-11-20T14:00:00Z') })).toBe('completed');
  });

  it('counts a lead assigned before history was kept as today’s work', () => {
    expect(assignmentState({ ...base, assignedAt: null })).toBe('today');
  });
});

describe('stampFor — giving a call for a day', () => {
  const now = new Date('2026-11-24T15:00:00Z');
  it('is now for today, the start of the day on the lead’s clock for a later one, and refuses a day gone', () => {
    expect(stampFor('2026-11-24', 'EST', now)).toBe(now);
    expect(stampFor('2026-11-26', 'EST', now)?.toISOString()).toBe('2026-11-26T05:00:00.000Z');
    expect(stampFor('2026-11-23', 'EST', now)).toBeNull();
  });
});

describe('readPendingMode', () => {
  const read = (value: unknown) =>
    readPendingMode({ appSetting: { findUnique: jest.fn(async () => (value === undefined ? null : { value })) } } as unknown as PrismaService);
  it('is Automatic until a manager chooses, and ignores anything it doesn’t recognise', async () => {
    expect(await read(undefined)).toBe('automatic');
    expect(await read({ mode: 'manual' })).toBe('manual');
    expect(await read({ mode: 'sometimes' })).toBe('automatic');
  });
});

describe('PendingCallsService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  type LeadRow = {
    id: string; leadId: string; businessName: string; timezone: string; status: string;
    assignedTo: { id: string; name: string }; assignments: { assignedAt: Date }[];
    contactName: null; phone: string; state: string;
  };
  const lead = (id: string, owner: [string, string], assignedAt: string): LeadRow => ({
    id, leadId: `L-${id}`, businessName: `Co ${id}`, timezone: 'EST', status: 'contacted', contactName: null, phone: '555', state: 'NY',
    assignedTo: { id: owner[0], name: owner[1] }, assignments: [{ assignedAt: new Date(assignedAt) }],
  });

  function harness(leads: LeadRow[], log: { leadId: string; at: string; outcome: string }[] = [], mode?: 'manual' | 'automatic') {
    const assignMany = jest.fn(async (ids: string[], callerId: string, ..._rest: unknown[]) => ({ assigned: ids.length, callerId, skipped: [] }));
    const upsert = jest.fn(async (_a: unknown) => ({}));
    const activityCreate = jest.fn(async (_a: unknown) => ({}));
    const prisma = {
      lead: {
        findMany: jest.fn(async (args: { select?: { assignedToId?: boolean } }) =>
          args.select?.assignedToId ? leads.map((l) => ({ id: l.id, assignedToId: l.assignedTo.id })) : leads,
        ),
      },
      activity: {
        findMany: jest.fn(async (args: { where?: { newValue?: unknown } }) =>
          log
            .filter((r) => !args.where?.newValue || r.outcome === 'call_back')
            .map((r) => ({ leadId: r.leadId, createdAt: new Date(r.at), newValue: r.outcome })),
        ),
        create: activityCreate,
      },
      outcome: { findMany: jest.fn(async () => [{ slug: 'call_back' }]) },
      assignment: {
        findMany: jest.fn(async () => leads.map((l) => ({ leadId: l.id, assignedAt: l.assignments[0].assignedAt }))),
      },
      appSetting: { findUnique: jest.fn(async () => (mode ? { value: { mode } } : null)), upsert },
    } as unknown as PrismaService;
    const service = new PendingCallsService(prisma, { assignMany } as unknown as AssignmentsService);
    return { service, assignMany, upsert, activityCreate };
  }

  it('lists only calls whose day passed unreached, employee-wise then date-wise, with the tries since', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-24T15:00:00Z')); // Tue 10:00 in New York
    const { service } = harness(
      [
        lead('today', ['u-ann', 'Ann'], '2026-11-24T13:00:00Z'), // today's — not pending
        lead('reached', ['u-ann', 'Ann'], '2026-11-23T14:00:00Z'), // reached since — completed
        lead('bob-mon', ['u-bob', 'Bob'], '2026-11-23T14:00:00Z'),
        lead('ann-mon', ['u-ann', 'Ann'], '2026-11-23T14:00:00Z'),
        lead('ann-fri', ['u-ann', 'Ann'], '2026-11-20T14:00:00Z'),
      ],
      [
        { leadId: 'reached', at: '2026-11-23T16:00:00Z', outcome: 'call_back' },
        { leadId: 'ann-mon', at: '2026-11-23T15:00:00Z', outcome: 'no_answer' },
        { leadId: 'ann-mon', at: '2026-11-23T19:00:00Z', outcome: 'voice_mail' },
      ],
      'manual',
    );
    const res = await service.list();
    expect(res.mode).toBe('manual');
    expect(res.items.map((i) => i.id)).toEqual(['ann-fri', 'ann-mon', 'bob-mon']);
    expect(res.items[1]).toMatchObject({ assignedOn: '2026-11-23', attempts: 2, lastOutcome: 'voice_mail', owner: { name: 'Ann' } });
  });

  it('reschedules for a day, keeping each call with its employee unless one is named', async () => {
    const { service, assignMany } = harness([lead('a', ['u-ann', 'Ann'], '2026-11-20T14:00:00Z'), lead('b', ['u-bob', 'Bob'], '2026-11-20T14:00:00Z')]);
    await service.reschedule({ leadIds: ['a', 'b'], day: '2026-11-26' }, 'mgr');
    expect(assignMany.mock.calls.map((c) => [c[0], c[1]])).toEqual([[['a'], 'u-ann'], [['b'], 'u-bob']]);
    // A transfer is allowed, and the day travels with it.
    expect(assignMany.mock.calls[0].slice(4)).toEqual([true, false, { day: '2026-11-26', remark: 'Rescheduled from Pending Calls' }]);

    assignMany.mockClear();
    await service.reschedule({ leadIds: ['a', 'b'], callerId: 'u-cara', day: '2026-11-26' }, 'mgr');
    expect(assignMany.mock.calls.map((c) => [c[0], c[1]])).toEqual([[['a', 'b'], 'u-cara']]);
  });

  it('stores the managers’ choice and records who changed it', async () => {
    const { service, upsert, activityCreate } = harness([], [], 'automatic');
    expect(await service.setMode('manual', 'mgr')).toBe('manual');
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ create: { key: 'calling:pending-mode', value: { mode: 'manual' } } }));
    expect(activityCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'pending_mode_changed', oldValue: 'automatic', newValue: 'manual' }) }));
  });
});

/** The assign step behind "reschedule": a call given FOR a day. */
describe('AssignmentsService.assignMany — for a day', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  function harness(prior: Array<{ id: string; assignedToId: string | null; timezone: string }>) {
    const createMany = jest.fn(async (_a: { data: Array<Record<string, unknown>> }) => ({ count: 1 }));
    const activityCreateMany = jest.fn(async (_a: { data: Array<Record<string, unknown>> }) => ({ count: 1 }));
    const tx = {
      lead: {
        updateMany: jest.fn(async () => ({ count: 1 })),
        findMany: jest.fn(async (args: { where: { id: { in: string[] } } }) => args.where.id.in.map((id) => ({ id }))),
      },
      assignment: { updateMany: jest.fn(async () => ({ count: 1 })), createMany },
      activity: { createMany: activityCreateMany },
    };
    const prisma = {
      lead: { findMany: jest.fn(async () => prior.map((p) => ({ ...p, leadId: `L-${p.id}`, callStatus: 'no_answer', assignedTo: { name: 'Ann' } }))) },
      user: { findUnique: jest.fn(async () => ({ name: 'Ann' })) },
      assignment: { findMany: jest.fn(async () => []) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;
    return { service: new AssignmentsService(prisma), createMany, activityCreateMany };
  }

  it('stamps a later day at its start on the lead’s clock, logs a same-employee move, and refuses a day gone', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-24T15:00:00Z'));
    const h = harness([
      { id: 'a', assignedToId: 'u-ann', timezone: 'EST' },
      { id: 'b', assignedToId: 'u-ann', timezone: 'PST' },
    ]);
    const res = await h.service.assignMany(['a', 'b'], 'u-ann', 'mgr', undefined, true, false, { day: '2026-11-26', remark: 'Rescheduled' });
    expect(res.assigned).toBe(2);
    const rows = h.createMany.mock.calls[0][0].data;
    expect(rows.map((r) => (r.assignedAt as Date).toISOString())).toEqual(['2026-11-26T05:00:00.000Z', '2026-11-26T08:00:00.000Z']);
    expect(rows[0].remarks).toContain('for 2026-11-26');
    // Same employee: nothing changed hands, but the new day is in the lead's log.
    const logged = h.activityCreateMany.mock.calls.flatMap((c) => c[0].data);
    expect(logged.filter((a) => a.action === 'lead_rescheduled')).toHaveLength(2);

    const past = harness([{ id: 'c', assignedToId: 'u-ann', timezone: 'EST' }]);
    const r2 = await past.service.assignMany(['c'], 'u-ann', 'mgr', undefined, true, false, { day: '2026-11-23' });
    expect(r2.assigned).toBe(0);
    expect(r2.skipped).toHaveLength(1);
    expect(past.createMany).not.toHaveBeenCalled();
  });
});
