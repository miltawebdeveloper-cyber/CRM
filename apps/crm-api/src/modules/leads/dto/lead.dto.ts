import { ArrayNotEmpty, IsArray, IsBoolean, IsEmail, IsEnum, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Timezone, LeadStatus } from '@crm/database';

export class CreateLeadDto {
  @ApiPropertyOptional({ description: 'External lead id; auto-generated if omitted (IMP-006)' })
  @IsOptional()
  @IsString()
  leadId?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  businessName: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  phone: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty()
  @IsString()
  state: string;

  @ApiProperty()
  @IsString()
  city: string;

  @ApiPropertyOptional({ enum: Timezone, default: Timezone.EST })
  @IsOptional()
  @IsEnum(Timezone)
  timezone?: Timezone;

  @ApiPropertyOptional({ enum: LeadStatus, default: LeadStatus.new })
  @IsOptional()
  @IsEnum(LeadStatus)
  status?: LeadStatus;

  // ── Lead sheet fields ──
  @ApiPropertyOptional({ description: 'NAME — contact person at the company' })
  @IsOptional()
  @IsString()
  contactName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  industry?: string;

  @ApiPropertyOptional({ description: "TITLE — contact's job title" })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ description: 'Employee Code' })
  @IsOptional()
  @IsString()
  employeeCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  comments?: string;

  @ApiPropertyOptional({ description: 'LEAD CATEGORY' })
  @IsOptional()
  @IsString()
  leadCategory?: string;

  @ApiPropertyOptional({ description: 'NEXT FOLLOW UP DATE (ISO string)' })
  @IsOptional()
  @IsString()
  nextFollowUpDate?: string;

  @ApiPropertyOptional({ description: 'CALL STATUS' })
  @IsOptional()
  @IsString()
  callStatus?: string;

  @ApiPropertyOptional({ description: 'FIRST CONTACT (ISO string)' })
  @IsOptional()
  @IsString()
  firstContact?: string;

  @ApiPropertyOptional({ description: 'LAST CONTACT (ISO string)' })
  @IsOptional()
  @IsString()
  lastContact?: string;

  @ApiPropertyOptional({ description: 'FOLLOW-UP COUNT' })
  @IsOptional()
  followupCount?: number;

  @ApiPropertyOptional({ description: 'MEETING DATE (ISO string)' })
  @IsOptional()
  @IsString()
  meetingDate?: string;

  @ApiPropertyOptional({ description: 'LOST REASON' })
  @IsOptional()
  @IsString()
  lostReason?: string;

  @ApiPropertyOptional({ description: 'Lead Generation ID' })
  @IsOptional()
  @IsString()
  leadGenerationId?: string;

  @ApiPropertyOptional({ description: 'Lead Source' })
  @IsOptional()
  @IsString()
  leadSource?: string;

  @ApiPropertyOptional({ description: 'Contact Person 2' })
  @IsOptional()
  @IsString()
  contactName2?: string;

  @ApiPropertyOptional({ description: 'Alt Phone' })
  @IsOptional()
  @IsString()
  altPhone?: string;

  @ApiPropertyOptional({ description: 'Website' })
  @IsOptional()
  @IsString()
  website?: string;

  @ApiPropertyOptional({ description: 'Social Media' })
  @IsOptional()
  @IsString()
  socialMedia?: string;

  @ApiPropertyOptional({ description: 'Country' })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({ description: 'Company Size' })
  @IsOptional()
  @IsString()
  companySize?: string;

  @ApiPropertyOptional({ description: 'Founded Year' })
  @IsOptional()
  @IsString()
  foundedYear?: string;

  @ApiPropertyOptional({ description: 'Address' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ description: 'CALLER — resolved to a user by name or email' })
  @IsOptional()
  @IsString()
  caller?: string;
}

/**
 * Lead edit — every field optional. Managers may PATCH any subset; the service
 * diffs against the current record and writes a field-level activity per change.
 * `caller` (name/email) reassigns the lead; `leadId` is ignored (immutable).
 */
export class UpdateLeadDto extends PartialType(CreateLeadDto) {}

/** IMP-001/005 — bulk import. Rows are validated per-row in the service so a
 * single bad row never rejects the whole file; errors are returned per row. */
export class ImportLeadsDto {
  @ApiProperty({ type: [CreateLeadDto], description: 'Parsed rows from the uploaded Excel/CSV' })
  @IsArray()
  @ArrayNotEmpty()
  rows: CreateLeadDto[];
}

export class ListLeadsQueryDto {
  @ApiPropertyOptional({ enum: LeadStatus })
  @IsOptional()
  @IsEnum(LeadStatus)
  status?: LeadStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  state?: string;

  // Lead Management module: scope the result to the caller's own assigned leads
  // (for every role). Omit the flag to list all records.
  @ApiPropertyOptional({ description: 'Only leads assigned to the current user' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  mine?: boolean;

  // Splits the two lead modules. Omitting the flag returns closed and open
  // leads alike, which the Pipeline and Dashboard rely on.
  @ApiPropertyOptional({
    description:
      'true → only closed leads (Closed Leads module); false → exclude closed leads (Lead Management); omitted → both',
  })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : value === true || value === 'true'))
  @IsBoolean()
  closed?: boolean;

  /**
   * Max rows to return. The list used to be capped at a hardcoded 100, which
   * silently truncated Lead Management — you could never see, let alone
   * select-all and bulk-assign, a book bigger than 100 leads. Still bounded so a
   * caller can't ask for an unlimited scan.
   */
  @ApiPropertyOptional({ description: 'Max rows to return (default 1000, max 5000)' })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(5000)
  limit?: number;
}
