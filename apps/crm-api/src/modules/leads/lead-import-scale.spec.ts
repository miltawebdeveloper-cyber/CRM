import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { LeadIdService, leadIdYear, type LeadIdRun } from './lead-id.service.js';
import { LeadsService } from './leads.service.js';

/**
 * A big import used to slow down in proportion to the lead book, because every
 * row paid two full scans of the leads table — one to work out the next Lead
 * ID, one to look for an existing lead by phone — and then a transaction of its
 * own. 50,000 rows took most of an hour. These pin what made it scale: the run
 * numbers its leads from one read of the sequence, writes them a thousand to an
 * INSERT, and asks the database nothing per row that the file-wide duplicate
 * analysis already answered.
 */
describe('LeadIdService.createManyInRun — a batch per insert, one read of the sequence per run', () => {
  const year = leadIdYear();

  function harness(maxSeq: number[], failFirstInsertWith?: string) {
    let reads = 0;
    let inserts = 0;
    const tx = {
      $executeRaw: jest.fn(async () => 1),
      $queryRaw: jest.fn(async () => [{ max_seq: maxSeq[Math.min(reads++, maxSeq.length - 1)] }]),
      lead: {
        createManyAndReturn: jest.fn(async ({ data }: { data: Array<{ leadId: string }> }) => {
          if (failFirstInsertWith && inserts++ === 0) {
            throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on lead_id', { code: failFirstInsertWith, clientVersion: 'test' });
          }
          // Returned in reverse, to prove the result is matched back by Lead ID.
          return [...data].reverse().map((d) => ({ id: `id-${d.leadId}`, leadId: d.leadId, status: 'new', callStatus: null, assignedToId: null }));
        }),
      },
    };
    const prisma = { $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } as unknown as PrismaService;
    return { service: new LeadIdService(prisma), tx, reads: () => reads };
  }
  const item = (leadId?: string) => ({ build: (id: string) => ({ leadId: id, businessName: '', phone: '', state: '', city: '' }), leadId });

  it('numbers a batch in order from one read, in one insert, and carries on from there', async () => {
    const h = harness([41]);
    const run: LeadIdRun = {};
    const first = await h.service.createManyInRun([item(), item(), item()], run);
    const second = await h.service.createManyInRun([item()], run);
    expect(first.map((l) => l.leadId)).toEqual([`L-${year}-42`, `L-${year}-43`, `L-${year}-44`]);
    expect(second.map((l) => l.leadId)).toEqual([`L-${year}-45`]);
    expect(h.reads()).toBe(1);
    expect(h.tx.lead.createManyAndReturn).toHaveBeenCalledTimes(2);
    // Each batch still holds the advisory lock that serialises numbering.
    expect(h.tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('re-reads the sequence when something else took the next number', async () => {
    const h = harness([41, 60], 'P2002');
    const run: LeadIdRun = {};
    const [lead] = await h.service.createManyInRun([item()], run);
    expect(lead.leadId).toBe(`L-${year}-61`);
    expect(run.next).toBe(62);
  });

  it('keeps a Lead ID the sheet supplied, without spending a number on it', async () => {
    const h = harness([41]);
    const run: LeadIdRun = {};
    const leads = await h.service.createManyInRun([item('L-99001'), item()], run);
    expect(leads.map((l) => l.leadId)).toEqual(['L-99001', `L-${year}-42`]);
    expect(run.next).toBe(43);
  });
});

describe('LeadsService.bulkImport — batched writes, nothing asked per row that the analysis answered', () => {
  const existing = {
    id: 'lead-existing', leadId: 'L-2026-7', businessName: 'Harbor Tax', phone: '3055551234', altPhone: null, email: null,
    website: null, createdAt: new Date('2026-01-01'), assignedToId: null, assignedTo: null, leadGenerationId: null, leadSource: null,
    contactName: null, contactName2: null, socialMedia: null, country: 'USA', state: 'FL', city: 'Miami', timezone: 'EST', industry: null,
    companySize: null, foundedYear: null, address: null, callStatus: null, lostReason: null, status: 'new', deletedAt: null,
  };

  function harness(opts: { archivedLeadIds?: string[] } = {}) {
    const leadFindFirst = jest.fn(async () => null);
    const activityCreateMany = jest.fn(async (_a: { data: unknown[] }) => ({ count: 0 }));
    const activityCreate = jest.fn(async () => ({}));
    const leadUpdate = jest.fn(async ({ where }: { where: { id: string } }) => ({ ...existing, id: where.id }));
    const prisma = {
      country: { findMany: jest.fn(async () => [{ code: 'USA', defaultTimezone: 'EST' }]) },
      lead: {
        findMany: jest.fn(async (args: { cursor?: unknown; where?: { deletedAt?: unknown } }) => {
          // The archived-Lead-ID lookup.
          if (args.where?.deletedAt) return (opts.archivedLeadIds ?? []).map((leadId) => ({ leadId }));
          // The analysis pages through the book; one page holds it all here.
          return args.cursor ? [] : [existing];
        }),
        findFirst: leadFindFirst,
        findUnique: jest.fn(async () => ({ callStatus: null, assignedToId: null })),
        update: leadUpdate,
      },
      activity: { create: activityCreate, createMany: activityCreateMany },
      assignment: { createMany: jest.fn(async () => ({ count: 0 })) },
      importDuplicateDecision: { upsert: jest.fn() },
      $executeRaw: jest.fn(async () => 1),
      $transaction: jest.fn(async () => []),
    } as unknown as PrismaService;
    let n = 0;
    const runs = new Set<LeadIdRun>();
    const leadIds = {
      createManyInRun: jest.fn(async (items: Array<{ build: (id: string) => Prisma.LeadCreateManyInput; leadId?: string }>, run: LeadIdRun) => {
        runs.add(run);
        return items.map((it) => {
          const leadId = it.leadId ?? `L-2026-${100 + n++}`;
          const data = it.build(leadId);
          return { id: `new-${leadId}`, leadId, status: data.status ?? 'new', callStatus: null, assignedToId: data.assignedToId ?? null };
        });
      }),
    } as unknown as LeadIdService & { createManyInRun: jest.Mock };
    const notifyManagers = jest.fn(async () => undefined);
    const service = new LeadsService(prisma, { notifyManagers } as unknown as NotificationsService, leadIds);
    const batchSizes = () => (leadIds.createManyInRun.mock.calls as unknown as Array<[unknown[]]>).map((c) => c[0].length);
    return { service, leadFindFirst, activityCreateMany, activityCreate, leadUpdate, leadIds, runs, batchSizes };
  }

  it('updates the lead the analysis matched, creates the rest in one batch, and writes the history together', async () => {
    const h = harness();
    const res = await h.service.bulkImport(
      {
        rows: [
          { businessName: 'Harbor Tax', phone: '+1 305 555 1234', state: 'FL', city: 'Miami', country: 'USA' },
          { businessName: 'New One', phone: '0000000001', state: 'TX', city: 'Austin', country: 'USA' },
          { businessName: 'New Two', phone: '0000000002', state: 'TX', city: 'Austin', country: 'USA' },
        ],
      } as never,
      'admin-1',
    );

    expect(res).toMatchObject({ imported: 2, updated: 1, createdIds: ['new-L-2026-100', 'new-L-2026-101'] });
    expect(h.leadUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'lead-existing' } }));
    // No per-row "phone contains …" scan, and no per-row history read + write.
    expect(h.leadFindFirst).not.toHaveBeenCalled();
    expect(h.activityCreate).not.toHaveBeenCalled();
    // Both new leads in one insert, from one numbering run.
    expect(h.batchSizes()).toEqual([2]);
    expect(h.runs.size).toBe(1);
    const logged = h.activityCreateMany.mock.calls.flatMap((c) => c[0].data as Array<{ action: string; leadId: string }>);
    expect(logged.map((l) => [l.action, l.leadId])).toEqual([
      ['lead_updated', 'lead-existing'],
      ['lead_created', 'new-L-2026-100'],
      ['lead_created', 'new-L-2026-101'],
    ]);
  });

  it('writes new leads a thousand at a time', async () => {
    const h = harness();
    const rows = Array.from({ length: 2500 }, (_, i) => ({ businessName: `Co ${i}`, phone: String(9_000_000_000 + i), state: 'TX', city: 'Austin' }));
    const res = await h.service.bulkImport({ rows } as never, 'admin-1');
    expect(res.imported).toBe(2500);
    expect(h.batchSizes()).toEqual([1000, 1000, 500]);
  });

  it('updates, rather than duplicates, a lead created earlier in the same file — even while it is still queued', async () => {
    const h = harness();
    const res = await h.service.bulkImport(
      { rows: [{ businessName: 'Twice Co', phone: '0000000009' }, { businessName: 'Twice Co', phone: '000-000-0009', city: 'Reno' }] } as never,
      'admin-1',
    );
    expect(res).toMatchObject({ imported: 1, updated: 1 });
    // The queued lead was written before the second row looked for it.
    expect(h.batchSizes()).toEqual([1]);
    expect(h.leadUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'new-L-2026-100' } }));
  });

  it('refuses a Lead ID held by an archived lead, from one lookup for the whole file', async () => {
    const h = harness({ archivedLeadIds: ['L-OLD-1'] });
    const res = await h.service.bulkImport(
      { rows: [{ leadId: 'L-OLD-1', businessName: 'Gone Co', phone: '0000000011' }, { leadId: 'L-NEW-1', businessName: 'Fresh Co', phone: '0000000012' }] } as never,
      'admin-1',
    );
    expect(res).toMatchObject({ imported: 1, skipped: 1 });
    expect(res.errors[0].reason).toMatch(/belongs to a deleted lead/);
    expect(h.leadFindFirst).not.toHaveBeenCalled();
    expect(h.batchSizes()).toEqual([1]);
  });
});

/**
 * "Select all" on a lead grid that has loaded only its first pages asks for
 * every matching lead at once. It must be the SAME set the grid is showing —
 * the same filters, the same order — compact, and refused outright rather
 * than quietly cut short when it is too large to hand over.
 */
describe('LeadsService.findAll — selection (Select all)', () => {
  function harness(rowCount: number) {
    const findMany = jest.fn(async (_a: unknown) =>
      Array.from({ length: rowCount }, (_, i) => ({ id: `l${i}`, assignments: [], _count: { assignments: 0 } })),
    );
    const count = jest.fn(async () => rowCount);
    const prisma = {
      lead: { findMany, count },
      $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
    } as unknown as PrismaService;
    return { service: new LeadsService(prisma, {} as NotificationsService, {} as LeadIdService), findMany, count };
  }
  type ReadArgs = { where: Record<string, unknown>; take: number; select: Record<string, unknown>; skip?: number; orderBy: unknown };

  it('returns every match under the grid\'s filters and order, compact, ignoring paging', async () => {
    const h = harness(3);
    const res = await h.service.findAll({ closed: false, state: 'TX', selection: true, page: 4, pageSize: 50 } as never);
    expect(res).toMatchObject({ total: 3, page: 1 });
    const args = h.findMany.mock.calls[0][0] as ReadArgs;
    expect(args.skip).toBeUndefined();
    expect(args.take).toBe(200_001);
    // What the bulk actions read — not the full row.
    expect(Object.keys(args.select).sort()).toEqual(
      ['assignedTo', 'assignedToId', 'businessName', 'city', 'country', 'id', 'leadId', 'state', 'status', 'timezone'].sort(),
    );
    // The same read a page of the grid makes, so the same leads in the same order.
    const page = harness(3);
    await page.service.findAll({ closed: false, state: 'TX' } as never);
    const pageArgs = page.findMany.mock.calls[0][0] as ReadArgs;
    expect(args.where).toEqual(pageArgs.where);
    expect(args.orderBy).toEqual(pageArgs.orderBy);
  });

  it('refuses a selection over the cap instead of returning part of it', async () => {
    const h = harness(200_001);
    await expect(h.service.findAll({ closed: false, selection: true } as never)).rejects.toThrow(/Narrow the filters/);
  });
});

/**
 * L-YYYY-N starts again at 1 every year. "The year" is the business calendar's
 * (BUSINESS_TIMEZONE, Eastern by default), so the switch happens at midnight
 * there — not at the server's midnight, which on a machine in India fell at
 * 1:30 pm Eastern on 31 December.
 */
describe('Lead ID numbering across New Year', () => {
  const realZone = process.env.BUSINESS_TIMEZONE;
  beforeEach(() => {
    process.env.BUSINESS_TIMEZONE = 'EST';
  });
  afterEach(() => {
    jest.useRealTimers();
    if (realZone === undefined) delete process.env.BUSINESS_TIMEZONE;
    else process.env.BUSINESS_TIMEZONE = realZone;
  });

  /** A book whose highest id this year is `maxThisYear` (null: none yet this year). */
  function harness(maxThisYear: number | null) {
    const prefixes: string[] = [];
    const tx = {
      $executeRaw: jest.fn(async () => 1),
      $queryRaw: jest.fn(async (sql: { values: unknown[] }) => {
        prefixes.push(String(sql.values.find((v) => typeof v === 'string' && v.endsWith('%'))));
        return [{ max_seq: maxThisYear }];
      }),
      lead: {
        createManyAndReturn: jest.fn(async ({ data }: { data: Array<{ leadId: string }> }) =>
          data.map((d) => ({ id: d.leadId, leadId: d.leadId, status: 'new', callStatus: null, assignedToId: null })),
        ),
      },
    };
    const prisma = { $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)), ...tx } as unknown as PrismaService;
    return { service: new LeadIdService(prisma), prefixes };
  }
  const item = () => ({ build: (id: string) => ({ leadId: id, businessName: '', phone: '', state: '', city: '' }) });

  it('numbers the first lead of a new year L-YYYY-1, counting only that year', async () => {
    jest.useFakeTimers({ now: new Date('2027-01-01T06:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const h = harness(null); // last year had 110,821 — none of them count
    await expect(h.service.next()).resolves.toBe('L-2027-1');
    expect(h.prefixes).toEqual(['L-2027-%']);
  });

  it('turns over at midnight on the business calendar, not the server clock', () => {
    // 22:00 on 31 Dec in New York is already 1 Jan in UTC and in India.
    expect(leadIdYear(new Date('2027-01-01T03:00:00Z'))).toBe(2026);
    // 00:30 on 1 Jan in New York.
    expect(leadIdYear(new Date('2027-01-01T05:30:00Z'))).toBe(2027);
  });

  it('switches an import that is running at midnight over to the new year', async () => {
    jest.useFakeTimers({ now: new Date('2027-01-01T06:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const h = harness(null);
    // The run was numbering last year's leads when the clock turned.
    const run: LeadIdRun = { year: 2026, next: 110_822 };
    const leads = await h.service.createManyInRun([item(), item()], run);
    expect(leads.map((l) => l.leadId)).toEqual(['L-2027-1', 'L-2027-2']);
    expect(run).toEqual({ year: 2027, next: 3 });
  });
});
