import { Body, Controller, Delete, Get, Param, Patch, Post, Query, HttpCode } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { LeadsService } from './leads.service';
import { QuoService } from '../quo/quo.service';
import { BulkDeleteLeadsDto, CheckDuplicateDto, CheckImportDto, CreateLeadDto, DuplicateGroupsQueryDto, ImportLeadsDto, ListLeadsQueryDto, UpdateLeadDto } from './dto/lead.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

@ApiTags('leads')
@ApiBearerAuth()
@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leads: LeadsService,
    private readonly quo: QuoService,
  ) {}

  // Create a single lead/contact — open to any authenticated user (the Contacts
  // module is the entry point for adding new records). Bulk CSV import below
  // stays Admin + Team Leader only.
  @Post()
  create(@Body() dto: CreateLeadDto, @CurrentUser() user: AuthUser) {
    return this.leads.create(dto, user.id, user.role);
  }

  // IMP-001 — bulk import parsed rows
  @Roles(Role.admin, Role.team_leader)
  @Post('import')
  @HttpCode(200)
  bulkImport(@Body() dto: ImportLeadsDto, @CurrentUser() user: AuthUser) {
    return this.leads.bulkImport(dto, user.id);
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
   * Leads matching one record — what the New Lead form calls as the phone or
   * email is filled in, so a duplicate is visible BEFORE the save is attempted
   * rather than only as the 409 that `POST /leads` returns.
   *
   * Open to any authenticated user because creating a lead is, and a check that
   * managers alone could run would leave everyone else's form unable to warn.
   */
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
  @Get(':id/assignments')
  assignmentHistory(@Param('id') id: string) {
    return this.leads.assignmentHistory(id);
  }

  /** Full comment trail for a lead — manual edits and call notes, newest first. */
  @Get(':id/comments')
  commentHistory(@Param('id') id: string) {
    return this.leads.commentHistory(id);
  }

  // Edit a lead — Admin + Team Leader only. Field-level changes are logged to
  // the activity trail in the service.
  @Roles(Role.admin, Role.team_leader)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateLeadDto, @CurrentUser() user: AuthUser) {
    return this.leads.update(id, dto, user);
  }

  // Delete (soft) — any authenticated user; employees are limited to their own
  // assigned leads (enforced in the service), managers may delete any.
  /**
   * Delete many leads at once, in one transaction — the bulk-delete confirmation
   * and the "undo import" rollback both post here (rollback sends the ids the
   * import returned, so only that batch is removed). POST, not DELETE-with-body,
   * because request bodies on DELETE aren't reliably forwarded by every proxy.
   */
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
  @Post('bulk-archive')
  @HttpCode(200)
  bulkArchive(@Body() dto: BulkDeleteLeadsDto, @CurrentUser() user: AuthUser) {
    return this.leads.archiveMany(dto.ids, user);
  }

  /** Put an archived batch back — the Undo beside the purge. */
  @Post('bulk-restore')
  @HttpCode(200)
  bulkRestore(@Body() dto: BulkDeleteLeadsDto, @CurrentUser() user: AuthUser) {
    return this.leads.restoreMany(dto.ids, user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.leads.remove(id, user);
  }

  // ── Quo integration ──
  // Bulk: sync every not-yet-synced lead to Quo in one action. Declared before
  // the ':id/quo-sync' param route so the static path always matches first.
  @Roles(Role.admin, Role.team_leader)
  @Post('quo-sync-all')
  @HttpCode(200)
  syncAllToQuo() {
    return this.quo.syncAllLeads();
  }

  // Trigger: send this lead to Quo, store the response, return the result.
  @Roles(Role.admin, Role.team_leader)
  @Post(':id/quo-sync')
  @HttpCode(200)
  syncToQuo(@Param('id') id: string) {
    return this.quo.syncLead(id);
  }

  @Get(':id/quo-logs')
  quoLogs(@Param('id') id: string) {
    return this.quo.getLogs(id);
  }
}
