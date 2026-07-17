import { ArrayNotEmpty, IsArray, IsEnum, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Timezone } from '@crm/database';

export class ManualAssignDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  leadIds: string[];

  @ApiProperty()
  @IsUUID()
  callerId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  batchName?: string;
}

/** One employee's slice of a manual batch allocation. */
export class AssignAllocationDto {
  @ApiProperty()
  @IsUUID()
  callerId: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  leadIds: string[];
}

/**
 * Manual multi-employee distribution: each allocation names a caller and the
 * exact set of leads they receive. Leads must be unique across allocations.
 */
export class BatchAssignDto {
  @ApiProperty({ type: [AssignAllocationDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => AssignAllocationDto)
  allocations: AssignAllocationDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  batchName?: string;
}

export enum AssignStrategy {
  equal = 'equal',
  state = 'state',
  timezone = 'timezone',
}

export class AutoAssignDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  callerIds: string[];

  @ApiProperty({ enum: AssignStrategy })
  @IsEnum(AssignStrategy)
  strategy: AssignStrategy;

  @ApiPropertyOptional({ enum: Timezone, description: 'Only assign leads in this timezone' })
  @IsOptional()
  @IsEnum(Timezone)
  timezone?: Timezone;

  @ApiPropertyOptional({ description: 'Only assign leads in this state' })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  batchName?: string;
}
