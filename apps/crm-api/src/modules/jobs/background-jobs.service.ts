import { Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Prisma } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';

/** A running job is presumed dead once its heartbeat is this old. */
const STALE_AFTER_MS = 2 * 60_000;
/** How often a running job proves it is alive, even between progress reports. */
const HEARTBEAT_MS = 30_000;
/** Progress writes are coalesced to at most one per this interval. */
const PROGRESS_WRITE_MS = 1_000;

export type JobKind = 'lead_import' | 'quo_sync_all';

export interface JobContext {
  /** Report progress. Cheap to call often — writes are coalesced. */
  progress(processed: number, total?: number): Promise<void>;
  /**
   * What to store as the result if the job fails part way — e.g. the ids an
   * import had already created, so the batch can still be rolled back.
   */
  onFailure(partial: () => unknown): void;
}

export interface JobView {
  id: string;
  kind: string;
  status: 'running' | 'completed' | 'failed';
  total: number;
  processed: number;
  result: unknown;
  error: string | null;
  createdById: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/**
 * Long-running work started from the UI — lead import, Quo sync-all — run
 * BEHIND the request that started it.
 *
 * Both used to run inside one HTTP request: a big import walked tens of
 * thousands of rows while the browser waited, so a proxy timeout (typically
 * 60–100 s) cut it off half way, the client never received the created ids, and
 * "Undo import" had nothing to undo. Now the request returns a job id at once;
 * the work runs in this process, writing progress to `background_jobs`, and the
 * client polls that row. The row lives in the database so any instance can
 * answer the poll, and a job whose process dies is marked failed (on shutdown,
 * or by the next boot when its heartbeat has gone stale) instead of showing
 * "running" forever.
 */
@Injectable()
export class BackgroundJobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BackgroundJobsService.name);
  /** Jobs this process is running, so a shutdown can say what it interrupted. */
  private readonly running = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create the job row and start `run` behind the response. Resolves as soon as
   * the row exists; `run`'s own result or failure lands in the row.
   */
  async start<T>(kind: JobKind, createdById: string | null, total: number, run: (ctx: JobContext) => Promise<T>): Promise<JobView> {
    const job = await this.prisma.backgroundJob.create({
      data: { kind, createdById, total, status: 'running' },
    });
    this.running.add(job.id);
    void this.execute(job.id, total, run);
    return this.view(job);
  }

  /** The most recent live job of a kind, if one is running — to refuse duplicates. */
  async activeOf(kind: JobKind): Promise<JobView | null> {
    const job = await this.prisma.backgroundJob.findFirst({
      where: { kind, status: 'running', heartbeatAt: { gt: new Date(Date.now() - STALE_AFTER_MS) } },
      orderBy: { createdAt: 'desc' },
    });
    return job ? this.view(job) : null;
  }

  /**
   * One job, for its poll. `kind` must match, and non-managers may only read
   * jobs they started.
   */
  async get(id: string, kind: JobKind, viewer: { id: string; isManager: boolean }): Promise<JobView> {
    const job = await this.prisma.backgroundJob.findUnique({ where: { id } });
    if (!job || job.kind !== kind || (!viewer.isManager && job.createdById !== viewer.id)) {
      throw new NotFoundException('Job not found');
    }
    return this.view(job);
  }

  private async execute<T>(id: string, total: number, run: (ctx: JobContext) => Promise<T>) {
    let lastWrite = 0;
    let latest = { processed: 0, total };
    let partial: (() => unknown) | null = null;
    const write = (data: Prisma.BackgroundJobUpdateInput) =>
      this.prisma.backgroundJob.update({ where: { id }, data }).catch((err) => {
        this.logger.warn(`Could not update job ${id}: ${(err as Error).message}`);
      });
    const heartbeat = setInterval(() => {
      void write({ heartbeatAt: new Date(), processed: latest.processed, total: latest.total });
    }, HEARTBEAT_MS);
    heartbeat.unref();

    const ctx: JobContext = {
      progress: async (processed, t) => {
        latest = { processed, total: t ?? latest.total };
        const now = Date.now();
        if (now - lastWrite < PROGRESS_WRITE_MS) return;
        lastWrite = now;
        await write({ processed, total: latest.total, heartbeatAt: new Date() });
      },
      onFailure: (fn) => {
        partial = fn;
      },
    };

    try {
      const result = await run(ctx);
      await write({
        status: 'completed',
        result: (result ?? null) as Prisma.InputJsonValue,
        processed: latest.total || latest.processed,
        total: latest.total,
        finishedAt: new Date(),
        heartbeatAt: new Date(),
      });
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      this.logger.error(`Job ${id} failed: ${message}`);
      let partialResult: unknown = null;
      try {
        partialResult = partial ? (partial as () => unknown)() : null;
      } catch {
        /* a broken partial must not hide the real failure */
      }
      await write({
        status: 'failed',
        error: message.slice(0, 2000),
        result: (partialResult ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        processed: latest.processed,
        finishedAt: new Date(),
        heartbeatAt: new Date(),
      });
    } finally {
      clearInterval(heartbeat);
      this.running.delete(id);
    }
  }

  /** Jobs left 'running' by a process that died: fail them, so nobody waits forever. */
  async onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'test') return;
    try {
      const { count } = await this.prisma.backgroundJob.updateMany({
        where: { status: 'running', heartbeatAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } },
        data: { status: 'failed', error: 'Interrupted — the server restarted while this was running.', finishedAt: new Date() },
      });
      if (count) this.logger.warn(`Marked ${count} interrupted background job(s) as failed`);
    } catch (err) {
      this.logger.warn(`Could not sweep interrupted jobs: ${(err as Error).message}`);
    }
  }

  /** A redeploy interrupts whatever this process is running; say so in the row. */
  async onApplicationShutdown() {
    if (!this.running.size) return;
    const ids = [...this.running];
    await this.prisma.backgroundJob
      .updateMany({
        where: { id: { in: ids }, status: 'running' },
        data: { status: 'failed', error: 'Interrupted — the server shut down (redeploy) while this was running.', finishedAt: new Date() },
      })
      .catch(() => undefined);
    this.logger.warn(`Shut down with ${ids.length} background job(s) running; marked them failed`);
  }

  private view(job: {
    id: string; kind: string; status: string; total: number; processed: number; result: unknown;
    error: string | null; createdById: string | null; createdAt: Date; finishedAt: Date | null;
  }): JobView {
    return {
      id: job.id,
      kind: job.kind,
      status: job.status as JobView['status'],
      total: job.total,
      processed: job.processed,
      result: job.result ?? null,
      error: job.error,
      createdById: job.createdById,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
    };
  }
}
