import { Module } from '@nestjs/common';
import { TargetsService } from './targets.service.js';
import { TargetsController } from './targets.controller.js';

@Module({
  controllers: [TargetsController],
  providers: [TargetsService],
})
export class TargetsModule {}
