import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AiService } from './ai.service.js';
import { ChatDto } from './dto/ai.dto.js';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator.js';

@ApiTags('ai')
@ApiBearerAuth()
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Post('chat')
  chat(@Body() dto: ChatDto, @CurrentUser() user: AuthUser) {
    return this.ai.chat(dto.question, user.id);
  }

  @Get('sessions')
  sessions(@CurrentUser() user: AuthUser) {
    return this.ai.sessions(user.id);
  }

  @Get('insights')
  insights() {
    return this.ai.insights();
  }
}
