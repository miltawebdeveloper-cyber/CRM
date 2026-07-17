import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { CallsService } from './calls.service';
import { CallPivotQueryDto, CallStatsQueryDto, SetCallTargetDto, StartCallDto, EndCallDto, CreateNoteDto, UpdateFollowupDto } from './dto/call.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

@ApiTags('calls')
@ApiBearerAuth()
@Controller('calls')
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  // CAL-001..005 — caller dashboard KPIs for the logged-in caller
  @Get('caller/dashboard')
  callerDashboard(@CurrentUser() user: AuthUser) {
    return this.calls.callerDashboard(user.id);
  }

  // CAL-006 — caller's assigned lead queue
  @Get('caller/leads')
  myLeads(@CurrentUser() user: AuthUser) {
    return this.calls.myLeads(user.id);
  }

  // CAL-016 — next unworked assigned lead
  @Get('next-lead')
  nextLead(@CurrentUser() user: AuthUser) {
    return this.calls.nextLead(user.id);
  }

  // CAL-013 — upcoming follow-ups. Employees are scoped to their own; managers
  // see all and may filter by a specific caller (?userId=).
  @Get('followups')
  followups(@CurrentUser() user: AuthUser, @Query('userId') userId?: string) {
    return this.calls.followups({ id: user.id, role: user.role }, userId);
  }

  @Post('followups/:kind/:id/complete')
  completeFollowup(@Param('kind') kind: 'note' | 'lead', @Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.calls.completeFollowup(kind, id, user.id);
  }

  @Post('followups/:kind/:id')
  updateFollowup(
    @Param('kind') kind: 'note' | 'lead',
    @Param('id') id: string,
    @Body() dto: UpdateFollowupDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.calls.updateFollowup(kind, id, dto, user.id);
  }

  @Get('outcomes')
  outcomes(
    @CurrentUser() user: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('outcome') outcome?: string,
    @Query('userId') userId?: string,
  ) {
    return this.calls.outcomes({ from, to, outcome, userId }, { id: user.id, role: user.role });
  }

  // Calls Made dashboard — stats and the detail rows behind them. Both are
  // scoped in the service: employees see only their own calls, managers see
  // everyone and may narrow with ?userId=.
  @Get('made/stats')
  callsMadeStats(@Query() query: CallStatsQueryDto, @CurrentUser() user: AuthUser) {
    return this.calls.callsMadeStats(query, { id: user.id, role: user.role });
  }

  @Get('made/records')
  callsMadeRecords(@Query() query: CallStatsQueryDto, @CurrentUser() user: AuthUser) {
    return this.calls.callsMadeRecords(query, { id: user.id, role: user.role });
  }

  // The selected rep's lead book — assigned / completed / balance. Not date-
  // filtered: it counts leads held now, not calls made in a range.
  @Get('made/leads')
  leadBook(@CurrentUser() user: AuthUser, @Query('userId') userId?: string) {
    return this.calls.leadBook(userId, { id: user.id, role: user.role });
  }

  // Cross-tab of the same calls: ?rows= and ?cols= pick the two dimensions.
  @Get('made/pivot')
  callsMadePivot(@Query() query: CallPivotQueryDto, @CurrentUser() user: AuthUser) {
    return this.calls.callsMadePivot(query, { id: user.id, role: user.role });
  }

  // Per-employee call target behind the dashboard's target dial. Reps may read
  // their own; only managers may set one (for anybody).
  @Get('made/target/:userId')
  getCallTarget(@Param('userId') userId: string, @CurrentUser() user: AuthUser) {
    const isManager = user.role === Role.admin || user.role === Role.team_leader;
    if (!isManager && userId !== user.id) throw new ForbiddenException('Not your target');
    return this.calls.getCallTarget(userId);
  }

  @Roles(Role.admin, Role.team_leader)
  @Patch('made/target/:userId')
  setCallTarget(@Param('userId') userId: string, @Body() dto: SetCallTargetDto) {
    return this.calls.setCallTarget(userId, dto);
  }

  // CAL-015 — call + note history for a lead
  @Get()
  history(@Query('leadId') leadId: string) {
    return this.calls.history(leadId);
  }

  @Post('start')
  start(@Body() dto: StartCallDto, @CurrentUser() user: AuthUser) {
    return this.calls.start(dto, user.id);
  }

  @Post(':id/end')
  end(@Param('id') id: string, @Body() dto: EndCallDto, @CurrentUser() user: AuthUser) {
    return this.calls.end(id, dto, user.id);
  }

  @Post(':id/notes')
  addNote(@Param('id') id: string, @Body() dto: CreateNoteDto, @CurrentUser() user: AuthUser) {
    return this.calls.addNoteToCall(id, dto, user.id);
  }
}
