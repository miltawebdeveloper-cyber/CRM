import { describe, expect, it, jest } from '@jest/globals';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LeadsService } from './leads.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { LeadIdService } from './lead-id.service.js';

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
    // Whole BUSINESS days (BUSINESS_TIMEZONE, Eastern by default — EDT in
    // August, so a day runs 04:00Z to 03:59:59.999Z the next morning), not UTC
    // days and not the server's.
    expect(where.createdAt).toEqual({
      gte: new Date('2026-08-01T04:00:00.000Z'),
      // The end of the closing day, not its midnight — a single-day filter has
      // to span the day, or "14 August" matches only leads created at 00:00:00.
      lte: new Date('2026-08-15T03:59:59.999Z'),
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
        assignedAt: { gte: new Date('2026-08-14T04:00:00.000Z'), lte: new Date('2026-08-15T03:59:59.999Z') },
      },
    });
    expect(where).not.toHaveProperty('createdAt');
  });

  it('accepts an open-ended range on either date', async () => {
    const { service, findMany } = harness();
    await service.findAll({ closed: false, createdFrom: '2026-08-01' } as never);
    expect(whereOf(findMany).createdAt).toEqual({ gte: new Date('2026-08-01T04:00:00.000Z') });

    const scheduled = harness();
    await scheduled.service.findAll({ closed: false, createdTo: '2026-08-14', dateField: 'scheduled' } as never);
    expect(whereOf(scheduled.findMany).assignments).toEqual({
      some: { isActive: true, assignedAt: { lte: new Date('2026-08-15T03:59:59.999Z') } },
    });
  });
});

describe('LeadsService.findAll — the country filter', () => {
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

  const whereOf = (findMany: ReturnType<typeof jest.fn>) =>
    (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;

  it('applies no country filter when none is given', async () => {
    const { service, findMany } = harness();
    await service.findAll({ closed: false } as never);
    expect(whereOf(findMany)).not.toHaveProperty('country');
  });

  it('filters on the exact country when given, alongside city', async () => {
    const { service, findMany } = harness();
    await service.findAll({ closed: false, city: 'Austin', country: 'United States' } as never);
    const where = whereOf(findMany);
    expect(where.country).toBe('United States');
    expect(where.city).toBe('Austin');
  });
});

describe('LeadsService.filterOptions — distinct countries', () => {
  it('returns distinct, non-empty country values alongside the existing lists', async () => {
    const groupBy = jest.fn(async ({ by }: { by: string[] }) => {
      if (by[0] === 'timezone') return [{ timezone: 'America/New_York' }];
      if (by[0] === 'state') return [{ state: 'TX' }];
      if (by[0] === 'city') return [{ city: 'Austin' }];
      if (by[0] === 'country') return [{ country: 'United States' }, { country: null }];
      return [];
    });
    const prisma = { lead: { groupBy }, user: { findMany: jest.fn(async () => []) } } as unknown as PrismaService;
    const service = new LeadsService(prisma, {} as NotificationsService, {} as LeadIdService);

    const result = await service.filterOptions({ closed: false } as never);

    expect(result.countries).toEqual(['United States']);
    const countryCall = groupBy.mock.calls.find((c) => (c[0] as { by: string[] }).by[0] === 'country');
    expect(countryCall?.[0]).toMatchObject({ by: ['country'] });
  });

  it('cascades Country -> Time Zone -> State -> City, never upward', async () => {
    type Args = { by: string[]; where: Record<string, unknown> };
    const groupBy = jest.fn(async (_args: Args) => [] as unknown[]);
    const prisma = { lead: { groupBy }, user: { findMany: jest.fn(async () => []) } } as unknown as PrismaService;
    const service = new LeadsService(prisma, {} as NotificationsService, {} as LeadIdService);

    await service.filterOptions({ closed: false, country: 'USA', timezone: 'EST', state: 'Florida' } as never);

    const whereFor = (field: string) => groupBy.mock.calls.find((c) => c[0].by[0] === field)![0].where;
    expect(whereFor('country')).not.toHaveProperty('country');
    expect(whereFor('country')).not.toHaveProperty('timezone');
    expect(whereFor('timezone')).toMatchObject({ country: 'USA' });
    expect(whereFor('timezone')).not.toHaveProperty('timezone');
    expect(whereFor('state')).toMatchObject({ country: 'USA', timezone: 'EST' });
    expect(whereFor('state')).not.toHaveProperty('state');
    expect(whereFor('city')).toMatchObject({ country: 'USA', timezone: 'EST', state: 'Florida' });
  });
});

describe('LeadsService — country/time zone pairing', () => {
  const service = () => new LeadsService({} as PrismaService, {} as NotificationsService, {} as LeadIdService);

  it('refuses a new lead whose zone belongs to another country', async () => {
    await expect(service().create({ businessName: 'X', phone: '1', country: 'India', timezone: 'EST' } as never)).rejects.toThrow(
      'EST is not a time zone in India',
    );
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

/**
 * The Status filter used to be overwritten by the module split: `status:
 * query.status` was spread first and `status: { not: closed }` second, so
 * picking "Contacted" on either lead list returned every open lead.
 */
describe('LeadsService.findAll — the Status filter survives the module split', () => {
  function harness() {
    const findMany = jest.fn(async (_a: unknown) => []);
    const count = jest.fn(async (_a: unknown) => 0);
    const prisma = {
      lead: { findMany, count },
      $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
    } as unknown as PrismaService;
    return { service: new LeadsService(prisma, {} as NotificationsService, {} as LeadIdService), findMany };
  }
  const whereOf = (findMany: ReturnType<typeof jest.fn>) =>
    (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;

  it('keeps both the chosen status and the open-leads constraint', async () => {
    const { service, findMany } = harness();
    await service.findAll({ closed: false, status: 'contacted' } as never);
    const where = whereOf(findMany);
    expect(where.status).toEqual({ not: 'closed' });
    expect(where.AND).toEqual([{ status: 'contacted' }]);
  });

  it('leaves the open-leads constraint as it was when no status is picked', async () => {
    const { service, findMany } = harness();
    await service.findAll({ closed: false } as never);
    const where = whereOf(findMany);
    expect(where.status).toEqual({ not: 'closed' });
    expect(where).not.toHaveProperty('AND');
  });
});

/**
 * The cards above Lead Library / Lead Management count the grid's own set.
 */
describe('LeadsService.listSummary — the cards follow the grid', () => {
  function harness(counts: [number, number, number]) {
    const queue = [...counts];
    const count = jest.fn(async (_a: unknown) => queue.shift() ?? 0);
    const prisma = {
      lead: { count },
      $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
    } as unknown as PrismaService;
    return { service: new LeadsService(prisma, {} as NotificationsService, {} as LeadIdService), count };
  }
  const whereAt = (count: ReturnType<typeof jest.fn>, i: number) =>
    (count.mock.calls[i][0] as { where: Record<string, unknown> }).where;

  it('derives Balance and Progress from Assigned and Contacted', async () => {
    const { service } = harness([120, 80, 20]);
    const s = await service.listSummary({ closed: false } as never, { id: 'admin-1', role: 'admin' } as never);
    expect(s).toMatchObject({ totalLeads: 120, assignedLeads: 80, contactedLeads: 20, balanceLeads: 60, progressPct: 25 });
  });

  it('applies the grid filters to every card', async () => {
    const { service, count } = harness([0, 0, 0]);
    await service.listSummary({ closed: false, state: 'TX', city: 'Austin' } as never, { id: 'admin-1', role: 'admin' } as never);
    const total = whereAt(count, 0);
    expect(total.state).toBe('TX');
    expect(total.city).toBe('Austin');
    // Assigned and Contacted wrap the very same clause rather than rebuilding it.
    expect((whereAt(count, 1).AND as unknown[])[0]).toBe(total);
  });

  it("never widens an employee's cards past their own leads", async () => {
    const { service, count } = harness([0, 0, 0]);
    await service.listSummary({ closed: false } as never, { id: 'emp-1', role: 'employee' } as never);
    const total = whereAt(count, 0);
    expect(total.assignedToId).toBe('emp-1');
    // ANDed, not spread — a spread `assignedToId: { not: null }` would replace it.
    expect(whereAt(count, 1).AND).toEqual([total, { assignedToId: { not: null } }]);
  });
});

/**
 * The quick filters — Follow-up today / Overdue, Contacted / Never contacted —
 * and the multi-pick outcome filter.
 */
describe('LeadsService.findAll — quick filters', () => {
  function harness(outcomes: Array<{ slug: string; name: string }> = []) {
    const findMany = jest.fn(async (_a: unknown) => []);
    const count = jest.fn(async (_a: unknown) => 0);
    const outcomeFind = jest.fn(async (a: { where: { OR: [{ slug: string }] } }) =>
      outcomes.find((o) => o.slug === a.where.OR[0].slug) ?? null,
    );
    const prisma = {
      lead: { findMany, count },
      outcome: { findFirst: outcomeFind },
      $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
    } as unknown as PrismaService;
    return { service: new LeadsService(prisma, {} as NotificationsService, {} as LeadIdService), findMany };
  }
  const whereOf = (findMany: ReturnType<typeof jest.fn>) =>
    (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
  const andOf = (findMany: ReturnType<typeof jest.fn>) => (whereOf(findMany).AND ?? []) as Array<Record<string, unknown>>;

  it('Overdue means more than the callbacks grace period past the Next Follow-up', async () => {
    const { service, findMany } = harness();
    const before = Date.now();
    await service.findAll({ closed: false, followUp: 'overdue' } as never);
    const clause = andOf(findMany)[0] as { nextFollowUpDate: { lt: Date } };
    const cutoff = clause.nextFollowUpDate.lt.getTime();
    expect(cutoff).toBeLessThanOrEqual(before - 60 * 60 * 1000 + 50);
    expect(cutoff).toBeGreaterThan(before - 60 * 60 * 1000 - 5000);
  });

  it("Follow-up today is measured on each lead's own day, zone-less leads included", async () => {
    const { service, findMany } = harness();
    await service.findAll({ closed: false, followUp: 'today' } as never);
    const branches = (andOf(findMany)[0] as { OR: Array<Record<string, unknown>> }).OR;
    // One branch per zone, plus the fallback for no zone / an unknown zone.
    const est = branches.find((b) => b.timezone === 'EST') as { nextFollowUpDate: { gte: Date; lt: Date } };
    expect(est).toBeDefined();
    const span = est.nextFollowUpDate.lt.getTime() - est.nextFollowUpDate.gte.getTime();
    expect([23, 24, 25].map((h) => h * 3600_000)).toContain(span);
    const fallback = branches[branches.length - 1] as { OR: unknown[] };
    expect(fallback.OR).toEqual(expect.arrayContaining([{ timezone: null }]));
  });

  it('Never contacted is the exact complement of the Contacted card', async () => {
    const { service, findMany } = harness();
    await service.findAll({ closed: false, contact: 'never' } as never);
    const clause = andOf(findMany)[0] as { NOT: { OR: unknown[] } };
    expect(clause.NOT.OR).toHaveLength(2);
  });

  it('keeps the search and a quick filter both in force', async () => {
    const { service, findMany } = harness();
    await service.findAll({ closed: false, q: 'acme', contact: 'contacted' } as never);
    const where = whereOf(findMany);
    // The search is an OR on the top level; the contacted OR sits in AND.
    expect(where.OR).toBeDefined();
    expect((andOf(findMany)[0] as { OR: unknown[] }).OR).toHaveLength(2);
  });

  it('matches any of several outcomes, each with its legacy display name', async () => {
    const { service, findMany } = harness([
      { slug: 'no_answer', name: 'No Answer' },
      { slug: 'busy', name: 'Busy' },
    ]);
    await service.findAll({ closed: false, callStatus: 'no_answer, busy' } as never);
    const filter = whereOf(findMany).callStatus as { in: string[] };
    expect(filter.in.sort()).toEqual(['Busy', 'No Answer', 'busy', 'no_answer']);
  });
});

/** The numbers on the quick-filter chips. */
describe('LeadsService.listSummary — chip counts', () => {
  function harness() {
    const count = jest.fn(async (_a: unknown) => 0);
    const prisma = {
      lead: { count },
      $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
    } as unknown as PrismaService;
    return { service: new LeadsService(prisma, {} as NotificationsService, {} as LeadIdService), count };
  }
  const andAt = (count: ReturnType<typeof jest.fn>, i: number) =>
    (count.mock.calls[i][0] as { where: { AND: Array<Record<string, unknown>> } }).where.AND;

  it("counts each chip with the other group's filter in force, not its own", async () => {
    const { service, count } = harness();
    const admin = { id: 'a', role: 'admin' } as never;
    const s = await service.listSummary({ closed: false, contact: 'never', followUp: 'today' } as never, admin);
    expect(s.chips).toEqual({ followUpToday: 0, followUpOverdue: 0, neverContacted: 0, contacted: 0 });

    // The base the chips build on carries neither quick filter.
    const base = andAt(count, 3)[0] as { AND?: Array<Record<string, unknown>> };
    expect(JSON.stringify(base)).not.toContain('nextFollowUpDate');
    expect(JSON.stringify(base)).not.toContain('NOT');
    // Overdue (call 4): its own follow-up clause, plus the active "never contacted".
    const overdue = andAt(count, 4);
    expect(overdue[1]).toHaveProperty('nextFollowUpDate');
    expect(overdue[2]).toHaveProperty('NOT');
    // Contacted (call 6): the active "today" follow-up, plus its own contact clause.
    const contacted = andAt(count, 6);
    expect(contacted[1]).toHaveProperty('OR');
    expect(contacted[2]).not.toHaveProperty('NOT');
  });
});

/** Dates typed into the New Lead form are on the lead's clock. */
describe('LeadsService.create — contact dates on the lead\'s clock', () => {
  it('reads a bare date-and-time in the lead\'s zone, and a bare date as its midnight', async () => {
    const create = jest.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'lead-1', leadId: 'L-2026-1', status: 'new', ...args.data }));
    const prisma = {
      lead: { create, findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    } as unknown as PrismaService;
    const leadIds = {
      create: jest.fn(async (build: (id: string) => Record<string, unknown>) => create({ data: build('L-2026-1') })),
    } as unknown as LeadIdService;
    const service = new LeadsService(prisma, {} as NotificationsService, leadIds);

    await service.create({
      businessName: 'Acme', phone: '3055550100', state: 'FL', city: 'Miami', timezone: 'EST', allowDuplicate: true,
      nextFollowUpDate: '2026-11-20T14:30', meetingDate: '2026-11-21', firstContact: '2026-11-19T09:00:00.000Z',
    } as never);
    const data = create.mock.calls[0][0].data as Record<string, Date>;
    // 2:30 pm Eastern in November (UTC-5) is 19:30 UTC.
    expect(data.nextFollowUpDate.toISOString()).toBe('2026-11-20T19:30:00.000Z');
    expect(data.meetingDate.toISOString()).toBe('2026-11-21T05:00:00.000Z');
    // A value with its own offset is taken as given.
    expect(data.firstContact.toISOString()).toBe('2026-11-19T09:00:00.000Z');
  });
});

/**
 * Editing Next Follow-up on the lead's page books, moves or cancels the
 * callback with it, on the lead's clock — and the other dates are read on that
 * clock too.
 */
describe('LeadsService.update — follow-up edits move the callback', () => {
  const FUTURE = new Date(Date.now() + 3 * 24 * 3600_000);
  const day = FUTURE.toISOString().slice(0, 10);

  function harness(overrides: Record<string, unknown> = {}, openRung: { id: string } | null = { id: 'rung-2' }) {
    const LEAD = {
      id: 'lead-1', leadId: 'L-2026-1', comments: null, assignedToId: 'user-1', assignedTo: { id: 'user-1', name: 'Ann' },
      status: 'new', timezone: 'EST', nextFollowUpDate: null, callbackAt: null, firstContact: null, ...overrides,
    };
    const leadUpdate = jest.fn(async (a: { data: Record<string, unknown> }) => ({ ...LEAD, ...a.data }));
    const rungFind = jest.fn(async (a: { where: { completedAt?: null } }) => ('completedAt' in a.where ? openRung : { seq: 4 }));
    const rungUpdate = jest.fn(async (_a: unknown) => ({}));
    const rungCreate = jest.fn(async (_a: unknown) => ({}));
    const rungDelete = jest.fn(async (_a: unknown) => ({}));
    const activityCreate = jest.fn(async (_a: unknown) => ({}));
    const prisma = {
      lead: { findFirst: jest.fn(async () => LEAD), update: leadUpdate, findUnique: jest.fn(async () => ({ callStatus: null, assignedToId: 'user-1' })) },
      leadFollowup: { findFirst: rungFind, update: rungUpdate, create: rungCreate, delete: rungDelete },
      note: { create: jest.fn(async () => ({})) },
      activity: { create: activityCreate },
      $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
    } as unknown as PrismaService;
    return { service: new LeadsService(prisma, {} as NotificationsService, {} as LeadIdService), leadUpdate, rungUpdate, rungCreate, rungDelete, activityCreate };
  }
  const ADMIN = { id: 'mgr-1', role: 'admin' } as never;
  const dataOf = (fn: ReturnType<typeof jest.fn>) => (fn.mock.calls[0][0] as { data: Record<string, unknown> }).data;

  it('books the callback at the same instant, on the lead\'s clock, and moves the open rung', async () => {
    const h = harness();
    await h.service.update('lead-1', { nextFollowUpDate: `${day}T14:30` } as never, ADMIN);
    const data = dataOf(h.leadUpdate);
    const at = data.nextFollowUpDate as Date;
    // Eastern is UTC-5 or UTC-4 depending on the date; either way 14:30 there is 18:30 or 19:30 UTC.
    expect(['18:30', '19:30']).toContain(at.toISOString().slice(11, 16));
    expect(data.callbackAt).toEqual(at);
    expect(data.callbackCompletedAt).toBeNull();
    expect(data.callbackDismissedAt).toBeNull();
    expect(h.rungUpdate).toHaveBeenCalledWith({ where: { id: 'rung-2' }, data: { scheduledAt: at, assignedToId: 'user-1' } });
    expect(h.activityCreate.mock.calls.some((c) => (c[0] as { data: { action: string } }).data.action === 'callback_scheduled')).toBe(true);
  });

  it('opens the next rung when none is open', async () => {
    const h = harness({}, null);
    await h.service.update('lead-1', { nextFollowUpDate: `${day}T09:00` } as never, ADMIN);
    expect(h.rungCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ leadId: 'lead-1', seq: 5, assignedToId: 'user-1' }) });
  });

  it('cancels the callback, and drops the never-worked open rung, when the follow-up is cleared', async () => {
    const h = harness({ nextFollowUpDate: FUTURE, callbackAt: FUTURE });
    await h.service.update('lead-1', { nextFollowUpDate: '' } as never, ADMIN);
    const data = dataOf(h.leadUpdate);
    expect(data.nextFollowUpDate).toBeNull();
    expect(data.callbackAt).toBeNull();
    expect(h.rungDelete).toHaveBeenCalledWith({ where: { id: 'rung-2' } });
  });

  it('refuses a new follow-up that has already passed, or on a lead with no zone', async () => {
    await expect(harness().service.update('lead-1', { nextFollowUpDate: '2020-01-01T09:00' } as never, ADMIN)).rejects.toThrow(/already passed/);
    await expect(harness({ timezone: null }).service.update('lead-1', { nextFollowUpDate: `${day}T09:00` } as never, ADMIN)).rejects.toThrow(/no time zone/);
  });

  it('never refuses the stored time sent back unchanged, even once it is past', async () => {
    const past = new Date('2020-01-01T14:00:00.000Z');
    const h = harness({ nextFollowUpDate: past, callbackAt: past });
    await h.service.update('lead-1', { nextFollowUpDate: past.toISOString() } as never, ADMIN);
    expect(h.leadUpdate).not.toHaveBeenCalled();
  });

  it('reads the other dates on the lead\'s clock too', async () => {
    const h = harness();
    await h.service.update('lead-1', { firstContact: '2026-11-19T09:00' } as never, ADMIN);
    // 9 am Eastern on 19 November (UTC-5).
    expect((dataOf(h.leadUpdate).firstContact as Date).toISOString()).toBe('2026-11-19T14:00:00.000Z');
    expect(h.rungUpdate).not.toHaveBeenCalled();
  });
});

/** Recently deleted: archive and restore are logged per lead, the list reads
 *  archived rows only, and permanent delete can't reach a live lead. */
describe('LeadsService — Recently deleted', () => {
  const MGR = { id: 'mgr-1', role: 'admin' } as never;

  function harness(leads: Array<{ id: string; leadId: string }> = [{ id: 'l1', leadId: 'L-2026-1' }, { id: 'l2', leadId: 'L-2026-2' }]) {
    const findMany = jest.fn(async (_a: unknown) => leads);
    const createMany = jest.fn(async (_a: unknown) => ({ count: leads.length }));
    const tx = {
      lead: { updateMany: jest.fn(async () => ({ count: leads.length })), deleteMany: jest.fn(async () => ({ count: leads.length })) },
      activity: { create: jest.fn(async () => ({})), createMany },
      workReassignment: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    };
    const prisma = {
      lead: { findMany, count: jest.fn(async () => leads.length) },
      activity: { createMany, findMany: jest.fn(async () => [
        { leadId: 'l1', user: { name: 'Ann (latest)' } },
        { leadId: 'l1', user: { name: 'Bob (older)' } },
      ]) },
      $transaction: jest.fn(async (arg: unknown) =>
        typeof arg === 'function' ? (arg as (t: typeof tx) => Promise<unknown>)(tx) : Promise.all(arg as Promise<unknown>[]),
      ),
    } as unknown as PrismaService;
    return { service: new LeadsService(prisma, {} as NotificationsService, {} as LeadIdService), findMany, createMany };
  }
  const whereOf = (fn: ReturnType<typeof jest.fn>, i = 0) => (fn.mock.calls[i][0] as { where: Record<string, unknown> }).where;

  it('logs an archive against each lead, so "deleted by" can be shown', async () => {
    const h = harness();
    await h.service.archiveMany(['l1', 'l2'], MGR);
    const rows = (h.createMany.mock.calls[0][0] as { data: Array<{ leadId: string; action: string }> }).data;
    expect(rows.map((r) => [r.leadId, r.action])).toEqual([['l1', 'lead_archived'], ['l2', 'lead_archived']]);
  });

  it('logs a restore against each lead too', async () => {
    const h = harness();
    await h.service.restoreMany(['l1', 'l2'], MGR);
    const rows = (h.createMany.mock.calls[0][0] as { data: Array<{ action: string }> }).data;
    expect(rows.every((r) => r.action === 'lead_restored')).toBe(true);
  });

  it('lists archived leads only, newest deletion first, with who deleted them', async () => {
    const h = harness([{ id: 'l1', leadId: 'L-2026-1' }]);
    const res = await h.service.listArchived({ q: 'acme' } as never);
    const where = whereOf(h.findMany);
    expect(where.deletedAt).toEqual({ not: null });
    expect(where.OR).toBeDefined();
    expect((h.findMany.mock.calls[0][0] as { orderBy: unknown[] }).orderBy[0]).toEqual({ deletedAt: 'desc' });
    expect(res.rows[0].deletedBy).toBe('Ann (latest)');
  });

  it("permanent delete from Recently deleted reaches archived rows only; the original delete, live rows only", async () => {
    const h = harness();
    await h.service.removeMany(['l1'], MGR, { archived: true });
    expect(whereOf(h.findMany, 0).deletedAt).toEqual({ not: null });
    await h.service.removeMany(['l1'], MGR);
    expect(whereOf(h.findMany, 1).deletedAt).toBeNull();
  });
});

/** The Employee filter, open to team leaders as well as admins. */
describe('LeadsService — the Employee filter for managers', () => {
  function harness() {
    const findMany = jest.fn(async (_a: unknown) => []);
    const userFind = jest.fn(async (_a: unknown) => [{ id: 'u-ann', name: 'Ann' }]);
    const prisma = {
      lead: { findMany, count: jest.fn(async () => 0), groupBy: jest.fn(async () => []) },
      user: { findMany: userFind },
      $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
    } as unknown as PrismaService;
    return { service: new LeadsService(prisma, {} as NotificationsService, {} as LeadIdService), findMany, userFind };
  }
  const whereOf = (fn: ReturnType<typeof jest.fn>) => (fn.mock.calls[0][0] as { where: Record<string, unknown> }).where;

  it("narrows a team leader's list to one employee", async () => {
    const h = harness();
    await h.service.findAll({ closed: false, employeeId: 'u-ann' } as never, { id: 'tl-1', role: 'team_leader' } as never);
    expect(whereOf(h.findMany).assignedToId).toBe('u-ann');
  });

  it("is ignored for an employee, who stays pinned to their own leads", async () => {
    const h = harness();
    await h.service.findAll({ closed: false, employeeId: 'u-ann' } as never, { id: 'emp-1', role: 'employee' } as never);
    expect(whereOf(h.findMany).assignedToId).toBe('emp-1');
  });

  it('offers managers the people who hold leads in the list, and employees nobody', async () => {
    const h = harness();
    const forTl = await h.service.filterOptions({ closed: false } as never, { id: 'tl-1', role: 'team_leader' } as never);
    expect(forTl.owners).toEqual([{ id: 'u-ann', name: 'Ann' }]);
    expect(JSON.stringify(h.userFind.mock.calls[0][0])).toContain('assignedLeads');

    const forRep = await harness().service.filterOptions({ closed: false } as never, { id: 'emp-1', role: 'employee' } as never);
    expect(forRep.owners).toEqual([]);
  });
});
