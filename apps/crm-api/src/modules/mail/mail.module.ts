import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service.js';

// Global so any module can inject MailService without re-importing.
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
