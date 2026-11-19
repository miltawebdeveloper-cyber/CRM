import { IsEmail, IsEnum, IsOptional, IsString, MinLength, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Role } from '@crm/database';
import { IsTimezoneCode } from '../../../common/validators/is-timezone-code.validator.js';

export class CreateUserDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty({ example: 'caller11@crm.local' })
  @IsEmail()
  email: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiProperty({ enum: Role, example: Role.employee })
  @IsEnum(Role)
  role: Role;

  @ApiPropertyOptional({ example: '+15551234567', description: 'OpenPhone number this caller sends SMS / dials from (E.164)' })
  @IsOptional()
  @IsString()
  openphoneNumber?: string;

  @ApiPropertyOptional({ example: 'EST', description: 'Employees only — the zone their shift runs on; its country follows from the zone' })
  @IsOptional()
  @IsTimezoneCode()
  shiftTimezone?: string;
}

export class UpdateUserDto extends PartialType(CreateUserDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ example: '09:00', description: 'Shift start (HH:mm); enables no-login auto-reassignment' })
  @IsOptional()
  @IsString()
  shiftStart?: string;
}

export class ListUsersQueryDto {
  @ApiPropertyOptional({ enum: Role })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  // A query string is always text, so `?isActive=true` arrived as the STRING
  // "true" and failed @IsBoolean with a 400 — the filter could never be used.
  // (A plain Boolean() cast would be worse: "false" is a truthy string.)
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value))
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Country.code — employees whose shift zone belongs to it' })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({ description: 'Employees on this shift zone' })
  @IsOptional()
  @IsTimezoneCode()
  timezone?: string;
}
