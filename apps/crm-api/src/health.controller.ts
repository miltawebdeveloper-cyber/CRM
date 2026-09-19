import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from './common/decorators/public.decorator.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  // DEP-002 — health check returns 200
  @Public()
  @Get()
  check() {
    return { status: 'ok', ts: new Date().toISOString() };
  }
}


