import { Body, Controller, Delete, Get, Param, Put, BadRequestException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { IntegrationConfigService } from './integration-config.service.js';
import { OpenPhoneService } from '../openphone/openphone.service.js';
import { ConnectOpenPhoneDto } from './dto/integration.dto.js';

/** Admin-managed integration credentials (entered from the UI, stored in DB). */
@ApiTags('integrations')
@ApiBearerAuth()
@Roles(Role.admin)
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly config: IntegrationConfigService,
    private readonly openphone: OpenPhoneService,
  ) {}

  @Get('status')
  status() {
    return this.config.status();
  }

  @Put('openphone')
  async connectOpenPhone(@Body() dto: ConnectOpenPhoneDto) {
    await this.config.set('openphone', { OPENPHONE_API_KEY: dto.apiKey, OPENPHONE_BASE_URL: dto.baseUrl, OPENPHONE_WEBHOOK_SECRET: dto.webhookSecret });
    // Verify immediately by probing the live API (lists workspace numbers).
    const probe = await this.openphone.status();
    return { ...this.config.status().openphone, connected: probe.connected, error: probe.error, phoneNumbers: probe.phoneNumbers };
  }

  @Delete(':provider')
  async disconnect(@Param('provider') provider: string) {
    if (provider !== 'openphone') throw new BadRequestException('Unknown provider');
    await this.config.clear(provider);
    return this.config.status();
  }
}
