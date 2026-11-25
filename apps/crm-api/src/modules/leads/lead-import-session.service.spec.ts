import { describe, expect, it, jest } from '@jest/globals';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Role } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BackgroundJobsService } from '../jobs/background-jobs.service.js';
import { LeadImportSessionService } from './lead-import-session.service.js';
import { LeadsService } from './leads.service.js';

/**
 * The chunked import stages a file on the server and runs the check, the import
 * and Undo over it. These pin the parts that are the session's own — who may
 * touch it, that a step can't run twice, and that the import is handed exactly
 * what the review decided — since the import rules themselves are bulkImport's.
 */
describe('LeadImportSessionService', () => {
  const admin = { id: 'admin-1', role: Role.admin };
  const leader = { id: 'leader-1', role: Role.team_leader };

  function harness(session: Record<string, unknown>, opts: { staged?: number; duplicates?: Array<{ idx: number; prior: string | null }> } = {}) {
    let current = { id: 's1', createdById: 'admin-1', status: 'checked', totalRows: 4, checkOptions: { checkFields: ['phone'] }, createdIds: [] as string[], ...session };
    const staged = Array.from({ length: opts.staged ?? (current.totalRows as number) }, (_, idx) => ({
      idx,
      data: { businessName: `Co ${idx}`, phone: `000000000${idx}`, email: `co${idx}@example.com` },
    }));
    const update = jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      current = { ...current, ...data };
      return current;
    });
    const prisma = {
      leadImportSession: {
        findUnique: jest.fn(async () => current),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', status: 'uploading', ...data })),
        update,
        updateMany: jest.fn(async ({ where, data }: { where: { status: { in: string[] } }; data: { status: string } }) => {
          if (!where.status.in.includes(current.status as string)) return { count: 0 };
          current = { ...current, status: data.status };
          return { count: 1 };
        }),
        deleteMany: jest.fn(async () => ({ count: 0 })),
      },
      leadImportRow: {
        createMany: jest.fn(async () => ({ count: 0 })),
        findMany: jest.fn(async ({ where }: { where: { idx: { gt: number } } }) => staged.filter((r) => r.idx > where.idx.gt).slice(0, 5000)),
        deleteMany: jest.fn(async () => ({ count: 0 })),
      },
      leadImportDuplicate: { deleteMany: jest.fn(async () => ({ count: 0 })), createMany: jest.fn(async () => ({ count: 0 })) },
      $queryRaw: jest.fn(async () => opts.duplicates ?? []),
    } as unknown as PrismaService;
    const bulkImport = jest.fn(async (dto: { rows: unknown[] }, _u: string, hooks: { createdIds: string[] }) => {
      hooks.createdIds.push('lead-a', 'lead-b');
      return { imported: 2, updated: 0, skipped: 0, errors: [{ row: 1, reason: 'x' }], totalRows: dto.rows.length, createdIds: hooks.createdIds };
    });
    const removeMany = jest.fn(async (ids: string[]) => ({ deleted: ids.length }));
    const leads = { bulkImport, removeMany, checkImport: jest.fn() } as unknown as LeadsService;
    // Runs the job inline and hands back what it returned — or, as the real
    // runner does, a failed job rather than a thrown error.
    const jobs = {
      start: jest.fn(async (_k: string, _u: string, _t: number, run: (ctx: unknown) => Promise<unknown>) => {
        try {
          return await run({ progress: async () => undefined, onFailure: () => undefined });
        } catch (e) {
          return { status: 'failed', error: (e as Error).message };
        }
      }),
    } as unknown as BackgroundJobsService;
    return { service: new LeadImportSessionService(prisma, leads, jobs), prisma, bulkImport, removeMany, current: () => current, update };
  }

  it('imports with the reviewer\'s calls, the remembered defaults for the rest, and the fields kept from the CRM', async () => {
    const h = harness({}, {
      duplicates: [
        { idx: 0, prior: null }, // no ruling → skip
        { idx: 1, prior: 'import' }, // imported last time → import
        { idx: 2, prior: null }, // the reviewer said import
        { idx: 3, prior: 'import' }, // the reviewer said skip
      ],
    });
    const res = await h.service.startImport('s1', { mode: 'decisions', decisions: { 2: 'import', 3: 'skip' }, keepFields: { 1: ['email'] } }, admin);

    const [dto] = h.bulkImport.mock.calls[0] as unknown as [{ rows: Array<Record<string, unknown>>; skipRowIndexes: number[]; skipDuplicates: boolean; checkFields: string[] }];
    expect(dto.skipRowIndexes).toEqual([0, 3]);
    expect(dto.skipDuplicates).toBe(false);
    // The rules the review was checked under, not whatever the request says.
    expect(dto.checkFields).toEqual(['phone']);
    expect(dto.rows[1]).not.toHaveProperty('email');
    expect(dto.rows[0]).toHaveProperty('email');
    // The created ids live on the session for Undo, not in the job result.
    expect(res).toMatchObject({ sessionId: 's1', createdCount: 2, errorCount: 1 });
    expect((res as { createdIds?: unknown }).createdIds).toBeUndefined();
    expect(h.current()).toMatchObject({ status: 'imported', createdIds: ['lead-a', 'lead-b'] });
  });

  it('will not start the same import twice', async () => {
    const h = harness({ status: 'importing' });
    await expect(h.service.startImport('s1', { mode: 'all' }, admin)).rejects.toBeInstanceOf(ConflictException);
    expect(h.bulkImport).not.toHaveBeenCalled();
  });

  it('refuses a file whose upload did not finish', async () => {
    const h = harness({}, { staged: 3 });
    await expect(h.service.startImport('s1', { mode: 'all' }, admin)).resolves.toMatchObject({ status: 'failed', error: expect.stringMatching(/3 of 4 rows arrived/) });
    expect(h.bulkImport).not.toHaveBeenCalled();
    expect(h.current().status).toBe('failed');
  });

  it("keeps a team leader out of someone else's import", async () => {
    const h = harness({ createdById: 'someone-else' });
    await expect(h.service.startImport('s1', { mode: 'all' }, leader)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('only takes rows while uploading, and only inside the file', async () => {
    const checked = harness({ status: 'checked' });
    await expect(checked.service.append('s1', 0, [{} as never], admin)).rejects.toBeInstanceOf(ConflictException);
    const uploading = harness({ status: 'uploading' });
    await expect(uploading.service.append('s1', 3, [{} as never, {} as never], admin)).rejects.toThrow(/outside a file of 4 rows/);
    await expect(uploading.service.append('s1', 2, [{} as never, {} as never], admin)).resolves.toEqual({ received: 2 });
  });

  it('undoes in batches and forgets the ids once they are gone', async () => {
    const ids = Array.from({ length: 12_000 }, (_, i) => `lead-${i}`);
    const h = harness({ status: 'imported', createdIds: ids });
    const res = await h.service.startUndo('s1', admin);
    expect(h.removeMany.mock.calls.map((c) => (c[0] as string[]).length)).toEqual([5000, 5000, 2000]);
    expect(res).toEqual({ sessionId: 's1', removed: 12_000 });
    expect(h.current()).toMatchObject({ status: 'undone', createdIds: [] });
  });
});
