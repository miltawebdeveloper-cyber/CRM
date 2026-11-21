import { IsBoolean, IsIn, IsOptional, IsString, IsDateString } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsTimezoneCode } from '../../../common/validators/is-timezone-code.validator.js';

/** Shared dashboard filter (FLT-001..005). */
export class MetricsQueryDto {
  @ApiPropertyOptional({ description: 'A time zone code, see GET /timezones' })
  @IsOptional()
  @IsTimezoneCode()
  timezone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ description: 'ISO date — range start (see dateField)' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO date — range end (see dateField)' })
  @IsOptional()
  @IsDateString()
  to?: string;

  /**
   * Which lead date `from`/`to` count against — the same choice Lead Management
   * offers its grid, so the KPI cards above the table keep answering for the
   * same set of leads the table below is showing.
   *
   * `created` (default) = when the lead was created; `scheduled` = the day its
   * active assignment puts it on the queue for, which is what the overnight
   * carry-forward moves. Only the LEAD counts follow it: calls are counted on
   * when the call happened either way, which is a fact about the call.
   */
  @ApiPropertyOptional({ description: 'created (default) | scheduled — which lead date from/to apply to' })
  @IsOptional()
  @IsIn(['created', 'scheduled'])
  dateField?: 'created' | 'scheduled';

  /**
   * Also return the same figures for the period just before `from`–`to`, the
   * same number of days long — the dashboard's ▲/▼ badges. Needs both bounds;
   * without them there is no period to compare.
   */
  @ApiPropertyOptional({ description: 'true to also return the previous period (needs from and to)' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  compare?: boolean;
}
