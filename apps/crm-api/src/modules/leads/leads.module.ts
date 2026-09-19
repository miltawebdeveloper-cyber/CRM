import { Module } from '@nestjs/common';
import { LeadsService } from './leads.service.js';
import { LeadsController } from './leads.controller.js';
import { QuoModule } from '../quo/quo.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { LeadIdModule } from './lead-id.module.js';

@Module({
  imports: [QuoModule, NotificationsModule, LeadIdModule],
  controllers: [LeadsController],
  providers: [LeadsService],
  exports: [LeadsService],
})
export class LeadsModule {}
