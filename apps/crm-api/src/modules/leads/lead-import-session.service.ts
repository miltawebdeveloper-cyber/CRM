import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BackgroundJobsService } from '../jobs/background-jobs.service.js';
import { LeadsService } from './leads.service.js';
import type { CheckImportSessionDto, CreateLeadDto, ImportLeadsDto, RunImportSessionDto } from './dto/lead.dto.js';

/** Staged rows read back per query. */
const PAGE = 5000;
/** Verdicts written per insert. */
const WRITE_BATCH = 2000;
/** Leads removed per transaction on Undo. */
const UNDO_BATCH = 5000;
/** A session nobody finished, or an import too old to undo, is swept after this. */
const SESSION_TTL_MS = 24 * 60 * 60_000;
/** Row errors returned with the result — the full count is returned alongside. */
const MAX_ERRORS_RETURNED = 2000;

type Viewer = { id: string; role: Role };

/** Dates and the like as JSON would write them — what a jsonb column holds. */
const toJson = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

/**
 * Imports of any size, in pieces.
 *
 * The old path sent the whole file in one request — to be checked, then again
 * to be imported — so the file size was capped by the request limit (about
 * 150,000 rows at 100 MB) and the duplicate review held every duplicate in the
 * browser at once. Here the browser opens a session and uploads the rows a few
 * thousand at a time; the check and the import then run as background jobs over
 * the staged rows, the review pages through the verdicts, and Undo works from
 * the ids the session recorded rather than a list the browser had to keep.
 *
 * The rules themselves are untouched: the check is `LeadsService.checkImport`
 * and the import is `LeadsService.bulkImport`, handed the staged rows, so the
 * one-request path and this one cannot disagree about a row.
 *
 * Session status: uploading → checking → checked → importing → imported (or
 * failed) → undoing → undone. Each transition is claimed with a conditional
 * update, so a double click can't start the same import twice.
 */
@Injectable()
export class LeadImportSessionService {
  private readonly logger = new Logger(LeadImportSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
    private readonly jobs: BackgroundJobsService,
  ) {}

  /** Open a session for a file of `totalRows` rows. */
  async open(totalRows: number, viewer: Viewer) {
    await this.sweep();
    return this.prisma.leadImportSession.create({
      data: { createdById: viewer.id, totalRows },
      select: { id: true, totalRows: true, status: true },
    });
  }

  /**
   * Stage one chunk of rows at positions start … start+rows.length-1. Sending
   * the same chunk twice (a retry after a dropped connection) is harmless: the
   * first copy is kept.
   */
  async append(id: string, start: number, rows: CreateLeadDto[], viewer: Viewer) {
    const s = await this.own(id, viewer);
    if (s.status !== 'uploading') throw new ConflictException('This file has already been checked — upload it again to change its rows.');
    if (start + rows.length > s.totalRows) throw new BadRequestException(`Rows ${start}–${start + rows.length - 1} fall outside a file of ${s.totalRows} rows.`);
    await this.prisma.leadImportRow.createMany({
      data: rows.map((r, k) => ({ sessionId: id, idx: start + k, data: toJson(r) })),
      skipDuplicates: true,
    });
    return { received: rows.length };
  }

  /** Run the duplicate check over the staged file, as a background job. */
  async startCheck(id: string, opts: CheckImportSessionDto, viewer: Viewer) {
    const s = await this.own(id, viewer);
    await this.claim(id, ['uploading', 'checked'], 'checking', 'The duplicate check for this file is already running, or the file has been imported.');
    try {
      return await this.jobs.start('lead_import_check', viewer.id, s.totalRows, async () => {
        let done = false;
        try {
          const rows = await this.loadRows(id, s.totalRows);
          const res = await this.leads.checkImport(rows, opts);
          await this.prisma.leadImportDuplicate.deleteMany({ where: { sessionId: id } });
          for (let k = 0; k < res.duplicateRows.length; k += WRITE_BATCH) {
            await this.prisma.leadImportDuplicate.createMany({
              data: res.duplicateRows.slice(k, k + WRITE_BATCH).map((d) => ({ sessionId: id, idx: d.index, result: toJson(d) })),
            });
          }
          const { duplicateRows, ...counts } = res;
          const summary = {
            ...counts,
            // Duplicates whose remembered ruling is "import" — so the review can
            // say what "keep my decisions" will do to the rows it hasn't shown.
            rememberedImport: duplicateRows.filter((d) => d.priorDecision?.decision === 'import').length,
          };
          await this.prisma.leadImportSession.update({
            where: { id },
            data: { status: 'checked', checkOptions: toJson(opts), summary },
          });
          done = true;
          return { sessionId: id, ...summary };
        } finally {
          if (!done) await this.setStatus(id, 'uploading');
        }
      });
    } catch (e) {
      await this.setStatus(id, 'uploading');
      throw e;
    }
  }

  /** One page of the check's verdicts, in file order. */
  async duplicates(id: string, offset: number, limit: number, viewer: Viewer) {
    await this.own(id, viewer);
    const where = { sessionId: id };
    const [total, page] = await Promise.all([
      this.prisma.leadImportDuplicate.count({ where }),
      this.prisma.leadImportDuplicate.findMany({ where, orderBy: { idx: 'asc' }, skip: offset, take: limit, select: { result: true } }),
    ]);
    return { total, offset, rows: page.map((p) => p.result) };
  }

  /** Import the staged file, as a background job, under the rules it was checked with. */
  async startImport(id: string, body: RunImportSessionDto, viewer: Viewer) {
    const s = await this.own(id, viewer);
    await this.claim(id, ['checked'], 'importing', s.status === 'checked' ? 'This file is already being imported.' : statusMessage(s.status));
    const createdIds: string[] = [];
    try {
      return await this.jobs.start('lead_import', viewer.id, s.totalRows, async (ctx) => {
        ctx.onFailure(() => ({ sessionId: id, createdCount: createdIds.length, interrupted: true }));
        let ok = false;
        try {
          const rows = await this.loadRows(id, s.totalRows);
          // "Keep the CRM's value" is a field left out of the row: the import
          // writes only the columns a row fills, so it leaves that one alone.
          for (const [idx, fields] of Object.entries(body.keepFields ?? {})) {
            const row = rows[Number(idx)] as unknown as Record<string, unknown> | undefined;
            if (!row || !Array.isArray(fields)) continue;
            for (const f of fields) if (typeof f === 'string') delete row[f];
          }
          const skipRowIndexes = body.mode === 'decisions' ? await this.skipsFor(id, body.decisions ?? {}) : undefined;
          const opts = (s.checkOptions ?? {}) as CheckImportSessionDto;
          const result = await this.leads.bulkImport(
            { ...opts, rows, skipDuplicates: body.mode === 'skip_duplicates', skipRowIndexes } as ImportLeadsDto,
            viewer.id,
            { createdIds, onProgress: (n) => ctx.progress(n) },
          );
          ok = true;
          // The ids stay on the session for Undo rather than in the job result,
          // which a file of a million new leads would otherwise fill with 37 MB.
          const { errors, ...rest } = result;
          return {
            ...rest,
            createdIds: undefined,
            sessionId: id,
            createdCount: createdIds.length,
            errors: errors.slice(0, MAX_ERRORS_RETURNED),
            errorCount: errors.length,
          };
        } finally {
          await this.prisma.leadImportSession
            .update({ where: { id }, data: { status: ok ? 'imported' : 'failed', createdIds } })
            .catch((err) => this.logger.error(`Could not record import ${id}'s ${createdIds.length} created leads: ${(err as Error).message}`));
          // The staged copy has done its job; only the ids are needed now.
          if (ok) await this.dropStaged(id);
        }
      });
    } catch (e) {
      await this.setStatus(id, 'checked');
      throw e;
    }
  }

  /** Remove the leads this session's import created, as a background job. */
  async startUndo(id: string, viewer: Viewer) {
    const s = await this.own(id, viewer);
    if (!s.createdIds.length) throw new ConflictException('This import created no leads, so there is nothing to undo.');
    await this.claim(id, ['imported', 'failed'], 'undoing', 'This import is already being undone, or was undone already.');
    const ids = s.createdIds;
    try {
      return await this.jobs.start('lead_import_undo', viewer.id, ids.length, async (ctx) => {
        let k = 0;
        let removed = 0;
        try {
          for (; k < ids.length; k += UNDO_BATCH) {
            removed += (await this.leads.removeMany(ids.slice(k, k + UNDO_BATCH), viewer)).deleted;
            await ctx.progress(Math.min(k + UNDO_BATCH, ids.length));
          }
          await this.prisma.leadImportSession.update({ where: { id }, data: { status: 'undone', createdIds: [] } });
          await this.dropStaged(id);
          return { sessionId: id, removed };
        } catch (e) {
          // What is left is still undoable: keep the ids not yet removed.
          await this.prisma.leadImportSession
            .update({ where: { id }, data: { status: s.status, createdIds: ids.slice(k) } })
            .catch(() => undefined);
          throw e;
        }
      });
    } catch (e) {
      await this.setStatus(id, s.status);
      throw e;
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async own(id: string, viewer: Viewer) {
    const s = await this.prisma.leadImportSession.findUnique({ where: { id } });
    // Admins see every import; a team leader sees their own.
    if (!s || (viewer.role !== Role.admin && s.createdById !== viewer.id)) {
      throw new NotFoundException('This import has expired or does not exist. Upload the file again.');
    }
    return s;
  }

  /** Move from one of `from` to `to`, or refuse — so two clicks can't both start a job. */
  private async claim(id: string, from: string[], to: string, refusal: string) {
    const { count } = await this.prisma.leadImportSession.updateMany({ where: { id, status: { in: from } }, data: { status: to } });
    if (!count) throw new ConflictException(refusal);
  }

  private setStatus(id: string, status: string) {
    return this.prisma.leadImportSession
      .update({ where: { id }, data: { status } })
      .then(() => undefined)
      .catch(() => undefined);
  }

  private async dropStaged(id: string) {
    await this.prisma.leadImportRow.deleteMany({ where: { sessionId: id } }).catch(() => undefined);
    await this.prisma.leadImportDuplicate.deleteMany({ where: { sessionId: id } }).catch(() => undefined);
  }

  /** Sessions over a day old, unless a job is working on one right now. */
  private async sweep() {
    await this.prisma.leadImportSession
      .deleteMany({
        where: {
          createdAt: { lt: new Date(Date.now() - SESSION_TTL_MS) },
          status: { notIn: ['checking', 'importing', 'undoing'] },
        },
      })
      .catch((err) => this.logger.warn(`Could not sweep old import sessions: ${(err as Error).message}`));
  }

  /** Every staged row, in file order — refusing a file with rows missing. */
  private async loadRows(id: string, totalRows: number): Promise<CreateLeadDto[]> {
    const rows: CreateLeadDto[] = new Array(totalRows);
    let received = 0;
    let after = -1;
    for (;;) {
      const page = await this.prisma.leadImportRow.findMany({
        where: { sessionId: id, idx: { gt: after } },
        orderBy: { idx: 'asc' },
        take: PAGE,
        select: { idx: true, data: true },
      });
      for (const r of page) rows[r.idx] = r.data as unknown as CreateLeadDto;
      received += page.length;
      if (page.length < PAGE) break;
      after = page[page.length - 1].idx;
    }
    if (received !== totalRows) {
      throw new BadRequestException(`The upload is incomplete — ${received.toLocaleString()} of ${totalRows.toLocaleString()} rows arrived. Upload the file again.`);
    }
    return rows;
  }

  /**
   * The duplicate rows to leave out under "decisions": the reviewer's own call
   * where they made one, otherwise the remembered ruling (import if it was
   * imported last time), otherwise skip — the same default the review shows.
   * Reads only the remembered ruling out of each verdict, not the whole record.
   */
  private async skipsFor(id: string, decisions: Record<string, 'import' | 'skip'>) {
    const rows = await this.prisma.$queryRaw<Array<{ idx: number; prior: string | null }>>`
      SELECT idx, result->'priorDecision'->>'decision' AS prior
      FROM lead_import_duplicates WHERE session_id = ${id}::uuid ORDER BY idx`;
    return rows
      .filter((r) => {
        const own = decisions[String(r.idx)];
        const d = own === 'import' || own === 'skip' ? own : r.prior === 'import' ? 'import' : 'skip';
        return d === 'skip';
      })
      .map((r) => r.idx);
  }
}

function statusMessage(status: string) {
  switch (status) {
    case 'uploading':
    case 'checking':
      return 'Run the duplicate check before importing.';
    case 'importing':
      return 'This file is already being imported.';
    case 'undone':
      return 'This import was undone. Upload the file again to re-import it.';
    default:
      return 'This file has already been imported.';
  }
}
