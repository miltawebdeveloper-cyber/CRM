import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { AssignmentsService } from './assignments.service.js';
import { AssignmentCarryForwardService } from './assignment-carry-forward.service.js';
import { PendingCallsService } from './pending-calls.service.js';
import { ManualAssignDto, AutoAssignDto, BatchAssignDto, UnassignDto, PendingModeDto, PendingQueryDto, RescheduleDto } from './dto/assignment.dto.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator.js';

@ApiTags('assignments')
@ApiBearerAuth()
@Controller('assignments')
export class AssignmentsController {
  constructor(
    private readonly assignments: AssignmentsService,
    private readonly carryForward: AssignmentCarryForwardService,
    private readonly pending: PendingCallsService,
  ) {}

  /**
   * What happens to a call nobody finished on its day: `automatic` (moves to the
   * next working day, same employee) or `manual` (waits for a manager on Pending
   * Calls). Readable by everyone — the Calling Panel says which is in force.
   */
  @Get('pending-mode')
  pendingMode() {
    return this.pending.mode().then((mode) => ({ mode }));
  }

  /** Only admins and team leaders choose. */
  @Roles(Role.admin, Role.team_leader)
  @Put('pending-mode')
  setPendingMode(@Body() dto: PendingModeDto, @CurrentUser() user: AuthUser) {
    return this.pending.setMode(dto.mode, user.id).then((mode) => ({ mode }));
  }

  /** Assigned calls whose day passed unfinished, employee-wise and date-wise. */
  @Roles(Role.admin, Role.team_leader)
  @Get('pending')
  pendingCalls(@Query() q: PendingQueryDto) {
    return this.pending.list(q.callerId);
  }

  /** Give pending calls to the same employee or another, for a new day. */
  @Roles(Role.admin, Role.team_leader)
  @Post('pending/reschedule')
  reschedule(@Body() dto: RescheduleDto, @CurrentUser() user: AuthUser) {
    return this.pending.reschedule(dto, user.id);
  }

  /**
   * How many unfinished leads the carry-forward would move into their new day.
   * Read-only, so it can be checked without changing anything.
   */
  @Roles(Role.admin, Role.team_leader)
  @Get('carry-forward')
  carryForwardPreview() {
    return this.carryForward.preview().then((pending) => ({ pending }));
  }

  /**
   * Run the carry-forward now rather than waiting for 1am — for the first run
   * after deploying, and for a morning the cron didn't fire. Idempotent: leads
   * already stamped for today are skipped, so a second click carries nothing.
   */
  @Roles(Role.admin)
  @Post('carry-forward')
  runCarryForward() {
    return this.carryForward.run();
  }

  @Roles(Role.admin, Role.team_leader)
  @Get('summary')
  summary() {
    return this.assignments.summary();
  }

  @Roles(Role.admin, Role.team_leader)
  @Post()
  manual(@Body() dto: ManualAssignDto, @CurrentUser() user: AuthUser) {
    return this.assignments.manual(dto, user.id);
  }

  @Roles(Role.admin, Role.team_leader)
  @Post('batch')
  batch(@Body() dto: BatchAssignDto, @CurrentUser() user: AuthUser) {
    return this.assignments.batch(dto, user.id);
  }

  /** Return leads to the unassigned pool. See AssignmentsService.unassign. */
  @Roles(Role.admin, Role.team_leader)
  @Post('unassign')
  unassign(@Body() dto: UnassignDto, @CurrentUser() user: AuthUser) {
    return this.assignments.unassign(dto.leadIds, user.id);
  }

  @Roles(Role.admin, Role.team_leader)
  @Post('auto')
  auto(@Body() dto: AutoAssignDto, @CurrentUser() user: AuthUser) {
    return this.assignments.auto(dto, user.id);
  }
}
