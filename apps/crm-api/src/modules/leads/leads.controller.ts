import { Body, Controller, Delete, Get, Param, Patch, Post, Query, HttpCode } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { LeadsService } from './leads.service';
import { QuoService } from '../quo/quo.service';
import { CreateLeadDto, ImportLeadsDto, ListLeadsQueryDto, UpdateLeadDto } from './dto/lead.dto';
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

  // Employees see only their assigned leads; admins/leaders see all.
  @Get()
  findAll(@Query() query: ListLeadsQueryDto, @CurrentUser() user: AuthUser) {
    return this.leads.findAll(query, user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.leads.findOne(id, user);
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
