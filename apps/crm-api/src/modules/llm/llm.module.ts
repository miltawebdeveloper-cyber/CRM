import { Module } from '@nestjs/common';
import { LlmService } from './llm.service.js';
import { GroqService } from './groq.service.js';

@Module({
  providers: [LlmService, GroqService],
  exports: [LlmService, GroqService],
})
export class LlmModule {}
