import { describe, expect, it, jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BackgroundJobsService } from './background-jobs.service.js';

/**
 * Imports and the Quo sync run behind the request. What matters is that the
 * caller always ends up with an answer in the row — the result, or the failure
 * WITH whatever the job had already done — and that one person can't read
 * another's import.
 */
describe('BackgroundJobsService', () => {
  type Row = Record<string, unknown> & { id: string; kind: string; status: string; createdById: string | null };

  function harness() {
    const rows = new Map<string, Row>();
    const prisma = {
      backgroundJob: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `job-${rows.size + 1}`, total: 0, processed: 0, result: null, error: null, createdAt: new Date(), finishedAt: null, ...data } as unknown as Row;
          rows.set(row.id, row);
          return row;
        }),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = rows.get(where.id)!;
          Object.assign(row, data);
          return row;
        }),
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      },
    } as unknown as PrismaService;
    return { service: new BackgroundJobsService(prisma), rows };
  }

  /** Let the job's promise chain run to completion. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('answers at once and stores the result when the work finishes', async () => {
    const { service, rows } = harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = await service.start('lead_import', 'u1', 10, async () => {
      await gate;
      return { imported: 10 };
    });
    expect(job.status).toBe('running');
    release();
    await settle();
    await settle();
    expect(rows.get(job.id)).toMatchObject({ status: 'completed', result: { imported: 10 } });
  });

  it('keeps the partial result when the work fails, so an import can still be undone', async () => {
    const { service, rows } = harness();
    const createdIds: string[] = [];
    const job = await service.start('lead_import', 'u1', 3, async (ctx) => {
      ctx.onFailure(() => ({ createdIds }));
      createdIds.push('lead-a', 'lead-b');
      throw new Error('database went away');
    });
    await settle();
    await settle();
    expect(rows.get(job.id)).toMatchObject({
      status: 'failed',
      error: 'database went away',
      result: { createdIds: ['lead-a', 'lead-b'] },
    });
  });

  it('only shows a job to the person who started it, unless they manage', async () => {
    const { service } = harness();
    const job = await service.start('lead_import', 'owner', 1, async () => ({}));
    await expect(service.get(job.id, 'lead_import', { id: 'owner', isManager: false })).resolves.toMatchObject({ id: job.id });
    await expect(service.get(job.id, 'lead_import', { id: 'other', isManager: false })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.get(job.id, 'lead_import', { id: 'other', isManager: true })).resolves.toMatchObject({ id: job.id });
    // Asking for a job under the wrong kind is a miss, not a leak.
    await expect(service.get(job.id, 'quo_sync_all', { id: 'owner', isManager: true })).rejects.toBeInstanceOf(NotFoundException);
  });
});
