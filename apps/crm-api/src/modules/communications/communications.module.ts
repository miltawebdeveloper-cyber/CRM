import { Module } from '@nestjs/common';
import { CommunicationsService } from './communications.service';
import { CallHistoryService } from './call-history.service';
import { QuoSyncService } from './quo-sync.service';
import { CommunicationsController } from './communications.controller';
import { WebhooksController } from './webhooks.controller';
import { OpenPhoneModule } from '../openphone/openphone.module';

@Module({
  imports: [OpenPhoneModule],
  controllers: [CommunicationsController, WebhooksController],
  providers: [CommunicationsService, CallHistoryService, QuoSyncService],
  exports: [CommunicationsService, QuoSyncService],
})
export class CommunicationsModule {}
