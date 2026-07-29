import { Body, Controller, Delete, Get, Param, Patch, Post, Query, HttpCode } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { LeadsService } from './leads.service';
import { QuoService } from '../quo/quo.service';
import { BulkDeleteLeadsDto, CheckImportDto, CreateLeadDto, ImportLeadsDto, ListLeadsQueryDto, UpdateLeadDto } from './dto/lead.dto';
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
   *  lead (or an earlier row) by Company Name, Phone or Email. */
  @Roles(Role.admin, Role.team_leader)
  @Post('import/check')
  @HttpCode(200)
  checkImport(@Body() dto: CheckImportDto) {
    return this.leads.checkImport(dto.rows, dto.checkFields);
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

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.leads.findOne(id, user);
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
