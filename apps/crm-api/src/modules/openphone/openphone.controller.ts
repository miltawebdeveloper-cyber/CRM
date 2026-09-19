import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { OpenPhoneService } from './openphone.service.js';
import { SendOpenPhoneSmsDto } from './dto/openphone.dto.js';

@ApiTags('openphone')
@ApiBearerAuth()
@Controller('openphone')
export class OpenPhoneController {
  constructor(private readonly openphone: OpenPhoneService) {}

  /** Live connection status + provisioned numbers (admin / team leader). */
  @Roles(Role.admin, Role.team_leader)
  @Get('status')
  status() {
    return this.openphone.status();
  }

  @Roles(Role.admin, Role.team_leader)
  @Post('messages')
  send(@Body() dto: SendOpenPhoneSmsDto) {
    return this.openphone.sendSms({ from: dto.from, to: [dto.to], content: dto.content });
  }
}
