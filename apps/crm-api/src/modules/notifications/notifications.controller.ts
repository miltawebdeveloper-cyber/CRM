import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { NotificationsService } from './notifications.service.js';
import { UpdateEmailSettingsDto } from './dto/email-settings.dto.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator.js';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  // ── Admin: configurable callback email settings (req 7) ──
  @Get('email-settings')
  @Roles(Role.admin)
  emailSettings() {
    return this.notifications.getEmailSettings();
  }

  @Put('email-settings')
  @Roles(Role.admin)
  updateEmailSettings(@Body() dto: UpdateEmailSettingsDto) {
    return this.notifications.updateEmailSettings({ recipients: dto.recipients, types: dto.types });
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.notifications.list(user.id);
  }

  @Get('unread-count')
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.notifications.unreadCount(user.id);
  }

  @Post(':id/read')
  markRead(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.notifications.markRead(id, user.id);
  }

  @Post('read-all')
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user.id);
  }
}
