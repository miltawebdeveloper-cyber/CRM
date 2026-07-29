import { ArrayNotEmpty, IsArray, IsBoolean, IsEmail, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min, MinLength } from 'class-validator';
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

  // Labelled "Designation" in the UI. The column keeps its original name so the
  // stored data and every existing integration keep working without a migration.
  @ApiPropertyOptional({ description: 'Designation (stored as contactName2)' })
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
/**
 * Bulk delete. Also carries an import rollback: the import response hands back the
 * ids it created, and sending exactly those removes that batch and nothing else.
 */
export class BulkDeleteLeadsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  ids: string[];
}

export class ImportLeadsDto {
  @ApiProperty({ type: [CreateLeadDto], description: 'Parsed rows from the uploaded Excel/CSV' })
  @IsArray()
  @ArrayNotEmpty()
  rows: CreateLeadDto[];

  /**
   * Leave out rows that duplicate an existing lead (or an earlier row in the file)
   * by Company Name, Phone or Email. Set from the duplicate-warning dialog's "Skip
   * Duplicate Leads"; "Import Anyway" sends it false/absent.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  skipDuplicates?: boolean;

  /** Row indexes in `rows` to explicitly skip during import. */
  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  skipRowIndexes?: number[];

  /** Validation fields to use for duplicate check: businessName, phone, email. */
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  checkFields?: string[];
}

/** Body for the pre-import duplicate check — parsed rows and optional duplicate validation fields. */
export class CheckImportDto {
  @ApiProperty({ type: [CreateLeadDto] })
  @IsArray()
  @ArrayNotEmpty()
  rows: CreateLeadDto[];

  /** Validation fields to use for duplicate check: businessName, phone, email. */
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  checkFields?: string[];
}

export class ListLeadsQueryDto {
  /**
   * Free-text lookup across the fields someone would actually search a lead by:
   * company, contact, phone, email and the lead id. Server-side on purpose — the
   * command palette must reach the whole book, not just the page already loaded,
   * and role scoping still applies so an employee only ever finds their own.
   */
  @ApiPropertyOptional({ description: 'Search company, contact, phone, email or lead id' })
  @IsOptional()
  @IsString()
  q?: string;

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

  /**
   * Inclusive lead-id range, for "assign leads L-00100 → L-00300" in the Assign
   * popup. `leadId` is a zero-padded sequential id (L-00001, L-00002 …), so a
   * plain string comparison orders it the same way the number does. Leads that
   * carried their own id in from an import may not fit that shape and simply
   * won't match the range.
   */
  @ApiPropertyOptional({ description: 'Assign-by-range: first lead id, inclusive (e.g. L-00100)' })
  @IsOptional()
  @IsString()
  fromLeadId?: string;

  @ApiPropertyOptional({ description: 'Assign-by-range: last lead id, inclusive (e.g. L-00300)' })
  @IsOptional()
  @IsString()
  toLeadId?: string;

  // ── Filters that used to run in the browser ──
  //
  // Every one of these was applied client-side, over whatever slice of the book
  // had been downloaded. That is only correct while the client holds ALL the
  // rows, which is exactly what made the module slow: it had to fetch the whole
  // book before it could filter it. Filtering here is what lets the list send
  // one page.

  @ApiPropertyOptional({ description: 'City' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ enum: Timezone })
  @IsOptional()
  @IsEnum(Timezone)
  timezone?: Timezone;

  /** Outcome slug, or the display name carried by leads imported before the
   *  outcome list existed — both are matched, as the browser filter did. */
  @ApiPropertyOptional({ description: 'Call outcome slug (or legacy display name)' })
  @IsOptional()
  @IsString()
  callStatus?: string;

  @ApiPropertyOptional({ description: 'assigned | unassigned' })
  @IsOptional()
  @IsString()
  assigned?: 'assigned' | 'unassigned';

  @ApiPropertyOptional({ description: 'Created on or after (ISO date)' })
  @IsOptional()
  @IsString()
  createdFrom?: string;

  @ApiPropertyOptional({ description: 'Created on or before (ISO date)' })
  @IsOptional()
  @IsString()
  createdTo?: string;

  /** Closed Leads filters on when a lead CLOSED, not when it was created — the
   *  two are months apart for anything that took work to win. */
  @ApiPropertyOptional({ description: 'Closed on or after (ISO date)' })
  @IsOptional()
  @IsString()
  closedFrom?: string;

  @ApiPropertyOptional({ description: 'Closed on or before (ISO date)' })
  @IsOptional()
  @IsString()
  closedTo?: string;

  @ApiPropertyOptional({ description: 'Name of the user who closed the lead' })
  @IsOptional()
  @IsString()
  closedBy?: string;

  // ── Paging and ordering ──

  /**
   * 1-based page number. Without it the list returns the first page, which is
   * the point: the module used to download up to 1000 leads and page through
   * them in the browser, so opening it cost 1.2 MB and a thousand rows of DOM
   * before a single one could be read.
   */
  @ApiPropertyOptional({ description: 'Page number, 1-based (default 1)' })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Rows per page (default 50, max 500)' })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(500)
  pageSize?: number;

  @ApiPropertyOptional({ description: 'Column to sort by (see SORTABLE in leads.service)' })
  @IsOptional()
  @IsString()
  sortBy?: string;

  @ApiPropertyOptional({ description: 'asc | desc' })
  @IsOptional()
  @IsString()
  sortDir?: 'asc' | 'desc';

  /**
   * Return only `id` and `leadId`.
   *
   * For the callers that need to reach across the whole book but render almost
   * none of it — the assign-by-range dialog resolves up to 5,000 leads purely to
   * collect their ids, and was being sent every column of every one of them.
   */
  @ApiPropertyOptional({ description: 'Return id and leadId only' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  idsOnly?: boolean;
}
