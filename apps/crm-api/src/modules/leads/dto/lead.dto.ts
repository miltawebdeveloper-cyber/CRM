import { ArrayNotEmpty, IsArray, IsBoolean, IsEmail, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Timezone, LeadStatus } from '@crm/database';
import { UNSET_TIMEZONE_LABEL } from '../../../common/timezone.js';

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

  /**
   * When the lead was ORIGINALLY created, for a lead being brought in from
   * somewhere it already existed.
   *
   * Absent — the ordinary case, and every lead typed into the New Lead form —
   * the database stamps `now()`. An import of a back catalogue is the case this
   * is for: those leads have a real history, and stamping the whole file with
   * the minute it was uploaded throws it away and makes every lead in the CRM
   * look a day old.
   *
   * Honoured on CREATE only. Nothing may rewrite an existing lead's creation
   * timestamp — that is the guarantee Lead Management's Created Date & Time
   * rests on — so an import row that matches and UPDATES a lead leaves it alone.
   *
   * A bare `2026-07-01` is read as midnight on the LEAD's clock, not the
   * server's, so an imported date means the day the sheet says it does.
   */
  @ApiPropertyOptional({ description: 'Original creation date/time (ISO). Applied on create only; never overwrites an existing lead.' })
  @IsOptional()
  @IsString()
  createdAt?: string;

  /**
   * Create this lead even though it matches one already in the CRM.
   *
   * Absent, a create that duplicates an existing lead on phone or email is
   * refused with a 409 listing the matches — the form shows them and the person
   * decides. Only ever set from that decision; the import does not use it (it
   * has its own review, and its rows never come through `create`).
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowDuplicate?: boolean;
}

/**
 * Lead edit — every field optional. Managers may PATCH any subset; the service
 * diffs against the current record and writes a field-level activity per change.
 * `caller` (name/email) reassigns the lead; `leadId` is ignored (immutable).
 */
export class UpdateLeadDto extends PartialType(CreateLeadDto) {
  /**
   * Go ahead with a reassignment even though this lead was already assigned
   * today.
   *
   * A lead is assigned once a day by default. Without this flag a same-day
   * change of owner is refused with SAME_DAY_CONFIRM_CODE, which is the client's
   * cue to ask "this lead has already been assigned today — reassign?"; sending
   * it is that confirmation, and it is recorded against the handover.
   *
   * Deliberately not sticky: it confirms THIS reassignment, not a standing
   * permission to bypass the restriction.
   */
  @ApiPropertyOptional({ description: 'Confirm a reassignment on a day the lead was already assigned' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  confirmSameDayReassign?: boolean;
}

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
   * on an exact Phone or Email. Set from the duplicate review's "Skip All
   * Duplicates"; "Import All Duplicates" sends it false/absent.
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

  /** Which fields the duplicate check compares: `phone`, `email`, or both.
   *  Absent or empty means both. Company name on its own is never a signal —
   *  it counts only with the city and state, via `matchLocation`. */
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  checkFields?: string[];

  /**
   * Compare phone numbers by their last 10 digits rather than as written, so
   * "+1 (305) 555-1234" and "3055551234" count as one number. Off by default —
   * it is a looser rule than the exact compare and is opted into per import.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  ignorePhoneFormatting?: boolean;

  /**
   * Also compare the company's own domain, read from the email and the website.
   * Off by default and noisier than the contact-point rules: it matches two
   * DIFFERENT people at one firm, which is often two legitimate leads.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  matchCompanyDomain?: boolean;

  /**
   * Also compare business name AND city AND state together, so the same firm
   * re-listed with a different phone or a blank email is caught. All three must
   * match; a branch in another city is still its own lead. Off by default.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  matchLocation?: boolean;
}

/** Body for the pre-import duplicate check — parsed rows and optional duplicate validation fields. */
export class CheckImportDto {
  @ApiProperty({ type: [CreateLeadDto] })
  @IsArray()
  @ArrayNotEmpty()
  rows: CreateLeadDto[];

  /** Which fields the duplicate check compares: `phone`, `email`, or both.
   *  Absent or empty means both. Company name on its own is never a signal —
   *  it counts only with the city and state, via `matchLocation`. */
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  checkFields?: string[];

  /**
   * Compare phone numbers by their last 10 digits rather than as written, so
   * "+1 (305) 555-1234" and "3055551234" count as one number. Off by default —
   * it is a looser rule than the exact compare and is opted into per import.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  ignorePhoneFormatting?: boolean;

  /**
   * Also compare the company's own domain, read from the email and the website.
   * Off by default and noisier than the contact-point rules: it matches two
   * DIFFERENT people at one firm, which is often two legitimate leads.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  matchCompanyDomain?: boolean;

  /**
   * Also compare business name AND city AND state together, so the same firm
   * re-listed with a different phone or a blank email is caught. All three must
   * match; a branch in another city is still its own lead. Off by default.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  matchLocation?: boolean;
}

/** Body for the single-record duplicate check the New Lead form calls. */
export class CheckDuplicateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  altPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  website?: string;

  /** The three location columns, compared only together and only when
   *  `matchLocation` is set. Sent by the form so the check CAN compare them. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  businessName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  state?: string;

  /** Ignore one lead when checking — the record being edited is not its own duplicate. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  excludeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  matchCompanyDomain?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  matchLocation?: boolean;
}

/**
 * Query for the Duplicate Leads scan. Booleans arrive as query strings, so they
 * are coerced here rather than being read as the truthy strings they'd otherwise
 * be — `?matchCompanyDomain=false` must mean false.
 */
export class DuplicateGroupsQueryDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  @IsArray()
  checkFields?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  ignorePhoneFormatting?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  matchCompanyDomain?: boolean;

  /** Compare business name AND city AND state together. Off by default. */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  matchLocation?: boolean;

  /** Groups to return, largest first. The totals cover the whole scan either way. */
  @ApiPropertyOptional({ minimum: 1, maximum: 500, default: 100 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
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

  @ApiPropertyOptional({ description: 'Country' })
  @IsOptional()
  @IsString()
  country?: string;

  /**
   * A zone code, or `Unassigned` for the leads that have none set — the filter
   * has to be able to reach those, since they are the ones no callback can be
   * booked against until someone gives them a zone. Validated as a plain string
   * for that reason; `leadFilter` maps it back to `timezone IS NULL`.
   */
  @ApiPropertyOptional({ enum: [...Object.values(Timezone), UNSET_TIMEZONE_LABEL] })
  @IsOptional()
  @IsIn([...Object.values(Timezone), UNSET_TIMEZONE_LABEL])
  timezone?: string;

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

  /**
   * Show only the leads belonging to one employee. Distinct from `assigned`,
   * which asks whether a lead has an owner at all rather than who it is.
   *
   * Admin only, enforced in the service: it is ignored for every other role
   * rather than rejected, so an employee sending it sees their own book (which
   * is all they may see) instead of an error.
   */
  @ApiPropertyOptional({ description: "Leads assigned to this user id (admin only; ignored for other roles)" })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ description: 'Range start (ISO date) — see dateField for which date it applies to' })
  @IsOptional()
  @IsString()
  createdFrom?: string;

  @ApiPropertyOptional({ description: 'Range end (ISO date) — see dateField for which date it applies to' })
  @IsOptional()
  @IsString()
  createdTo?: string;

  /**
   * Which of the lead's two dates `createdFrom`/`createdTo` filter on.
   *
   * A lead carries both, and they answer different questions:
   *
   *   `created`   — when the lead was FIRST created. Set once, rewritten by
   *                 nothing: not by a reassignment, not by being carried into
   *                 the next day. This is the default, so every existing caller
   *                 keeps the behaviour it has always had.
   *   `scheduled` — the day the lead is currently on somebody's queue for,
   *                 taken from its active assignment. This is the one that
   *                 moves.
   *
   * Filtering a day on `created` and calling the result "today's leads" is the
   * mistake this option exists to fix: it drops every lead created earlier and
   * carried forward into today, which for a working book is most of the day.
   */
  @ApiPropertyOptional({ description: 'created (default) | scheduled — which date the from/to range applies to' })
  @IsOptional()
  @IsIn(['created', 'scheduled'])
  dateField?: 'created' | 'scheduled';

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
