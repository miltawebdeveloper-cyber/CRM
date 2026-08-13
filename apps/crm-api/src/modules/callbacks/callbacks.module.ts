import { Module } from '@nestjs/common';
import { CallbacksService } from './callbacks.service';
import { CallbackRolloverService } from './callback-rollover.service';
import { CallbacksController } from './callbacks.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [CallbacksController],
  providers: [CallbacksService, CallbackRolloverService],
  exports: [CallbacksService, CallbackRolloverService],
})
export class CallbacksModule {}
