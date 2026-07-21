import { Module } from '@nestjs/common';
import { CallsService } from './calls.service';
import { CallsController } from './calls.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { OutcomesModule } from '../outcomes/outcomes.module';
// Starting a call lives in CommunicationsService; this module reuses it rather
// than keeping a second, weaker implementation of the same thing.
import { CommunicationsModule } from '../communications/communications.module';

@Module({
  imports: [NotificationsModule, OutcomesModule, CommunicationsModule],
  controllers: [CallsController],
  providers: [CallsService],
  exports: [CallsService],
})
export class CallsModule {}
