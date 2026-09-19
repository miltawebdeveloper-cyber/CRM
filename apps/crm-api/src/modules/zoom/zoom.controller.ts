import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZoomService } from './zoom.service.js';
import { CompleteZoomMeetingDto, CreateZoomMeetingDto, UpdateZoomMeetingDto, ZoomQueryDto } from './dto/zoom.dto.js';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator.js';

@ApiTags('zoom')
@ApiBearerAuth()
@Controller('zoom')
export class ZoomController {
  constructor(private readonly zoom: ZoomService) {}

  // Dashboard list (scoped to caller for employees, all for managers).
  @Get('meetings')
  list(@Query() query: ZoomQueryDto, @CurrentUser() user: AuthUser) {
    return this.zoom.dashboard(query, { id: user.id, role: user.role });
  }

  // Call Panel — today's pending meetings for the logged-in caller.
  @Get('meetings/due')
  due(@CurrentUser() user: AuthUser) {
    return this.zoom.dueToday(user.id);
  }

  // Full meeting history/timeline for one client.
  @Get('meetings/lead/:leadId')
  byLead(@Param('leadId') leadId: string) {
    return this.zoom.byLead(leadId);
  }

  // Audit trail for a single meeting.
  @Get('meetings/:id/activities')
  activities(@Param('id') id: string) {
    return this.zoom.activities(id);
  }

  @Get('meetings/:id')
  get(@Param('id') id: string) {
    return this.zoom.get(id);
  }

  @Post('meetings')
  create(@Body() dto: CreateZoomMeetingDto, @CurrentUser() user: AuthUser) {
    return this.zoom.create(dto, user.id);
  }

  @Patch('meetings/:id')
  update(@Param('id') id: string, @Body() dto: UpdateZoomMeetingDto, @CurrentUser() user: AuthUser) {
    return this.zoom.update(id, dto, user.id);
  }

  @Post('meetings/:id/start')
  start(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.zoom.start(id, user.id);
  }

  @Post('meetings/:id/complete')
  complete(@Param('id') id: string, @Body() dto: CompleteZoomMeetingDto, @CurrentUser() user: AuthUser) {
    return this.zoom.complete(id, dto, user.id);
  }

  @Post('meetings/:id/cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.zoom.cancel(id, user.id);
  }

  @Delete('meetings/:id')
  remove(@Param('id') id: string) {
    return this.zoom.remove(id);
  }
}
