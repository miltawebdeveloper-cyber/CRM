import { Module } from '@nestjs/common';
import { LlmService } from './llm.service';
import { GroqService } from './groq.service';

@Module({
  providers: [LlmService, GroqService],
  exports: [LlmService, GroqService],
})
export class LlmModule {}
