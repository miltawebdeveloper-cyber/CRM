import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, HttpCode } from '@nestjs/common';
import { BackgroundJobsService } from '../jobs/background-jobs.service.js';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { LeadsService } from './leads.service.js';
import { QuoService } from '../quo/quo.service.js';
import { ArchivedLeadsQueryDto, BulkDeleteLeadsDto, CheckDuplicateDto, CheckImportDto, CreateLeadDto, DuplicateGroupsQueryDto, ImportLeadsDto, ListLeadsQueryDto, UpdateLeadDto } from './dto/lead.dto.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator.js';

@ApiTags('leads')
@ApiBearerAuth()
@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leads: LeadsService,
    private readonly quo: QuoService,
    private readonly jobs: BackgroundJobsService,
  ) {}

  // Create a single lead — master-data entry, Lead Library only. Admin + Team
  // Leader, matching bulk import below.
  @Roles(Role.admin, Role.team_leader)
  @Post()
  create(@Body() dto: CreateLeadDto, @CurrentUser() user: AuthUser) {
    return this.leads.create(dto, user.id, user.role);
  }

  // IMP-001 — bulk import parsed rows.
  //
  // Starts the import as a background job and answers at once with the job,
  // instead of holding the request open while every row is written (which a
  // proxy timeout cut off part way on large files). Poll the route below for
  // progress; the finished job's `result` is the import summary this used to
  // return directly, `createdIds` included. A failed job keeps the ids it had
  // already created in `result`, so the batch can still be rolled back.
  @Roles(Role.admin, Role.team_leader)
  @Post('import')
  @HttpCode(202)
  async bulkImport(@Body() dto: ImportLeadsDto, @CurrentUser() user: AuthUser) {
    const createdIds: string[] = [];
    return this.jobs.start('lead_import', user.id, dto.rows.length, async (ctx) => {
      ctx.onFailure(() => ({ createdIds, interrupted: true }));
      return this.leads.bulkImport(dto, user.id, { createdIds, onProgress: (n) => ctx.progress(n) });
    });
  }

  /** Progress / result of an import started above. */
  @Roles(Role.admin, Role.team_leader)
  @Get('import/jobs/:jobId')
  importJob(@Param('jobId', ParseUUIDPipe) jobId: string, @CurrentUser() user: AuthUser) {
    return this.jobs.get(jobId, 'lead_import', { id: user.id, isManager: user.role === Role.admin });
  }

  /** Pre-import duplicate scan — no writes. Returns which rows match an existing
   *  lead (or an earlier row) on an exact Phone or Email, and what importing the
   *  file would create versus update. */
  @Roles(Role.admin, Role.team_leader)
  @Post('import/check')
  @HttpCode(200)
  checkImport(@Body() dto: CheckImportDto) {
    return this.leads.checkImport(dto.rows, {
      checkFields: dto.checkFields,
      ignorePhoneFormatting: dto.ignorePhoneFormatting,
      // Both of the opt-in rules travel with the check, not just the import.
      // They were being dropped here, so a review run with "match the company
      // domain" ticked reported on a rule the import then applied anyway — the
      // one thing this pair of screens exists to keep in step.
      matchCompanyDomain: dto.matchCompanyDomain,
      matchLocation: dto.matchLocation,
    });
  }

  // Employees see only their assigned leads; admins/leaders see all.
  @Get()
  findAll(@Query() query: ListLeadsQueryDto, @CurrentUser() user: AuthUser) {
    return this.leads.findAll(query, user);
  }

  /**
   * The distinct values behind the timezone / state / city filters.
   *
   * Its own endpoint because the pages used to derive these lists from the full
   * lead book they had downloaded — which stops working the moment the list
   * sends one page, and was a large part of why it had to send the whole book at
   * all. Three grouped reads of indexed columns, no rows returned.
   *
   * Declared before `:id` — Nest matches routes in order, so a later
   * `filter-options` would be swallowed by the `:id` param route above it.
   */
  @Get('filter-options')
  filterOptions(@Query() query: ListLeadsQueryDto, @CurrentUser() user: AuthUser) {
    return this.leads.filterOptions(query, user);
  }

  /**
   * The KPI cards above a lead list, counted over the same filters and role
   * scope as `GET /leads` — so the cards describe the rows below them rather
   * than the whole book. Paging and sort parameters are accepted and ignored.
   *
   * Declared before `:id` for the same reason as `filter-options`.
   */
  @Get('summary')
  summary(@Query() query: ListLeadsQueryDto, @CurrentUser() user: AuthUser) {
    return this.leads.listSummary(query, user);
  }

  /**
   * Duplicate groups among the leads already saved — the Duplicate Leads screen.
   * Read-only; removing anything goes through `bulk-delete` like every other
   * deletion, so a purge is audited the same way and obeys the same rules.
   *
   * Declared before `:id` for the same reason as `filter-options` above.
   */
  @Roles(Role.admin, Role.team_leader)
  @Get('duplicates')
  duplicates(@Query() query: DuplicateGroupsQueryDto) {
    return this.leads.findDuplicateGroups(query);
  }

  /**
   * Archived leads — the Lead Library's Recently deleted view. Restoring goes
   * through `bulk-restore`; removing for good through `archived/purge`.
   *
   * Declared before `:id` for the same reason as `filter-options` above.
   */
  @Roles(Role.admin, Role.team_leader)
  @Get('archived')
  archived(@Query() query: ArchivedLeadsQueryDto) {
    return this.leads.listArchived(query);
  }

  /**
   * Permanently delete ARCHIVED leads — the one irreversible delete left in the
   * app, now that the Library's bulk delete archives. Admin only: a team leader
   * can delete and restore, but destroying a lead and its whole history is the
   * admin's call. Live leads are out of its reach by construction; see
   * `removeMany`'s `archived` mode.
   */
  @Roles(Role.admin)
  @Post('archived/purge')
  @HttpCode(200)
  purgeArchived(@Body() dto: BulkDeleteLeadsDto, @CurrentUser() user: AuthUser) {
    return this.leads.removeMany(dto.ids, user, { archived: true });
  }

  /**
   * Leads matching one record — what the New Lead form calls as the phone or
   * email is filled in, so a duplicate is visible BEFORE the save is attempted
   * rather than only as the 409 that `POST /leads` returns.
   *
   * Admin + Team Leader, the same as `POST /leads` itself. It was open to every
   * signed-in user on the premise that anyone could create a lead — but nobody
   * else can, and the open version let an employee search the WHOLE book by
   * phone, email or company domain and read back other reps' leads.
   */
  @Roles(Role.admin, Role.team_leader)
  @Post('check-duplicate')
  @HttpCode(200)
  checkDuplicate(@Body() dto: CheckDuplicateDto) {
    const { matchCompanyDomain, matchLocation, ...rec } = dto;
    return this.leads.findDuplicatesFor(rec, { matchCompanyDomain, matchLocation });
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.leads.findOne(id, user);
  }

  /** Complete ownership history for a lead — every assignment and reassignment,
   *  newest first, with who it came from, who it went to and who did it. */
  // Both scoped like the lead page itself: an employee reads only leads they
  // hold or closed (404 otherwise), managers any.
  @Get(':id/assignments')
  async assignmentHistory(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.leads.assertAccess(id, user);
    return this.leads.assignmentHistory(id);
  }

  /** Full comment trail for a lead — manual edits and call notes, newest first. */
  @Get(':id/comments')
  async commentHistory(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.leads.assertAccess(id, user);
    return this.leads.commentHistory(id);
  }

  // Edit a lead — Admin + Team Leader only. Field-level changes are logged to
  // the activity trail in the service.
  @Roles(Role.admin, Role.team_leader)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateLeadDto, @CurrentUser() user: AuthUser) {
    return this.leads.update(id, dto, user);
  }

  // Delete — master-data action, Lead Library only. Admin + Team Leader;
  // employees are further limited to their own assigned leads within that
  // (enforced in the service), managers may delete any.
  /**
   * Delete many leads at once, in one transaction — the bulk-delete confirmation
   * and the "undo import" rollback both post here (rollback sends the ids the
   * import returned, so only that batch is removed). POST, not DELETE-with-body,
   * because request bodies on DELETE aren't reliably forwarded by every proxy.
   */
  @Roles(Role.admin, Role.team_leader)
  @Post('bulk-delete')
  @HttpCode(200)
  bulkDelete(@Body() dto: BulkDeleteLeadsDto, @CurrentUser() user: AuthUser) {
    return this.leads.removeMany(dto.ids, user);
  }

  /**
   * Remove many leads REVERSIBLY — the Duplicate Leads purge.
   *
   * A separate route from `bulk-delete` rather than a flag on it, because the
   * two are different promises: this one can be taken back and that one cannot,
   * and a boolean in a body is a poor place to keep a distinction that matters
   * this much. Returns the ids it archived so the caller can undo exactly the
   * batch it just removed.
   */
  @Roles(Role.admin, Role.team_leader)
  @Post('bulk-archive')
  @HttpCode(200)
  bulkArchive(@Body() dto: BulkDeleteLeadsDto, @CurrentUser() user: AuthUser) {
    return this.leads.archiveMany(dto.ids, user);
  }

  /** Put an archived batch back — the Undo beside the purge. */
  @Roles(Role.admin, Role.team_leader)
  @Post('bulk-restore')
  @HttpCode(200)
  bulkRestore(@Body() dto: BulkDeleteLeadsDto, @CurrentUser() user: AuthUser) {
    return this.leads.restoreMany(dto.ids, user);
  }

  @Roles(Role.admin, Role.team_leader)
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.leads.remove(id, user);
  }

  // ── Quo integration ──
  // Bulk: sync every not-yet-synced lead to Quo in one action. Declared before
  // the ':id/quo-sync' param route so the static path always matches first.
  //
  // A background job, like the import: syncing the whole book one lead at a
  // time outlived any proxy timeout. Only one runs at a time — a second click
  // while one is running gets the running job back rather than starting a
  // duplicate that spends the provider's rate limit twice.
  @Roles(Role.admin, Role.team_leader)
  @Post('quo-sync-all')
  @HttpCode(202)
  async syncAllToQuo(@CurrentUser() user: AuthUser) {
    const active = await this.jobs.activeOf('quo_sync_all');
    if (active) return active;
    return this.jobs.start('quo_sync_all', user.id, 0, (ctx) =>
      this.quo.syncAllLeads((done, total) => ctx.progress(done, total)),
    );
  }

  @Roles(Role.admin, Role.team_leader)
  @Get('quo-sync-all/jobs/:jobId')
  syncAllToQuoJob(@Param('jobId', ParseUUIDPipe) jobId: string) {
    // Either manager may watch a sync either started; it is one shared operation.
    return this.jobs.get(jobId, 'quo_sync_all', { id: '', isManager: true });
  }

  // Trigger: send this lead to Quo, store the response, return the result.
  @Roles(Role.admin, Role.team_leader)
  @Post(':id/quo-sync')
  @HttpCode(200)
  syncToQuo(@Param('id') id: string) {
    return this.quo.syncLead(id);
  }

  @Get(':id/quo-logs')
  async quoLogs(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.leads.assertAccess(id, user);
    return this.quo.getLogs(id);
  }
}
