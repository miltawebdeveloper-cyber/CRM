import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZoomService } from './zoom.service.js';
import { CompleteZoomMeetingDto, CreateZoomMeetingDto, UpdateZoomMeetingDto, ZoomQueryDto } from './dto/zoom.dto.js';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator.js';

/**
 * Every route that names a meeting or a lead checks the caller may reach it
 * first (ZoomService.assertAccess): managers any; an employee their own
 * meetings and meetings on leads they hold. Refused and missing both answer 404.
 */
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
  async byLead(@Param('leadId') leadId: string, @CurrentUser() user: AuthUser) {
    await this.zoom.assertLeadAccess(leadId, user);
    return this.zoom.byLead(leadId);
  }

  // Audit trail for a single meeting.
  @Get('meetings/:id/activities')
  async activities(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.zoom.assertAccess(id, user);
    return this.zoom.activities(id);
  }

  @Get('meetings/:id')
  async get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.zoom.assertAccess(id, user);
    return this.zoom.get(id);
  }

  @Post('meetings')
  create(@Body() dto: CreateZoomMeetingDto, @CurrentUser() user: AuthUser) {
    return this.zoom.create(dto, user.id, user.role);
  }

  @Patch('meetings/:id')
  async update(@Param('id') id: string, @Body() dto: UpdateZoomMeetingDto, @CurrentUser() user: AuthUser) {
    await this.zoom.assertAccess(id, user);
    return this.zoom.update(id, dto, user.id);
  }

  @Post('meetings/:id/start')
  async start(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.zoom.assertAccess(id, user);
    return this.zoom.start(id, user.id);
  }

  @Post('meetings/:id/complete')
  async complete(@Param('id') id: string, @Body() dto: CompleteZoomMeetingDto, @CurrentUser() user: AuthUser) {
    await this.zoom.assertAccess(id, user);
    return this.zoom.complete(id, dto, user.id);
  }

  @Post('meetings/:id/cancel')
  async cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.zoom.assertAccess(id, user);
    return this.zoom.cancel(id, user.id);
  }

  // Deleting is narrower than editing: a manager, or the meeting's organiser.
  @Delete('meetings/:id')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.zoom.assertAccess(id, user, { organizerOnly: true });
    return this.zoom.remove(id);
  }
}
