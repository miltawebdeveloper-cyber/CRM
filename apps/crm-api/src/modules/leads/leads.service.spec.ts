import { describe, expect, it, jest } from '@jest/globals';
import { PrismaService } from '../../prisma/prisma.service';
import { LeadsService } from './leads.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LeadIdService } from './lead-id.service';

describe('LeadsService import optimization helpers', () => {
  it('builds a compact set of update windows for a phone field', () => {
    const service = new LeadsService({} as PrismaService, {} as NotificationsService, {} as LeadIdService);
    const buildWindows = (service as unknown as { buildUpdateWindows?: (raw?: string | null, keyLens?: Set<number>) => Set<string> }).buildUpdateWindows;
    expect(buildWindows).toBeDefined();

    const windows = buildWindows?.('3055551234', new Set([10]));
    expect(windows).toEqual(new Set(['3055551234']));
  });
});

/**
 * A comment is a trail entry, not a column value.
 *
 * Re-entering the same remark used to be dropped as "no change": the field diff
 * skipped it, and the early return that fires when nothing else changed skipped
 * the history write with it. "Left voicemail" on Monday and again on Thursday is
 * two calls, and the second one silently vanished.
 */
describe('LeadsService — comments are always recorded', () => {
  const LEAD = { id: 'lead-1', leadId: 'L-2026-1', comments: 'Left voicemail', assignedToId: 'user-1', assignedTo: null, status: 'new', timezone: 'EST' };

  function harness() {
    const noteCreate = jest.fn(async (_args: { data: Record<string, unknown> }) => ({ id: 'note-1' }));
    const prisma = {
      lead: {
        findFirst: jest.fn(async () => LEAD),
        update: jest.fn(async () => ({ ...LEAD })),
        // Read by `log` when a real column change is written — clearing a
        // comment is one, so that path is reached.
        findUnique: jest.fn(async () => ({ callStatus: null, assignedToId: 'user-1' })),
      },
      note: { create: noteCreate },
      activity: { create: jest.fn(async () => ({})) },
    } as unknown as PrismaService;
    const service = new LeadsService(prisma, {} as NotificationsService, {} as LeadIdService);
    return { service, noteCreate };
  }

  it('records a repeated remark rather than treating it as no change', async () => {
    const { service, noteCreate } = harness();
    // Byte-identical to what is already on the lead — the case that was lost.
    await service.update('lead-1', { comments: 'Left voicemail' } as never, { id: 'user-1', role: 'admin' } as never);
    expect(noteCreate).toHaveBeenCalledTimes(1);
    expect(noteCreate.mock.calls[0][0].data.noteText).toBe('Left voicemail');
  });

  it('ignores an empty comment — clearing the field is not a remark', async () => {
    const { service, noteCreate } = harness();
    await service.update('lead-1', { comments: '   ' } as never, { id: 'user-1', role: 'admin' } as never);
    expect(noteCreate).not.toHaveBeenCalled();
  });
});

/**
 * The created timestamp is the lead's origin and survives everything.
 *
 * Lead Management shows it as Created Date & Time, and its whole value is that
 * it means the same thing on a lead created this morning and on one that has
 * been handed between three reps and carried forward for a fortnight. That
 * guarantee comes from `createdAt` never appearing in an update — so this asserts
 * on the write itself rather than on a returned row, because a row that happens
 * to carry the old value tells you nothing about whether the next edit will.
 */
describe('LeadsService — a reassignment never rewrites the created timestamp', () => {
  const CREATED = new Date('2026-01-09T14:32:00Z');
  const LEAD = {
    id: 'lead-1',
    leadId: 'L-2026-1',
    businessName: 'Acme',
    comments: null,
    assignedToId: 'rep-old',
    assignedTo: { id: 'rep-old', name: 'Old Rep' },
    status: 'new',
    timezone: 'EST',
    createdAt: CREATED,
  };

  function harness() {
    const update = jest.fn(async (args: { data: Record<string, unknown> }) => ({ ...LEAD, ...args.data }));
    const prisma = {
      lead: {
        findFirst: jest.fn(async () => LEAD),
        findUnique: jest.fn(async () => ({ callStatus: null, assignedToId: 'rep-old', timezone: 'EST', assignments: [] })),
        update,
      },
      user: { findFirst: jest.fn(async () => ({ id: 'rep-new' })) },
      note: { create: jest.fn(async () => ({ id: 'note-1' })) },
      activity: { create: jest.fn(async () => ({})) },
      assignment: { updateMany: jest.fn(async () => ({ count: 1 })), create: jest.fn(async () => ({})) },
    } as unknown as PrismaService;
    const service = new LeadsService(prisma, {} as NotificationsService, {} as LeadIdService);
    return { service, prisma, update };
  }

  it('changes the owner and leaves createdAt out of the write entirely', async () => {
    const { service, update, prisma } = harness();

    await service.update('lead-1', { caller: 'New Rep' } as never, { id: 'admin-1', role: 'admin' } as never);

    const data = update.mock.calls[0][0].data;
    // The handover itself happened…
    expect(data.assignedTo).toEqual({ connect: { id: 'rep-new' } });
    // …and the origin stamp was not among the columns written. Nor was any
    // alias of it, which is what a "reset the dates" edit would look like.
    expect(data).not.toHaveProperty('createdAt');
    expect(data).not.toHaveProperty('created_at');

    // The move is recorded where moves are recorded — one assignment row — so
    // the lead keeps its history instead of being restated as a new lead.
    const assignment = prisma.assignment as unknown as { create: jest.Mock };
    expect(assignment.create).toHaveBeenCalledTimes(1);
  });

  it('leaves the lead in its own time zone when it changes hands', () => {
    // The zone belongs to the CUSTOMER, not to whoever is working the lead, and
    // every date the module shows for this lead is read on it — created,
    // scheduled, the day the next-day sweep moves it to. A handover that carried
    // the new owner's zone across would silently re-date the lead's whole
    // history, so `timezone` must never appear in a reassignment's write.
    const { service, update } = harness();

    return service
      .update('lead-1', { caller: 'New Rep' } as never, { id: 'admin-1', role: 'admin' } as never)
      .then(() => {
        expect(update.mock.calls[0][0].data).not.toHaveProperty('timezone');
      });
  });

  it('leaves createdAt out of an ordinary field edit too', async () => {
    const { service, update } = harness();

    await service.update('lead-1', { businessName: 'Acme Holdings' } as never, { id: 'admin-1', role: 'admin' } as never);

    const data = update.mock.calls[0][0].data;
    expect(data.businessName).toBe('Acme Holdings');
    expect(data).not.toHaveProperty('createdAt');
  });
});

/**
 * Lead Management dates a lead two ways, and the list has to be able to filter
 * on either.
 *
 * `createdAt` is when the lead was first created and never moves. The active
 * assignment's stamp is the day the lead is currently queued for, and it moves —
 * on a reassignment, and every night the carry-forward rolls an unfinished lead
 * into its next local day. A filter that only understood the first answered
 * "leads created in this range" while presenting itself as "leads in this range",
 * so a manager exporting a day got the leads that ARRIVED that day and none of
 * the ones carried INTO it.
 */
describe('LeadsService.findAll — which date the range filters on', () => {
  function harness(rows: unknown[] = []) {
    const findMany = jest.fn(async (_a: unknown) => rows);
    const count = jest.fn(async (_a: unknown) => rows.length);
    const prisma = {
      lead: { findMany, count },
      $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
    } as unknown as PrismaService;
    const service = new LeadsService(prisma, {} as NotificationsService, {} as LeadIdService);
    return { service, findMany, count };
  }

  /** The WHERE the page read was actually issued with. */
  const whereOf = (findMany: ReturnType<typeof jest.fn>) =>
    (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;

  it('applies no date filter at all when no range is given', async () => {
    const { service, findMany } = harness();
    await service.findAll({ closed: false } as never);
    const where = whereOf(findMany);
    expect(where).not.toHaveProperty('createdAt');
    expect(where).not.toHaveProperty('assignments');
  });

  it('filters on the original created timestamp by default', async () => {
    // No `dateField` — every caller that existed before the option keeps the
    // behaviour it had.
    const { service, findMany } = harness();
    await service.findAll({ closed: false, createdFrom: '2026-08-01', createdTo: '2026-08-14' } as never);

    const where = whereOf(findMany);
    expect(where.createdAt).toEqual({
      gte: new Date('2026-08-01'),
      // The end of the closing day, not its midnight — a single-day filter has
      // to span the day, or "14 August" matches only leads created at 00:00:00.
      lte: new Date('2026-08-14T23:59:59.999Z'),
    });
    expect(where).not.toHaveProperty('assignments');
  });

  it('filters on the scheduled day when asked, and leaves createdAt alone', async () => {
    const { service, findMany } = harness();
    await service.findAll({
      closed: false,
      createdFrom: '2026-08-14',
      createdTo: '2026-08-14',
      dateField: 'scheduled',
    } as never);

    const where = whereOf(findMany);
    // The ACTIVE assignment only: a lead's closed rows are the days it used to
    // be scheduled for, and matching them would return a lead for every day it
    // has ever been carried.
    expect(where.assignments).toEqual({
      some: {
        isActive: true,
        assignedAt: { gte: new Date('2026-08-14'), lte: new Date('2026-08-14T23:59:59.999Z') },
      },
    });
    expect(where).not.toHaveProperty('createdAt');
  });

  it('accepts an open-ended range on either date', async () => {
    const { service, findMany } = harness();
    await service.findAll({ closed: false, createdFrom: '2026-08-01' } as never);
    expect(whereOf(findMany).createdAt).toEqual({ gte: new Date('2026-08-01') });

    const scheduled = harness();
    await scheduled.service.findAll({ closed: false, createdTo: '2026-08-14', dateField: 'scheduled' } as never);
    expect(whereOf(scheduled.findMany).assignments).toEqual({
      some: { isActive: true, assignedAt: { lte: new Date('2026-08-14T23:59:59.999Z') } },
    });
  });
});

/**
 * Both dates have to reach the client on every row, and mean different things.
 *
 * The grid shows Created Date & Time beside Scheduled Date, and the export
 * writes both into the file. They come from different places — one a column on
 * the lead, one the active assignment — so the row the API hands over has to
 * carry the pair already flattened, along with how the lead came to be on that
 * date and how many times it has been moved.
 */
describe('LeadsService — the scheduling pair on every row', () => {
  const CREATED = new Date('2026-07-02T09:14:00Z');
  const SCHEDULED = new Date('2026-08-14T04:00:00Z');

  /** A row shaped the way `LIST_SELECT` returns one. */
  const dbRow = (over: Record<string, unknown> = {}) => ({
    id: 'lead-1',
    leadId: 'L-2026-1',
    businessName: 'Acme',
    createdAt: CREATED,
    assignments: [{ assignedAt: SCHEDULED, type: 'carry_forward' }],
    _count: { assignments: 3 },
    ...over,
  });

  function harness(rows: unknown[]) {
    const findMany = jest.fn(async (_a: unknown) => rows);
    const count = jest.fn(async (_a: unknown) => rows.length);
    const findFirst = jest.fn(async (_a: unknown) => rows[0]);
    const prisma = {
      lead: { findMany, count, findFirst },
      $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
    } as unknown as PrismaService;
    const service = new LeadsService(prisma, {} as NotificationsService, {} as LeadIdService);
    return { service, findMany, findFirst };
  }

  it('hands the client both dates, the reason and the count — and no relation noise', async () => {
    const { service } = harness([dbRow()]);

    const { rows } = await service.findAll({ closed: false } as never);

    expect(rows[0]).toMatchObject({
      // Untouched by any of the moves the row also reports.
      createdAt: CREATED,
      assignedAt: SCHEDULED,
      assignmentType: 'carry_forward',
      carriedForwardCount: 3,
    });
    // The relations themselves are dropped: the client renders a date and a
    // reason, and shipping the rows would put the module back to reconstructing
    // scheduling state in the browser.
    expect(rows[0]).not.toHaveProperty('assignments');
    expect(rows[0]).not.toHaveProperty('_count');
  });

  it('reports an unassigned lead as scheduled for nothing rather than guessing', async () => {
    // No active assignment — an unassigned lead, or one assigned by a route
    // that predates the history table. Its created date is still exact.
    const { service } = harness([dbRow({ assignments: [], _count: { assignments: 0 } })]);

    const { rows } = await service.findAll({ closed: false } as never);

    expect(rows[0]).toMatchObject({
      createdAt: CREATED,
      assignedAt: null,
      assignmentType: null,
      carriedForwardCount: 0,
    });
  });

  it('counts only carry-forwards, not every assignment the lead ever had', async () => {
    // The count is labelled "times moved to the next day" in the grid and in
    // the export. An unfiltered relation count would put every new assignment
    // and every handover into that number, and it would read as movement that
    // never happened.
    const { service, findMany } = harness([]);

    await service.findAll({ closed: false } as never);

    const select = (findMany.mock.calls[0][0] as { select: Record<string, never> }).select;
    expect(select._count).toEqual({ select: { assignments: { where: { type: 'carry_forward' } } } });
    // And the active row is the one read for the date, newest first.
    expect(select.assignments).toMatchObject({
      where: { isActive: true },
      orderBy: { assignedAt: 'desc' },
      take: 1,
      select: { assignedAt: true, type: true },
    });
  });

  it('exposes the same pair on a single lead, so its own page agrees with the grid', async () => {
    const { service } = harness([dbRow({ assignedToId: null, closedById: null })]);

    const lead = await service.findOne('lead-1');

    expect(lead).toMatchObject({
      createdAt: CREATED,
      assignedAt: SCHEDULED,
      assignmentType: 'carry_forward',
      carriedForwardCount: 3,
    });
    expect(lead).not.toHaveProperty('assignments');
    expect(lead).not.toHaveProperty('_count');
  });
});

/**
 * An imported back catalogue keeps its own creation dates.
 *
 * Lead Management leans hard on Created Date & Time being the moment the lead
 * really arrived — it is the column that tells a lead carried forward for a
 * fortnight apart from one raised this morning. Import a year of history with
 * every row stamped at the minute the file was uploaded and that column says
 * nothing about any of them.
 *
 * The template offered a "Created Date" column the whole time. It was collected
 * by the browser, sent on every row, and silently dropped: `createdAt` was not
 * on the DTO, and `rows` is not validated per-item, so nothing rejected it and
 * nothing wrote it either.
 */
describe('LeadsService — the creation date a lead arrives with', () => {
  function harness() {
    const create = jest.fn(async (args: { data: Record<string, unknown> }) => ({
      id: 'lead-1',
      leadId: 'L-2026-1',
      status: 'new',
      ...args.data,
    }));
    const prisma = {
      lead: { create, findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      $transaction: jest.fn(async (fn: unknown) => (typeof fn === 'function' ? (fn as (p: unknown) => unknown)({ lead: { create } }) : fn)),
    } as unknown as PrismaService;
    // `createLead` delegates to LeadIdService, which allocates the next id and
    // performs the insert. Standing in for it here keeps the built data visible.
    const leadIds = {
      create: jest.fn(async (buildData: (id: string) => Record<string, unknown>, explicitId?: string) =>
        create({ data: buildData(explicitId ?? 'L-2026-1') }),
      ),
    } as unknown as LeadIdService;
    const service = new LeadsService(prisma, {} as NotificationsService, leadIds);
    return { service, create };
  }

  /** `originalCreatedAt` is the whole decision; reached directly. */
  const resolve = (createdAt?: string, timezone?: string) => {
    const { service } = harness();
    const fn = (service as unknown as {
      originalCreatedAt: (d: Record<string, unknown>) => { createdAt?: Date };
    }).originalCreatedAt;
    return fn.call(service, { createdAt, timezone });
  };

  it('leaves the column to the database when the sheet gives no date', () => {
    // The ordinary case, and every lead typed into the New Lead form: the key is
    // absent entirely, so `@default(now())` decides.
    expect(resolve(undefined)).toEqual({});
    expect(resolve('')).toEqual({});
    expect(resolve('   ')).toEqual({});
  });

  it('reads a bare date as midnight on the LEAD\'s clock, not UTC', () => {
    // The case that made this worth writing a helper for. Parsed as UTC, a bare
    // `2026-07-01` against a Pacific lead lands at 17:00 on 30 June local — and
    // Lead Management, which now dates leads on their own zone, would show the
    // whole imported file one day early.
    const { createdAt } = resolve('2026-07-01', 'PST');
    expect(createdAt).toBeInstanceOf(Date);
    // Midnight Pacific on 1 July is 07:00 UTC (PDT, UTC-7).
    expect(createdAt!.toISOString()).toBe('2026-07-01T07:00:00.000Z');

    // Same date, Eastern lead: midnight EDT is 04:00 UTC.
    expect(resolve('2026-07-01', 'EST').createdAt!.toISOString()).toBe('2026-07-01T04:00:00.000Z');
  });

  it('keeps the hour when the sheet gives one', () => {
    // 09:30 against an EST lead means half past nine in New York (13:30 UTC in
    // July), not half past nine wherever the server happens to run.
    expect(resolve('2026-07-01 09:30', 'EST').createdAt!.toISOString()).toBe('2026-07-01T13:30:00.000Z');
    expect(resolve('2026-07-01T09:30', 'EST').createdAt!.toISOString()).toBe('2026-07-01T13:30:00.000Z');
  });

  it('follows daylight time rather than a fixed offset', () => {
    // January is EST (UTC-5); July is EDT (UTC-4). A tabulated offset would put
    // every winter import an hour out.
    expect(resolve('2026-01-15 09:30', 'EST').createdAt!.toISOString()).toBe('2026-01-15T14:30:00.000Z');
  });

  it('falls back to now() on a date it cannot read, rather than failing the row', () => {
    // The row still carries a company and a phone number. Losing the lead over a
    // malformed date column protects nothing — and the result is exactly what
    // the file not having the column at all would have given.
    expect(resolve('not a date')).toEqual({});
    expect(resolve('31/07/2026')).toEqual({});
  });

  it('applies the date when a lead is created', async () => {
    const { service, create } = harness();

    await service.create({
      businessName: 'Acme Tax LLC',
      phone: '3055551234',
      state: 'FL',
      city: 'Miami',
      timezone: 'EST',
      createdAt: '2026-07-01',
    } as never);

    const data = create.mock.calls[0][0].data;
    expect(data.createdAt).toBeInstanceOf(Date);
    expect((data.createdAt as Date).toISOString()).toBe('2026-07-01T04:00:00.000Z');
  });

  it('omits the column entirely for a lead created without one', async () => {
    // Not `createdAt: undefined` — the key must be absent, so the database
    // default is what fills it.
    const { service, create } = harness();

    await service.create({ businessName: 'Bare Co', phone: '3055550000', state: 'FL', city: 'Miami' } as never);

    expect(create.mock.calls[0][0].data).not.toHaveProperty('createdAt');
  });
});
