import { Module } from '@nestjs/common';
import { AvailabilityService } from './availability.service';
import { AvailabilityController } from './availability.controller';

// NotificationsModule is no longer imported: the only thing here that notified
// anyone was the automatic reassignment, which has been removed. Availability is
// now a plain status and tells nobody anything on its own.
@Module({
  controllers: [AvailabilityController],
  providers: [AvailabilityService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
