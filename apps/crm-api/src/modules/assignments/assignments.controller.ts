import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { AssignmentsService } from './assignments.service';
import { AssignmentCarryForwardService } from './assignment-carry-forward.service';
import { ManualAssignDto, AutoAssignDto, BatchAssignDto } from './dto/assignment.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

@ApiTags('assignments')
@ApiBearerAuth()
@Controller('assignments')
export class AssignmentsController {
  constructor(
    private readonly assignments: AssignmentsService,
    private readonly carryForward: AssignmentCarryForwardService,
  ) {}

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

  @Roles(Role.admin, Role.team_leader)
  @Post('auto')
  auto(@Body() dto: AutoAssignDto, @CurrentUser() user: AuthUser) {
    return this.assignments.auto(dto, user.id);
  }
}
