import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, MinLength, Validate, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// `Intl.supportedValuesOf('timeZone')` would need a newer lib target than
// this project builds with, so validity is checked the same way the web
// admin form pre-validates client-side: constructing a formatter with the
// zone and letting the runtime itself reject anything it doesn't recognize.
@ValidatorConstraint({ name: 'isIanaTimezone', async: false })
class IsIanaTimezoneConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    if (typeof value !== 'string' || !value) return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }
  defaultMessage() {
    return 'ianaZone must be a recognized IANA time zone name';
  }
}

export class CreateTimezoneDto {
  @ApiProperty({ description: 'Short code stored on Lead.timezone / Target.timezone / Employee.shiftTimezone, e.g. "EST"' })
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  code: string;

  @ApiProperty({ description: 'Display label, e.g. "EST (Eastern Standard Time)"' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  label: string;

  @ApiProperty({ description: 'IANA zone name, e.g. "America/New_York"' })
  @IsString()
  @Validate(IsIanaTimezoneConstraint)
  ianaZone: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// `code` and `ianaZone` are deliberately not here — both are referenced by
// existing leads/targets/employees going forward, and editing either after
// the fact would retroactively change how a past callback/call is understood
// to have been timed. Only `label` (display-only) and `isActive` are safe to
// change post-creation, matching Country's own edit surface.
export class UpdateTimezoneDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  label?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
