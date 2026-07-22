import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@crm/database';
import { CommunicationsService } from './communications.service';
import { CallHistoryService } from './call-history.service';
import { QuoSyncService } from './quo-sync.service';
import { CallInsightsService } from './call-insights.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SendSmsDto, CallByPhoneDto, HistoryQueryDto, CallResponseDto } from './dto/communications.dto';

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
    private readonly insights: CallInsightsService,
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

  /**
   * Is Quo's real-time webhook actually reaching the CRM? Returns when the last
   * provider push landed and its type. If `everReceived` is false, the incoming-
   * call popup can never fire live — no webhook is configured/accepted in Quo, and
   * inbound calls are arriving only via the 10-minute REST backfill. Admin/TL only.
   */
  @Get('webhook/health')
  @Roles(Role.admin, Role.team_leader)
  webhookHealth() {
    return this.comms.webhookHealth;
  }

  /**
   * Record the agent's response to the incoming-call popup (Attend / Decline).
   * Decline logs the decision — it cannot hang the call up, since OpenPhone has
   * no call-control API. The provider's webhook still supplies the final status.
   */
  @Post('call/:id/respond')
  respondToCall(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CallResponseDto, @CurrentUser() user: AuthUser) {
    return this.comms.respondToCall(id, user.id, user.role, dto.action);
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

  /**
   * Calls that have a synced recording.
   * PERM: managers see all; an employee sees only the calls they made (scoped in
   * the service), so a rep can review their own work but not a colleague's.
   */
  @Get('recordings')
  recordings(@Query() q: HistoryQueryDto, @CurrentUser() user: AuthUser) {
    return this.history.listRecordings(q, { id: user.id, role: user.role });
  }

  /**
   * Stream a recording's audio. Proxied (rather than exposing the provider URL)
   * so the manager-only rule is enforced here on every play/download.
   */
  @Get('recordings/:id/audio')
  async recordingAudio(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('download') download: string | undefined,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const audio = await this.history.recordingAudio(id, { id: user.id, role: user.role });
    res.setHeader('Content-Type', audio.mimeType);
    res.setHeader('Content-Length', audio.body.length);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader(
      'Content-Disposition',
      `${download === '1' ? 'attachment' : 'inline'}; filename="${audio.filename}"`,
    );
    res.end(audio.body);
  }

  // ── Calling Panel: AI Summary + Transcript ──

  /**
   * Full AI insight (structured summary + speaker-labelled transcript) for a call.
   * PERM: managers see any; an employee sees only their own — the insights service
   * enforces the same ownership rule as the recording audio proxy.
   */
  @Get('calls/:id/insight')
  insight(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.insights.getInsight(id, { id: user.id, role: user.role });
  }

  /** Regenerate one call's AI summary + transcript (manager or the call's owner). */
  @Post('calls/:id/insight/regenerate')
  regenerateInsight(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.insights.regenerate(id, { id: user.id, role: user.role });
  }

  /** Queue AI insight generation for every recorded call that lacks one — admin only. */
  @Roles(Role.admin)
  @Post('insights/backfill')
  backfillInsights() {
    return this.insights.backfillAll();
  }

  /** Progress of the insight generation queue. */
  @Roles(Role.admin, Role.team_leader)
  @Get('insights/status')
  insightsStatus() {
    return this.insights.backfillStatus;
  }

  // ── Calling Panel: SMS tab ──

  /** SMS history. Employees are scoped to their own leads by the service. */
  @Get('sms')
  sms(@Query() q: HistoryQueryDto, @CurrentUser() user: AuthUser) {
    return this.history.listSms(q, user);
  }

  /** Statuses present in the current view — populates the SMS status filter. */
  @Get('sms/statuses')
  smsStatuses(@Query() q: HistoryQueryDto, @CurrentUser() user: AuthUser) {
    return this.history.smsStatuses(q, user);
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
