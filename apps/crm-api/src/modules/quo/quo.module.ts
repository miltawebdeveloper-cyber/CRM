import { Module } from '@nestjs/common';
import { QuoService } from './quo.service.js';
import { OpenPhoneModule } from '../openphone/openphone.module.js';

@Module({
  imports: [OpenPhoneModule],
  providers: [QuoService],
  exports: [QuoService],
})
export class QuoModule {}
