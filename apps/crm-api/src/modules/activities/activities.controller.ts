import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ActivitiesService } from './activities.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@crm/database';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('activities')
@ApiBearerAuth()
@Controller('activities')
export class ActivitiesController {
  constructor(private readonly activities: ActivitiesService) {}

  @Roles(Role.admin, Role.team_leader)
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('limit') limit?: string) {
    return this.activities.list(user, limit ? Number(limit) : 100);
  }

  // Lead History is Admin + Team Leader only; employees have no access at all.
  @Roles(Role.admin, Role.team_leader)
  @Get('lead/:leadId')
  listLead(@Param('leadId') leadId: string, @CurrentUser() user: AuthUser, @Query('limit') limit?: string) {
    return this.activities.listLead(leadId, user, limit ? Number(limit) : 100);
  }
}
