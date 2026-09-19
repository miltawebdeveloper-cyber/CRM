import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { ProductivityService, type Period } from './productivity.service.js';
import { Roles } from '../../common/decorators/roles.decorator.js';

@ApiTags('productivity')
@ApiBearerAuth()
@Controller('productivity')
export class ProductivityController {
  constructor(private readonly productivity: ProductivityService) {}

  @Roles(Role.admin, Role.team_leader)
  @Get()
  perCaller(@Query('period') period?: Period) {
    return this.productivity.perCaller(period === 'week' || period === 'month' ? period : 'day');
  }

  @Roles(Role.admin, Role.team_leader)
  @Get('daily-summary')
  dailySummary() {
    return this.productivity.dailySummary();
  }

  @Roles(Role.admin, Role.team_leader)
  @Get('team-live')
  teamLive() {
    return this.productivity.teamLive();
  }
}
