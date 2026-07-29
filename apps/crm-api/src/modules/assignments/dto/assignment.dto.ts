import { ArrayNotEmpty, IsArray, IsBoolean, IsEnum, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Timezone } from '@crm/database';

/**
 * A lead has exactly one owner, so bulk assignment refuses to take a lead off the
 * employee already holding it. These two flags are the only ways past that, and
 * they're deliberately separate: `skipAssigned` means "assign the free ones, leave
 * the rest alone", `allowReassign` means "move ownership on purpose" (transfer).
 */
class AssignOwnershipFlags {
  @ApiPropertyOptional({ description: 'Assign the unowned leads and skip any already assigned elsewhere' })
  @IsOptional()
  @IsBoolean()
  skipAssigned?: boolean;

  @ApiPropertyOptional({ description: 'Deliberate transfer: move leads already owned by another employee' })
  @IsOptional()
  @IsBoolean()
  allowReassign?: boolean;

  /**
   * Go ahead even though some of these leads were already assigned today.
   *
   * The daily restriction is separate from ownership: `allowReassign` answers
   * "may this leave its current owner", this answers "may it move again today".
   * A lead can need both — it belongs to someone AND changed hands this morning
   * — and confirming one must not silently confirm the other, or the daily rule
   * would evaporate every time a manager ticked the transfer box.
   *
   * Without it a same-day move is refused with SAME_DAY_CONFIRM_CODE, which is
   * the client's cue to prompt. Sending it is the confirmation, and it is
   * recorded on each history row it applies to.
   */
  @ApiPropertyOptional({ description: 'Confirm reassignment of leads already assigned today' })
  @IsOptional()
  @IsBoolean()
  confirmSameDayReassign?: boolean;
}

export class ManualAssignDto extends AssignOwnershipFlags {
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
export class BatchAssignDto extends AssignOwnershipFlags {
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
