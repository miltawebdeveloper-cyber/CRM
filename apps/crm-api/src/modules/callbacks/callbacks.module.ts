import { Module } from '@nestjs/common';
import { CallbacksService } from './callbacks.service.js';
import { CallbackRolloverService } from './callback-rollover.service.js';
import { CallbacksController } from './callbacks.controller.js';
import { NotificationsModule } from '../notifications/notifications.module.js';

@Module({
  imports: [NotificationsModule],
  controllers: [CallbacksController],
  providers: [CallbacksService, CallbackRolloverService],
  exports: [CallbacksService, CallbackRolloverService],
})
export class CallbacksModule {}
