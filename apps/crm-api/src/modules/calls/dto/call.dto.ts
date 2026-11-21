import { IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUrl, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class StartCallDto {
  @ApiProperty()
  @IsUUID()
  leadId: string;
}

export class EndCallDto {
  @ApiProperty({ description: 'Outcome slug (see configurable Outcome list)' })
  @IsString()
  @MinLength(1)
  outcome: string;

  @ApiPropertyOptional({ description: 'Duration in seconds; computed from start time if omitted' })
  @IsOptional()
  @IsInt()
  @Min(0)
  durationSecs?: number;

  // A real HTTPS URL only. This was any string, stored and later rendered to
  // managers as a "▶ Recording" link — so a rep could plant a link to anywhere
  // (a phishing page dressed as the recording) on their own call. Recordings
  // normally arrive by webhook; no CRM screen sends this field.
  @ApiPropertyOptional({ description: 'HTTPS URL of the call recording' })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  recordingUrl?: string;

  @ApiPropertyOptional({ description: 'Callback or interested follow-up time in ISO format' })
  @IsOptional()
  @IsDateString()
  callbackAt?: string;
}

export class CreateNoteDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  noteText: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  nextFollowupDate?: string;

  @ApiPropertyOptional({ description: 'Reminder callback time in ISO format' })
  @IsOptional()
  @IsDateString()
  callbackAt?: string;
}

/**
 * Calls Made dashboard filter. `from`/`to` are yyyy-mm-dd and inclusive of both
 * whole days — the Day/Week/Month/Year/Custom modes on the web side all resolve
 * to a plain date range, so the API only ever sees the resolved bounds.
 * `userId` narrows to one employee and is honoured for managers only.
 */
export class CallStatsQueryDto {
  @ApiPropertyOptional({ description: 'yyyy-mm-dd — calls from (inclusive)' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'yyyy-mm-dd — calls to (inclusive)' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ description: 'Filter to one caller (managers only; employees are always scoped to themselves)' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  // ── Lead-side filters ──
  // Applied server-side so the summary tiles and the detail rows describe the
  // SAME set of calls, and so filtering spans the whole range rather than only
  // the page of rows the table happens to have loaded.

  @ApiPropertyOptional({ description: 'Lead country' })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({ description: "Lead timezone (EST/CST/MST/PST)" })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional({ description: 'Lead state' })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({ description: 'Lead city' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ description: "assigned | unassigned | or a LeadStatus value" })
  @IsOptional()
  @IsString()
  leadStatus?: string;

  /**
   * One or more comma-separated tokens, any of which matches:
   *  • an outcome slug — logged on the call, falling back to the lead's legacy
   *    call status for calls from before per-call outcomes;
   *  • `bucket:<group>` — every outcome in a group (cold, warm, hot,
   *    connected, closed = won and lost, ungrouped = no group), on the call
   *    itself, so the list matches the Analytics tab's counts;
   *  • `none` — calls with no outcome logged.
   */
  @ApiPropertyOptional({ description: "Outcome slug(s), bucket:<group> or none — comma-separated, any may match" })
  @IsOptional()
  @IsString()
  outcome?: string;
}

/**
 * The dimensions a pivot axis can carry. Each one is derived from a single call
 * record, so any pair of them is a valid rows × cols combination.
 */
export enum CallPivotDim {
  /** Who made the call. */
  employee = 'employee',
  /** The outcome logged on the call. */
  outcome = 'outcome',
  /** The outcome's funnel bucket (cold / warm / hot / connected / closed). */
  bucket = 'bucket',
  /** Inbound vs outbound (only set on calls that came through OpenPhone). */
  direction = 'direction',
  /** Provider call status. */
  status = 'status',
  /** The lead's current status. */
  leadStatus = 'leadStatus',
  /** Calendar day the call started. */
  date = 'date',
  /** Day of the week the call started (Mon–Sun). */
  weekday = 'weekday',
  /** Hour of the day the call started (0–23). */
  hour = 'hour',
}

/**
 * Pivot query — the Calls Made filter plus the two axes to cross-tabulate.
 * The scope rules are the same as every other Calls Made read: employees are
 * pinned to their own calls, managers may narrow to one rep with `userId`.
 */
export class CallPivotQueryDto extends CallStatsQueryDto {
  @ApiProperty({ enum: CallPivotDim, description: 'Dimension down the side' })
  @IsEnum(CallPivotDim)
  rows: CallPivotDim;

  @ApiProperty({ enum: CallPivotDim, description: 'Dimension across the top' })
  @IsEnum(CallPivotDim)
  cols: CallPivotDim;
}

/** Per-employee Calls Made target (managers only). */
export class SetCallTargetDto {
  @ApiPropertyOptional({ description: 'Calls expected per working day; 0 removes the target' })
  @IsOptional()
  @IsInt()
  @Min(0)
  dailyCallTarget?: number;

  @ApiPropertyOptional({ description: "Why the target isn't being met; empty string clears it" })
  @IsOptional()
  @IsString()
  targetMissReason?: string;
}

export class UpdateFollowupDto {
  @ApiPropertyOptional({ description: 'Updated follow-up note text' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  noteText?: string;

  @ApiPropertyOptional({ description: 'Updated follow-up time in ISO format' })
  @IsOptional()
  @IsDateString()
  followUpAt?: string;
}
