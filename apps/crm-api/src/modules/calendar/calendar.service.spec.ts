import { describe, expect, it, jest } from '@jest/globals';
import { Role } from '@crm/database';
import { CalendarService } from './calendar.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

/**
 * 20:00 Eastern on 1 Aug 2026 is 05:30 on 2 Aug in Kolkata. The grid cell an
 * event lands in must be the day on the CUSTOMER's calendar, not the server's —
 * a server on IST used to file this Eastern callback under the 2nd.
 */
describe('CalendarService — events land on the lead\'s calendar day', () => {
  const AT = new Date('2026-08-02T00:00:00Z'); // 8pm EDT on Aug 1, 5:30am IST on Aug 2

  const serviceWith = (tz: string) => {
    const lead = {
      id: 'l1', leadId: 'L-1', businessName: 'Acme', contactName: null, status: 'new', timezone: tz,
      assignedTo: null, callbackAt: AT, callbackCompletedAt: null, nextFollowUpDate: null,
    };
    const prisma = {
      lead: { findMany: jest.fn(async (args: { where?: { callbackAt?: unknown } }) => (args.where?.callbackAt ? [lead] : [])) },
      zoomMeeting: { findMany: jest.fn(async () => []) },
      task: { findMany: jest.fn(async () => []) },
    } as unknown as PrismaService;
    return new CalendarService(prisma);
  };

  it('puts an Eastern lead\'s evening callback on Aug 1', async () => {
    const { events } = await serviceWith('EST').events({ from: '2026-08-01', to: '2026-08-31' }, { id: 'u', role: Role.admin });
    expect(events[0]).toMatchObject({ ymd: '2026-08-01', day: 1 });
  });

  it('puts the same instant on Aug 2 for an India lead', async () => {
    const { events } = await serviceWith('IND').events({ from: '2026-08-01', to: '2026-08-31' }, { id: 'u', role: Role.admin });
    expect(events[0]).toMatchObject({ ymd: '2026-08-02', day: 2 });
  });
});

/**
 * Booking a callback writes the same time into Next Follow-up. That's one
 * appointment: it shows once, as the callback, and counts once.
 */
describe('CalendarService — one appointment, shown once', () => {
  const AT = new Date('2026-11-24T15:00:00Z');
  const LATER = new Date('2026-11-26T15:00:00Z');
  function serviceWith(leads: Array<{ id: string; callbackAt: Date | null; nextFollowUpDate: Date | null }>, zooms: unknown[] = []) {
    const rows = leads.map((l) => ({
      leadId: `L-${l.id}`, businessName: `Co ${l.id}`, contactName: null, status: 'contacted', timezone: 'EST', assignedTo: null, callbackCompletedAt: null, ...l,
    }));
    const prisma = {
      lead: {
        findMany: jest.fn(async (args: { where?: { callbackAt?: unknown; nextFollowUpDate?: unknown } }) =>
          args.where?.callbackAt ? rows.filter((r) => r.callbackAt) : rows.filter((r) => r.nextFollowUpDate),
        ),
      },
      zoomMeeting: { findMany: jest.fn(async () => zooms) },
      task: { findMany: jest.fn(async () => []) },
    } as unknown as PrismaService;
    return new CalendarService(prisma);
  }

  it('lists a callback and its matching follow-up once, as the callback', async () => {
    const { events, summary } = await serviceWith([{ id: 'a', callbackAt: AT, nextFollowUpDate: AT }]).events({ from: '2026-11-01', to: '2026-11-30' }, { id: 'u', role: Role.admin });
    expect(events.map((e) => e.type)).toEqual(['callback']);
    expect(summary).toEqual({ calls: 0, callbacks: 1, zooms: 0, tasks: 0, total: 1 });
  });

  it('keeps a follow-up that is a different appointment from the callback', async () => {
    const { events, summary } = await serviceWith([{ id: 'a', callbackAt: AT, nextFollowUpDate: LATER }]).events({ from: '2026-11-01', to: '2026-11-30' }, { id: 'u', role: Role.admin });
    expect(events.map((e) => e.type)).toEqual(['callback', 'call']);
    expect(summary.total).toBe(2);
  });

  it('carries what the side panel needs: the lead to open, the meeting and its join link', async () => {
    const zoom = {
      id: 'm1', scheduledAt: LATER, status: 'scheduled', title: 'Demo', joinUrl: 'https://zoom.us/j/1',
      organizer: { name: 'Ann' }, lead: { id: 'lead-uuid', leadId: 'L-9', businessName: 'Acme', contactName: null, timezone: 'EST', assignedTo: null },
    };
    const { events } = await serviceWith([{ id: 'a', callbackAt: AT, nextFollowUpDate: null }], [zoom]).events({ from: '2026-11-01', to: '2026-11-30' }, { id: 'u', role: Role.admin });
    expect(events.find((e) => e.type === 'callback')).toMatchObject({ leadRef: 'a', meetingId: null });
    expect(events.find((e) => e.type === 'zoom')).toMatchObject({ leadRef: 'lead-uuid', meetingId: 'm1', joinUrl: 'https://zoom.us/j/1' });
  });
});

/**
 * Tasks with a due date sit on the calendar too — but a task board is personal,
 * so only on the viewer's own schedule, and never the task a meeting files for
 * itself (the meeting is already there).
 */
describe('CalendarService — tasks', () => {
  const DUE = new Date('2026-11-24T20:00:00Z');
  function serviceWithTask() {
    const task = { id: 't1', title: 'Send the proposal', status: 'todo', priority: 'high', dueDate: DUE, owner: { name: 'Lisa' } };
    const findMany = jest.fn(async (_args: unknown) => [task]);
    const prisma = {
      lead: { findMany: jest.fn(async () => []) },
      zoomMeeting: { findMany: jest.fn(async () => []) },
      task: { findMany },
    } as unknown as PrismaService;
    return { service: new CalendarService(prisma), findMany };
  }
  const NOV = { from: '2026-11-01', to: '2026-11-30' };

  it('shows an employee their own open tasks, not done ones nor a meeting’s', async () => {
    const { service, findMany } = serviceWithTask();
    const { events, summary } = await service.events(NOV, { id: 'lisa', role: Role.employee });
    expect(events[0]).toMatchObject({ type: 'task', id: 'task-t1', taskId: 't1', companyName: 'Send the proposal', priority: 'high', status: 'todo', leadRef: null });
    expect(summary).toMatchObject({ tasks: 1, total: 1 });
    const where = (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ ownerId: 'lisa', status: { not: 'done' }, zoomMeeting: { is: null } });
  });

  it('shows a manager their own tasks on the whole-team view', async () => {
    const { service, findMany } = serviceWithTask();
    await service.events(NOV, { id: 'boss', role: Role.admin });
    expect((findMany.mock.calls[0][0] as { where: { ownerId: string } }).where.ownerId).toBe('boss');
  });

  it('shows no tasks when a manager narrows the calendar to someone else', async () => {
    const { service, findMany } = serviceWithTask();
    const { events } = await service.events(NOV, { id: 'boss', role: Role.team_leader }, 'lisa');
    expect(findMany).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

/** The team view groups by WHO each item belongs to, by id — two reps can share a name. */
describe('CalendarService — whose item it is', () => {
  it('is the lead’s owner for calls and callbacks, the organiser (else the lead’s owner) for a meeting', async () => {
    const AT = new Date('2026-11-24T15:00:00Z');
    const lead = {
      id: 'l1', leadId: 'L-1', businessName: 'Acme', contactName: null, status: 'contacted', timezone: 'EST',
      assignedToId: 'lisa', assignedTo: { name: 'Lisa' }, callbackAt: AT, callbackCompletedAt: null, nextFollowUpDate: null,
    };
    const base = { status: 'scheduled', title: null, joinUrl: null, durationMins: 30, organizer: null };
    const zooms = [
      { ...base, id: 'm1', scheduledAt: AT, organizerId: 'ann', lead: { id: 'l1', leadId: 'L-1', businessName: 'Acme', contactName: null, timezone: 'EST', assignedToId: 'lisa', assignedTo: null } },
      { ...base, id: 'm2', scheduledAt: AT, organizerId: null, lead: { id: 'l1', leadId: 'L-1', businessName: 'Acme', contactName: null, timezone: 'EST', assignedToId: 'lisa', assignedTo: null } },
    ];
    const prisma = {
      lead: { findMany: jest.fn(async (args: { where?: { callbackAt?: unknown } }) => (args.where?.callbackAt ? [lead] : [])) },
      zoomMeeting: { findMany: jest.fn(async () => zooms) },
      task: { findMany: jest.fn(async () => []) },
    } as unknown as PrismaService;
    const { events } = await new CalendarService(prisma).events({ from: '2026-11-01', to: '2026-11-30' }, { id: 'u', role: Role.admin });
    expect(Object.fromEntries(events.map((e) => [e.id, e.ownerId]))).toEqual({ 'callback-l1': 'lisa', 'zoom-m1': 'ann', 'zoom-m2': 'lisa' });
  });
});
