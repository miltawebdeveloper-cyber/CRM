import { Module } from '@nestjs/common';
import { TimezonesService } from './timezones.service.js';
import { TimezonesController } from './timezones.controller.js';
import { TimezonesCacheService } from './timezones-cache.service.js';

@Module({
  controllers: [TimezonesController],
  providers: [TimezonesService, TimezonesCacheService],
  exports: [TimezonesService, TimezonesCacheService],
})
export class TimezonesModule {}
