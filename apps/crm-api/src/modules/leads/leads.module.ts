import { Module } from '@nestjs/common';
import { LeadsService } from './leads.service.js';
import { LeadsController } from './leads.controller.js';
import { LeadImportController } from './lead-import.controller.js';
import { LeadImportSessionService } from './lead-import-session.service.js';
import { QuoModule } from '../quo/quo.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { LeadIdModule } from './lead-id.module.js';

@Module({
  imports: [QuoModule, NotificationsModule, LeadIdModule],
  // The chunked import's routes first: `leads/import/sessions/…` must not be
  // read as a lead id by LeadsController's `:id` routes.
  controllers: [LeadImportController, LeadsController],
  providers: [LeadsService, LeadImportSessionService],
  exports: [LeadsService],
})
export class LeadsModule {}
