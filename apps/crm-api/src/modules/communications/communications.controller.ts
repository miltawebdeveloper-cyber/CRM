import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { CommunicationsService } from './communications.service';
import { CallHistoryService } from './call-history.service';
import { QuoSyncService } from './quo-sync.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SendSmsDto, CallByPhoneDto, HistoryQueryDto } from './dto/communications.dto';

/** PERM: recordings/transcripts/AI summaries are admin + team-leader only. */
const canViewRecordings = (role: Role) => role === Role.admin || role === Role.team_leader;

/** Lead communications — timeline + outbound SMS / click-to-call + analytics. */
@ApiTags('communications')
@ApiBearerAuth()
@Controller('communications')
export class CommunicationsController {
  constructor(
    private readonly comms: CommunicationsService,
    private readonly history: CallHistoryService,
    private readonly sync: QuoSyncService,
  ) {}

  @Get('lead/:id')
  timeline(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.comms.getTimeline(id, canViewRecordings(user.role));
  }

  @Post('lead/:id/sms')
  sendSms(@Param('id') id: string, @Body() dto: SendSmsDto, @CurrentUser() user: AuthUser) {
    return this.comms.sendSms(id, dto.body, user.id, dto.from);
  }

  @Post('lead/:id/call')
  startCall(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.comms.startCall(id, user.id);
  }

  /** Dial-pad call to a typed number (resolves/creates the lead, then dials). */
  @Post('call')
  callByPhone(@Body() dto: CallByPhoneDto, @CurrentUser() user: AuthUser) {
    return this.comms.startCallByPhone(dto.phone, user.id);
  }

  /** Live state of an in-progress call — polled ~1s by the in-CRM call widget. */
  @Get('call/:id/state')
  callState(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.comms.getCallState(id, user.id, user.role);
  }

  /** Polled by the incoming-call popup. */
  @Get('incoming/latest')
  latestIncoming(@CurrentUser() user: AuthUser) {
    return this.comms.latestIncoming(user.id, user.role);
  }

  /** Missed inbound calls for the dashboard widget (employees: own only). */
  @Get('missed')
  missed(@CurrentUser() user: AuthUser) {
    return this.comms.getMissedCalls(user.id, user.role);
  }

  /** Communication analytics — managers only. */
  @Roles(Role.admin, Role.team_leader)
  @Get('analytics')
  analytics(@Query('period') period?: string) {
    return this.comms.getAnalytics(period);
  }

  // ── Calling Panel: Call Recordings tab ──

  /** Calls that have a synced recording. PERM: admin + team leader only. */
  @Roles(Role.admin, Role.team_leader)
  @Get('recordings')
  recordings(@Query() q: HistoryQueryDto, @CurrentUser() user: AuthUser) {
    return this.history.listRecordings(q, user.role);
  }

  /**
   * Stream a recording's audio. Proxied (rather than exposing the provider URL)
   * so the manager-only rule is enforced here on every play/download.
   */
  @Roles(Role.admin, Role.team_leader)
  @Get('recordings/:id/audio')
  async recordingAudio(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('download') download: string | undefined,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const audio = await this.history.recordingAudio(id, user.role);
    res.setHeader('Content-Type', audio.mimeType);
    res.setHeader('Content-Length', audio.body.length);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader(
      'Content-Disposition',
      `${download === '1' ? 'attachment' : 'inline'}; filename="${audio.filename}"`,
    );
    res.end(audio.body);
  }

  // ── Calling Panel: SMS tab ──

  /** SMS history. Employees are scoped to their own leads by the service. */
  @Get('sms')
  sms(@Query() q: HistoryQueryDto, @CurrentUser() user: AuthUser) {
    return this.history.listSms(q, user);
  }

  /** Statuses present in the data — populates the SMS status filter. */
  @Get('sms/statuses')
  smsStatuses(@CurrentUser() user: AuthUser) {
    return this.history.smsStatuses(user);
  }

  // ── Quo history sync ──

  /** Pull one lead's calls, recordings and SMS from Quo on demand. */
  @Post('sync/lead/:id')
  syncLead(@Param('id', ParseUUIDPipe) id: string) {
    return this.sync.syncLead(id);
  }

  /**
   * Start a full backfill — admin only. Returns as soon as the run is started:
   * a sweep walks every Quo conversation at 10 req/s and can take many minutes,
   * so the client polls `sync/status` rather than holding a request open.
   */
  @Roles(Role.admin)
  @Post('sync/all')
  syncAll() {
    return this.sync.startBackfill();
  }

  /** Progress of the current/last backfill. */
  @Roles(Role.admin, Role.team_leader)
  @Get('sync/status')
  syncStatus() {
    return this.sync.backfillStatus;
  }
}
