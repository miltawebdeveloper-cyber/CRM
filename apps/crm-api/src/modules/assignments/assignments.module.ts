import { Module } from '@nestjs/common';
import { AssignmentsService } from './assignments.service';
import { AssignmentCarryForwardService } from './assignment-carry-forward.service';
import { AssignmentsController } from './assignments.controller';

@Module({
  controllers: [AssignmentsController],
  providers: [AssignmentsService, AssignmentCarryForwardService],
})
export class AssignmentsModule {}
