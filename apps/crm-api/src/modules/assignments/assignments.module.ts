import { Module } from '@nestjs/common';
import { AssignmentsService } from './assignments.service.js';
import { AssignmentCarryForwardService } from './assignment-carry-forward.service.js';
import { AssignmentsController } from './assignments.controller.js';

@Module({
  controllers: [AssignmentsController],
  providers: [AssignmentsService, AssignmentCarryForwardService],
})
export class AssignmentsModule {}
