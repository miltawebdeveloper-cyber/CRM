import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { TimezonesService } from './timezones.service.js';
import { CreateTimezoneDto, UpdateTimezoneDto } from './dto/timezone.dto.js';
import { Roles } from '../../common/decorators/roles.decorator.js';

@ApiTags('timezones')
@ApiBearerAuth()
@Controller('timezones')
export class TimezonesController {
  constructor(private readonly timezones: TimezonesService) {}

  // Every zone, inactive included, for any authenticated user. Unlike
  // countries, the web needs retired zones too: a lead still on one must keep
  // rendering on its real clock. Pickers filter to `isActive` client-side.
  @Get()
  list() {
    return this.timezones.listAll();
  }

  // Full list incl. inactive — admin management screen.
  @Get('all')
  @Roles(Role.admin)
  listAll() {
    return this.timezones.listAll();
  }

  @Post()
  @Roles(Role.admin)
  create(@Body() dto: CreateTimezoneDto) {
    return this.timezones.create(dto);
  }

  // No delete route — a zone is deactivated (PATCH isActive: false), never
  // removed, since an existing lead/target/employee may still reference it.
  @Patch(':id')
  @Roles(Role.admin)
  update(@Param('id') id: string, @Body() dto: UpdateTimezoneDto) {
    return this.timezones.update(id, dto);
  }
}
