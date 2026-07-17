import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { AssignmentsService } from './assignments.service';
import { ManualAssignDto, AutoAssignDto, BatchAssignDto } from './dto/assignment.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

@ApiTags('assignments')
@ApiBearerAuth()
@Controller('assignments')
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

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
