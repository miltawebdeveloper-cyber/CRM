import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { TargetsService } from './targets.service.js';
import { UpsertTargetDto, ListTargetsQueryDto } from './dto/target.dto.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator.js';

@ApiTags('targets')
@ApiBearerAuth()
@Controller('targets')
export class TargetsController {
  constructor(private readonly targets: TargetsService) {}

  @Get()
  findAll(@Query() query: ListTargetsQueryDto) {
    return this.targets.findAll(query);
  }

  @Roles(Role.admin, Role.team_leader)
  @Post()
  upsert(@Body() dto: UpsertTargetDto, @CurrentUser() user: AuthUser) {
    return this.targets.upsert(dto, user.id);
  }

  @Roles(Role.admin)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.targets.remove(id);
  }
}
