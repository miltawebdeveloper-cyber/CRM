import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsHexColor, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LeadStatus, OutcomeCategory } from '@crm/database';

export class CreateOutcomeDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name: string;

  @ApiPropertyOptional({ description: 'Stable key stored on calls; auto-derived from name if omitted' })
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiPropertyOptional({ example: '#6b7359' })
  @IsOptional()
  @IsHexColor()
  color?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  schedulesCallback?: boolean;

  @ApiPropertyOptional({ description: 'Prompts a Zoom meeting to be scheduled on this outcome' })
  @IsOptional()
  @IsBoolean()
  schedulesZoom?: boolean;

  @ApiPropertyOptional({ enum: LeadStatus, nullable: true })
  @IsOptional()
  @IsString()
  leadStatus?: LeadStatus | null;

  @ApiPropertyOptional({ enum: OutcomeCategory, nullable: true, description: 'Calls Made funnel bucket; null leaves the status ungrouped' })
  @IsOptional()
  @IsEnum(OutcomeCategory)
  category?: OutcomeCategory | null;


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

export class UpdateOutcomeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsHexColor()
  color?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  schedulesCallback?: boolean;

  @ApiPropertyOptional({ description: 'Prompts a Zoom meeting to be scheduled on this outcome' })
  @IsOptional()
  @IsBoolean()
  schedulesZoom?: boolean;

  @ApiPropertyOptional({ enum: LeadStatus, nullable: true })
  @IsOptional()
  @IsString()
  leadStatus?: LeadStatus | null;

  @ApiPropertyOptional({ enum: OutcomeCategory, nullable: true, description: 'Calls Made funnel bucket; null leaves the status ungrouped' })
  @IsOptional()
  @IsEnum(OutcomeCategory)
  category?: OutcomeCategory | null;


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
