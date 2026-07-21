import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendSmsDto {
  @ApiProperty({ description: 'Message body' })
  @IsString()
  @MinLength(1)
  @MaxLength(1600)
  body: string;

  @ApiPropertyOptional({ description: 'Send-from number (defaults to first workspace number)' })
  @IsOptional()
  @IsString()
  from?: string;
}

/** Shared filters for the Calling Panel's Recordings / SMS tabs. */
export class HistoryQueryDto {
  @ApiPropertyOptional({ description: 'Free-text search (customer, number, agent, message body)' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ enum: ['inbound', 'outbound'] })
  @IsOptional()
  @IsIn(['inbound', 'outbound'])
  direction?: 'inbound' | 'outbound';

  @ApiPropertyOptional({ description: 'Message status (sent, delivered, undelivered, received, failed)' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  status?: string;

  @ApiPropertyOptional({ description: 'Start of the date range (yyyy-mm-dd)' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ description: 'End of the date range (yyyy-mm-dd)' })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional({ description: 'Restrict to a single lead' })
  @IsOptional()
  @IsUUID()
  leadId?: string;
}

/**
 * How the agent answered the incoming-call popup.
 *
 * `decline` records the agent's decision — it does NOT reject the call on the
 * carrier, because OpenPhone exposes no call-control API (its only writes are
 * messages and contacts). See CommunicationsService.respondToCall.
 */
export class CallResponseDto {
  @ApiProperty({ enum: ['attend', 'decline'] })
  @IsIn(['attend', 'decline'])
  action: 'attend' | 'decline';
}

export class CallByPhoneDto {
  @ApiProperty({ description: 'Number to dial (E.164 or local digits) — from the dial pad' })
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  phone: string;
}
