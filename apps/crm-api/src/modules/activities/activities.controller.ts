import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ActivitiesService } from './activities.service.js';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Role } from '@crm/database';
import { Roles } from '../../common/decorators/roles.decorator.js';

@ApiTags('activities')
@ApiBearerAuth()
@Controller('activities')
export class ActivitiesController {
  constructor(private readonly activities: ActivitiesService) {}

  /**
   * The Activity Tracker feed — open to every role, scoped in the service.
   *
   * This was admin + team-leader only, while the menu item carrying it was shown
   * to everyone: an employee clicked Activity Tracker, the request 403'd, the
   * page swallowed it (`retry: false`) and they got an empty log that looked like
   * a day in which they had done nothing.
   *
   * The scoping to fix that was already written and had never been reachable —
   * `list` narrows an employee to their own `userId`, which was dead code behind
   * this guard. Removing the guard is what turns it on. An employee sees their
   * own activity, managers see the floor.
   */
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
