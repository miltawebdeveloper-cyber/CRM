import { Module } from '@nestjs/common';
import { CommunicationsService } from './communications.service.js';
import { CallHistoryService } from './call-history.service.js';
import { QuoSyncService } from './quo-sync.service.js';
import { CallInsightsService } from './call-insights.service.js';
import { CommunicationsController } from './communications.controller.js';
import { WebhooksController, QuoHookController } from './webhooks.controller.js';
import { OpenPhoneModule } from '../openphone/openphone.module.js';
import { LlmModule } from '../llm/llm.module.js';

// No LeadIdModule: nothing in here creates a lead any more. An unrecognised
// caller is logged as an unknown call, not minted as a lead.
@Module({
  imports: [OpenPhoneModule, LlmModule],
  controllers: [CommunicationsController, WebhooksController, QuoHookController],
  providers: [CommunicationsService, CallHistoryService, QuoSyncService, CallInsightsService],
  exports: [CommunicationsService, QuoSyncService, CallInsightsService],
})
export class CommunicationsModule {}
