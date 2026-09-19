import { Module } from '@nestjs/common';
import { ZoomService } from './zoom.service.js';
import { ZoomController } from './zoom.controller.js';
import { ZoomRemindersService } from './zoom-reminders.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';

@Module({
  imports: [NotificationsModule],
  controllers: [ZoomController],
  providers: [ZoomService, ZoomRemindersService],
  exports: [ZoomService],
})
export class ZoomModule {}
