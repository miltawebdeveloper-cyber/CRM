import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MetricsService } from './metrics.service.js';
import { MetricsQueryDto } from './dto/metrics.dto.js';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator.js';

@ApiTags('metrics')
@ApiBearerAuth()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('summary')
  summary(@Query() q: MetricsQueryDto, @CurrentUser() user: AuthUser) {
    return this.metrics.summary(q, user);
  }

  @Get('by-timezone')
  byTimezone(@Query() q: MetricsQueryDto, @CurrentUser() user: AuthUser) {
    return this.metrics.byTimezone(q, user);
  }

  @Get('by-state')
  byState(@Query() q: MetricsQueryDto, @CurrentUser() user: AuthUser) {
    return this.metrics.byState(q, user);
  }

  @Get('daily')
  daily(@Query() q: MetricsQueryDto, @CurrentUser() user: AuthUser) {
    return this.metrics.daily(q, user);
  }

  @Get('bar')
  bar(@Query() q: MetricsQueryDto, @CurrentUser() user: AuthUser) {
    return this.metrics.bar(q, user);
  }

  @Get('pivot')
  pivot(@Query() q: MetricsQueryDto, @CurrentUser() user: AuthUser) {
    return this.metrics.pivot(q, user);
  }
}
