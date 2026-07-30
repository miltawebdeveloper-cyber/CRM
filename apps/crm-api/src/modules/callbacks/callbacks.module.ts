import { Module } from '@nestjs/common';
import { CallbacksService } from './callbacks.service';
import { CallbacksController } from './callbacks.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [CallbacksController],
  providers: [CallbacksService],
  exports: [CallbacksService],
})
export class CallbacksModule {}
