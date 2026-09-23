import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsTimezoneCode } from '../../../common/validators/is-timezone-code.validator.js';

export class UpsertTargetDto {
  @ApiProperty()
  @IsString()
  state: string;

  @ApiProperty()
  @IsString()
  city: string;

  @ApiProperty({ description: 'A time zone code, see GET /timezones' })
  @IsTimezoneCode()
  timezone: string;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  monthlyTarget: number;
}

export class ListTargetsQueryDto {
  @ApiPropertyOptional({ description: 'A time zone code, see GET /timezones' })
  @IsOptional()
  @IsTimezoneCode()
  timezone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  state?: string;
}
