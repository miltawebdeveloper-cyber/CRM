import { Module } from '@nestjs/common';
import { OutcomesService } from './outcomes.service.js';
import { OutcomesController } from './outcomes.controller.js';

@Module({
  controllers: [OutcomesController],
  providers: [OutcomesService],
  exports: [OutcomesService],
})
export class OutcomesModule {}
