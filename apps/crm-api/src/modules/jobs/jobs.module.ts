import { Global, Module } from '@nestjs/common';
import { BackgroundJobsService } from './background-jobs.service.js';

/** Background jobs (lead import, Quo sync-all). Global: any module may start one. */
@Global()
@Module({
  providers: [BackgroundJobsService],
  exports: [BackgroundJobsService],
})
export class JobsModule {}
