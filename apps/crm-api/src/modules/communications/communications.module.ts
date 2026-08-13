import { Module } from '@nestjs/common';
import { CommunicationsService } from './communications.service';
import { CallHistoryService } from './call-history.service';
import { QuoSyncService } from './quo-sync.service';
import { CallInsightsService } from './call-insights.service';
import { CommunicationsController } from './communications.controller';
import { WebhooksController, QuoHookController } from './webhooks.controller';
import { OpenPhoneModule } from '../openphone/openphone.module';
import { LlmModule } from '../llm/llm.module';

// No LeadIdModule: nothing in here creates a lead any more. An unrecognised
// caller is logged as an unknown call, not minted as a lead.
@Module({
  imports: [OpenPhoneModule, LlmModule],
  controllers: [CommunicationsController, WebhooksController, QuoHookController],
  providers: [CommunicationsService, CallHistoryService, QuoSyncService, CallInsightsService],
  exports: [CommunicationsService, QuoSyncService, CallInsightsService],
})
export class CommunicationsModule {}
