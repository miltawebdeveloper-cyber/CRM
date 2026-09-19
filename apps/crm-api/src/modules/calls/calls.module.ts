import { Module } from '@nestjs/common';
import { CallsService } from './calls.service.js';
import { CallsController } from './calls.controller.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OutcomesModule } from '../outcomes/outcomes.module.js';
// Starting a call lives in CommunicationsService; this module reuses it rather
// than keeping a second, weaker implementation of the same thing.
import { CommunicationsModule } from '../communications/communications.module.js';

@Module({
  imports: [NotificationsModule, OutcomesModule, CommunicationsModule],
  controllers: [CallsController],
  providers: [CallsService],
  exports: [CallsService],
})
export class CallsModule {}
