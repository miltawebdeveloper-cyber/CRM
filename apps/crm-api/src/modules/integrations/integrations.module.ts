import { Module } from '@nestjs/common';
import { IntegrationConfigService } from './integration-config.service.js';
import { IntegrationsController } from './integrations.controller.js';
import { OpenPhoneModule } from '../openphone/openphone.module.js';

@Module({
  imports: [OpenPhoneModule],
  controllers: [IntegrationsController],
  providers: [IntegrationConfigService],
  exports: [IntegrationConfigService],
})
export class IntegrationsModule {}
