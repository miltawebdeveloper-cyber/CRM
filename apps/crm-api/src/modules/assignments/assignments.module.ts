import { Module } from '@nestjs/common';
import { AssignmentsService } from './assignments.service.js';
import { AssignmentCarryForwardService } from './assignment-carry-forward.service.js';
import { AssignmentsController } from './assignments.controller.js';
import { PendingCallsService } from './pending-calls.service.js';

@Module({
  controllers: [AssignmentsController],
  providers: [AssignmentsService, AssignmentCarryForwardService, PendingCallsService],
})
export class AssignmentsModule {}
