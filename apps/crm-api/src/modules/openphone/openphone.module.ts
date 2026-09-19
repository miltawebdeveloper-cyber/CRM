import { Module } from '@nestjs/common';
import { OpenPhoneClient } from './openphone.client.js';
import { OpenPhoneService } from './openphone.service.js';
import { OpenPhoneController } from './openphone.controller.js';

@Module({
  controllers: [OpenPhoneController],
  providers: [OpenPhoneClient, OpenPhoneService],
  exports: [OpenPhoneService],
})
export class OpenPhoneModule {}
