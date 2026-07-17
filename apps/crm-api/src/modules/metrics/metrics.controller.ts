import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MetricsService } from './metrics.service';
import { MetricsQueryDto } from './dto/metrics.dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

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
  byTimezone(@Query() q: MetricsQueryDto) {
    return this.metrics.byTimezone(q);
  }

  @Get('by-state')
  byState(@Query() q: MetricsQueryDto) {
    return this.metrics.byState(q);
  }

  @Get('daily')
  daily(@Query() q: MetricsQueryDto) {
    return this.metrics.daily(q);
  }

  @Get('bar')
  bar(@Query() q: MetricsQueryDto) {
    return this.metrics.bar(q);
  }

  @Get('pivot')
  pivot(@Query() q: MetricsQueryDto) {
    return this.metrics.pivot(q);
  }
}
