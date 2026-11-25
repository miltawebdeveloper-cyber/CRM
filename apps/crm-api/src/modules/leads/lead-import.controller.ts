import { Body, Controller, DefaultValuePipe, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { BackgroundJobsService } from '../jobs/background-jobs.service.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator.js';
import { AppendImportRowsDto, CheckImportSessionDto, OpenImportSessionDto, RunImportSessionDto } from './dto/lead.dto.js';
import { LeadImportSessionService } from './lead-import-session.service.js';

/**
 * The chunked import — any number of rows. Open a session, upload the rows a
 * few thousand at a time, run the check, page through the duplicates, run the
 * import, and Undo it if need be. The check, import and undo are background
 * jobs; poll `jobs/:jobId` for each. Admin + Team Leader, like the one-request
 * import in LeadsController.
 */
@ApiTags('leads')
@ApiBearerAuth()
@Roles(Role.admin, Role.team_leader)
@Controller('leads/import/sessions')
export class LeadImportController {
  constructor(
    private readonly sessions: LeadImportSessionService,
    private readonly jobs: BackgroundJobsService,
  ) {}

  @Post()
  open(@Body() dto: OpenImportSessionDto, @CurrentUser() user: AuthUser) {
    return this.sessions.open(dto.totalRows, user);
  }

  /** Progress / result of a check, import or undo started below. */
  @Get('jobs/:jobId')
  job(@Param('jobId', ParseUUIDPipe) jobId: string, @CurrentUser() user: AuthUser) {
    return this.jobs.get(jobId, ['lead_import', 'lead_import_check', 'lead_import_undo'], { id: user.id, isManager: user.role === Role.admin });
  }

  @Post(':id/rows')
  @HttpCode(200)
  append(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AppendImportRowsDto, @CurrentUser() user: AuthUser) {
    return this.sessions.append(id, dto.start, dto.rows, user);
  }

  @Post(':id/check')
  @HttpCode(202)
  check(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CheckImportSessionDto, @CurrentUser() user: AuthUser) {
    return this.sessions.startCheck(
      id,
      {
        checkFields: dto.checkFields,
        ignorePhoneFormatting: dto.ignorePhoneFormatting,
        matchCompanyDomain: dto.matchCompanyDomain,
        matchLocation: dto.matchLocation,
      },
      user,
    );
  }

  @Get(':id/duplicates')
  duplicates(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query('limit', new DefaultValuePipe(200), ParseIntPipe) limit: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.sessions.duplicates(id, Math.max(0, offset), Math.min(Math.max(1, limit), 500), user);
  }

  @Post(':id/import')
  @HttpCode(202)
  run(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RunImportSessionDto, @CurrentUser() user: AuthUser) {
    return this.sessions.startImport(id, dto, user);
  }

  @Post(':id/undo')
  @HttpCode(202)
  undo(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.sessions.startUndo(id, user);
  }
}
