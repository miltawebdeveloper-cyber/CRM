import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CommDirection } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OpenPhoneService } from '../openphone/openphone.service.js';
import { OpenPhoneCall, OpenPhoneMessage, OpenPhoneNumber } from '../openphone/openphone.types.js';
import { CallInsightsService } from './call-insights.service.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How far apart the CRM's clock and the provider's may be and still describe the
 * same call. Matches the window `adoptPendingOutboundCall` uses on the webhook
 * side — the two paths adopt the same rows, so they must not disagree about
 * which rows those are.
 */
const ADOPT_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Normalise a phone number to E.164 (e.g. +18133030213). Quo/OpenPhone rejects
 * any `participant` that isn't E.164 ("Expected string to match '^\+[1-9]…'"),
 * so a lead stored in display form — "(813) 303-0213" — must be converted before
 * it's used to query call/message history. US-centric, matching the workspace's
 * own +1 lines; an already-E.164 value passes through unchanged.
 */
const toE164 = (raw: string): string => {
  const trimmed = (raw ?? '').trim();
  const d = trimmed.replace(/\D/g, '');
  if (!d) return '';
  if (trimmed.startsWith('+')) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return `+${d}`;
};

export interface LeadSyncResult {
  leadId: string;
  calls: number;
  recordings: number;
  messages: number;
  error?: string;
}

export interface SyncAllResult {
  /** Conversations walked (0 for the sandbox lead sweep). */
  conversations: number;
  /** Conversations whose number matches no lead — skipped, never auto-created. */
  skipped: number;
  leads: number;
  calls: number;
  recordings: number;
  messages: number;
  failed: number;
  sandbox: boolean;
}

/**
 * Pulls call history, call recordings and SMS from Quo (OpenPhone) into the CRM.
 *
 * Why a pull sync at all: the `call.` / `message.` webhooks only capture events
 * from the moment they're configured, so anything older — and anything missed
 * while the API was down — never reaches the CRM. This backfills from the REST API.
 *
 * The shape of this service is dictated by the provider: Quo has NO workspace-wide
 * call/message feed. GET /v1/calls and GET /v1/messages both require a
 * phoneNumberId AND a participant, and only support 1:1 conversations. So history
 * is pulled per lead phone × per workspace number, which is why syncing is
 * on-demand per lead (cheap) plus a throttled backfill, rather than one sweep.
 */
@Injectable()
export class QuoSyncService {
  private readonly logger = new Logger(QuoSyncService.name);
  private fallbackUserId: string | null = null;
  private numbersCache: { at: number; numbers: OpenPhoneNumber[] } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly openphone: OpenPhoneService,
    private readonly insights: CallInsightsService,
  ) {}

  // ── Provider rate limit ──
  // Quo allows ~10 requests/second per API key. Every provider request in this
  // service goes through this gate, which serializes them ~9/s so a large
  // backfill can't trip 429s.
  private minGapMs = Number(process.env.QUO_MIN_REQUEST_GAP_MS ?? 110);
  private gate: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  private schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gate.then(async () => {
      const wait = this.minGapMs - (Date.now() - this.lastAt);
      if (wait > 0) await sleep(wait);
      this.lastAt = Date.now();
      return fn();
    });
    this.gate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async workspaceNumbers(): Promise<OpenPhoneNumber[]> {
    if (this.numbersCache && Date.now() - this.numbersCache.at < 300_000) return this.numbersCache.numbers;
    const numbers = await this.schedule(() => this.openphone.phoneNumbers());
    this.numbersCache = { at: Date.now(), numbers };
    return numbers;
  }

  private async resolveCallerId(assignedToId: string | null): Promise<string> {
    if (assignedToId) return assignedToId;
    if (!this.fallbackUserId) {
      const admin = await this.prisma.user.findFirst({ where: { role: 'admin' }, select: { id: true } });
      this.fallbackUserId = admin?.id ?? (await this.prisma.user.findFirst({ select: { id: true } }))?.id ?? null;
    }
    if (!this.fallbackUserId) throw new Error('No user exists to attribute synced calls to');
    return this.fallbackUserId;
  }

  /** Case/variant tolerant — the REST API returns "incoming"/"outgoing". */
  private dir(v: unknown): CommDirection {
    const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
    return s === 'incoming' || s === 'inbound' ? CommDirection.inbound : CommDirection.outbound;
  }

  /**
   * Match a conversation's participant to an existing lead by the last 10 digits.
   *
   * Returns null rather than creating a lead: a workspace's conversation list
   * includes every number that ever texted or rang it — spam, wrong numbers,
   * personal contacts — and minting a lead for each would bury Lead Management
   * under hundreds of junk rows. The inbound webhook still creates leads for live
   * unknown callers, where a human is actually on the line; a bulk backfill of
   * historical chatter is a different thing and only enriches leads you have.
   */
  private async findLeadByPhone(phone: string) {
    const last10 = phone.replace(/\D/g, '').slice(-10);
    if (!last10) return null;
    return this.prisma.lead.findFirst({
      where: { deletedAt: null, phone: { contains: last10 } },
      select: { id: true, assignedToId: true },
    });
  }

  private first(v: string | string[] | undefined): string {
    return (Array.isArray(v) ? v[0] : v) ?? '';
  }

  /**
   * Calls recorded before this table existed (or delivered by an older webhook)
   * hold their audio in Call.recordingUrl and have no segment row, which would
   * hide them from the Recordings tab. Adopt them as a single segment.
   */
  async adoptLegacyRecordings(where: { leadId?: string } = {}): Promise<number> {
    const orphans = await this.prisma.call.findMany({
      where: { ...where, recordingUrl: { not: null }, recordings: { none: {} } },
      select: { id: true, recordingUrl: true, durationSecs: true, startTime: true },
      take: 500,
    });
    for (const c of orphans) {
      await this.prisma.callRecording.create({
        data: {
          callId: c.id,
          url: c.recordingUrl!,
          durationSecs: c.durationSecs,
          startTime: c.startTime,
          status: 'completed',
        },
      });
    }
    if (orphans.length) this.logger.log(`Adopted ${orphans.length} legacy recording URL(s) into call_recordings`);
    return orphans.length;
  }

  /** Sync one lead's Quo history. Safe to call repeatedly — every write is keyed
   *  on the provider's own ids, so re-syncing updates rather than duplicates. */
  async syncLead(leadId: string): Promise<LeadSyncResult> {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, deletedAt: null },
      select: { id: true, phone: true, assignedToId: true },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    if (!lead.phone) return { leadId, calls: 0, recordings: 0, messages: 0, error: 'Lead has no phone number' };

    // Quo requires the participant in E.164; leads may be stored in display form.
    const participant = toE164(lead.phone);
    if (!participant) return { leadId, calls: 0, recordings: 0, messages: 0, error: `Lead phone "${lead.phone}" is not a valid number` };

    const numbers = await this.workspaceNumbers();
    if (numbers.length === 0) return { leadId, calls: 0, recordings: 0, messages: 0, error: 'No Quo phone numbers available' };

    await this.adoptLegacyRecordings({ leadId: lead.id });
    const callerId = await this.resolveCallerId(lead.assignedToId);
    let calls = 0;
    let recordings = 0;
    let messages = 0;

    for (const number of numbers) {
      calls += await this.syncCallsFor(lead.id, participant, number, callerId).then((r) => {
        recordings += r.recordings;
        return r.calls;
      });
      messages += await this.syncMessagesFor(lead.id, participant, number);
    }

    if (calls || messages) {
      await this.prisma.lead.update({ where: { id: lead.id }, data: { lastCommunicationAt: new Date() } });
    }
    return { leadId, calls, recordings, messages };
  }

  /** Walk every page of call history for one (lead × workspace number) pair. */
  private async syncCallsFor(
    leadId: string,
    phone: string,
    number: OpenPhoneNumber,
    callerId: string,
  ): Promise<{ calls: number; recordings: number }> {
    let pageToken: string | undefined;
    let calls = 0;
    let recordings = 0;
    let pages = 0;

    do {
      const res = await this.schedule(() =>
        this.openphone.listCalls({ phoneNumberId: number.id, participant: phone, selfNumber: number.number, maxResults: 100, pageToken }),
      );
      if (!res.success) {
        this.logger.warn(`listCalls failed for ${phone} on ${number.number}: ${res.error}`);
        break;
      }
      for (const c of res.data?.data ?? []) {
        const callId = await this.upsertCall(leadId, callerId, c);
        if (callId) {
          calls++;
          recordings += await this.syncRecordings(callId, c);
        }
      }
      pageToken = res.data?.nextPageToken ?? undefined;
    } while (pageToken && ++pages < 20); // hard page cap — don't walk forever

    return { calls, recordings };
  }

  /** Create or enrich the Call row for a provider call. Returns our call id. */
  private async upsertCall(leadId: string, callerId: string, c: OpenPhoneCall): Promise<string | null> {
    if (!c.id) return null;
    const direction = this.dir(c.direction);
    const startTime = c.createdAt ? new Date(c.createdAt) : new Date();
    const durationSecs = typeof c.duration === 'number' ? c.duration : null;
    const ended = !!c.completedAt || durationSecs != null;
    const endTime = ended
      ? c.completedAt
        ? new Date(c.completedAt)
        : new Date(startTime.getTime() + (durationSecs ?? 0) * 1000)
      : null;

    // Already linked to this provider call — enrich it and stop.
    const existing = await this.prisma.call.findFirst({ where: { quoCallId: c.id }, select: { id: true } });
    if (existing) {
      await this.prisma.call.update({
        where: { id: existing.id },
        data: {
          ...(c.status ? { status: c.status } : {}),
          ...(durationSecs != null ? { durationSecs } : {}),
          ...(c.conversationId ? { conversationId: c.conversationId } : {}),
          ...(endTime ? { endTime } : {}),
        },
      });
      return existing.id;
    }

    /**
     * Not linked yet — but the CRM may already hold this very call.
     *
     * `startCall` writes a row the moment the agent clicks Call, before the
     * provider has an id for it, so that row carries `quoCallId: null`. The
     * webhook normally claims it (`adoptPendingOutboundCall`), and when it does
     * there is nothing here to find. When it does NOT — a delivery rejected on a
     * signature mismatch, a webhook configured after the call, an outage — the
     * row stays unlinked forever, and this backfill used to create a SECOND row
     * for the same conversation. That is the duplicate in Call Details: one row
     * with the agent's outcome and no recording, one with the recording and no
     * outcome, both for a call that happened once.
     *
     * So adopt on the same conservative terms the webhook uses: same lead, same
     * direction, never linked to a provider call, and started within a couple of
     * hours of the provider's own start time — most recent first, so back-to-back
     * attempts to the same lead claim the right one. Anything less exact would
     * merge two genuine calls, which is worse than the duplicate it fixes.
     */
    const adopted = await this.prisma.call.findFirst({
      where: {
        leadId,
        direction,
        quoCallId: null,
        startTime: {
          gte: new Date(startTime.getTime() - ADOPT_WINDOW_MS),
          lte: new Date(startTime.getTime() + ADOPT_WINDOW_MS),
        },
      },
      orderBy: { startTime: 'desc' },
      select: { id: true, endTime: true },
    });
    if (adopted) {
      await this.prisma.call.update({
        where: { id: adopted.id },
        data: {
          quoCallId: c.id,
          ...(c.status ? { status: c.status } : {}),
          ...(durationSecs != null ? { durationSecs } : {}),
          ...(c.conversationId ? { conversationId: c.conversationId } : {}),
          // Only if the CRM never closed it. A row the agent already ended
          // carries the duration they were credited with, and the provider's
          // own end time must not overwrite it.
          ...(endTime && !adopted.endTime ? { endTime } : {}),
        },
      });
      return adopted.id;
    }

    const created = await this.prisma.call.create({
      data: {
        leadId,
        callerId,
        direction,
        status: c.status ?? null,
        durationSecs,
        startTime,
        endTime,
        quoCallId: c.id,
        conversationId: c.conversationId ?? null,
      },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * Pull the recording segments for a call. Skipped for calls that were never
   * answered, and for calls whose recordings we already hold — recordings are
   * immutable once complete, so re-fetching them only burns rate limit.
   */
  private async syncRecordings(callId: string, c: OpenPhoneCall): Promise<number> {
    if (!c.id) return 0;
    if (typeof c.duration === 'number' && c.duration === 0) return 0;
    const have = await this.prisma.callRecording.count({ where: { callId } });
    if (have > 0) return 0;

    const res = await this.schedule(() => this.openphone.getCallRecordings(c.id));
    if (!res.success) {
      this.logger.warn(`getCallRecordings failed for ${c.id}: ${res.error}`);
      return 0;
    }

    let saved = 0;
    for (const r of res.data ?? []) {
      if (!r.url) continue; // "display the recording only if it is available"
      await this.prisma.callRecording.upsert({
        where: { quoRecordingId: r.id },
        create: {
          callId,
          quoRecordingId: r.id,
          url: r.url,
          durationSecs: r.duration ?? null,
          startTime: r.startTime ? new Date(r.startTime) : null,
          status: r.status ?? null,
          mimeType: r.type ?? null,
        },
        update: { url: r.url, durationSecs: r.duration ?? null, status: r.status ?? null },
      });
      saved++;
    }

    // Keep Call.recordingUrl pointing at the first segment so existing readers
    // (timeline, call widget) keep working unchanged.
    if (saved > 0) {
      const firstSeg = await this.prisma.callRecording.findFirst({
        where: { callId },
        orderBy: [{ startTime: 'asc' }, { createdAt: 'asc' }],
        select: { url: true },
      });
      if (firstSeg) await this.prisma.call.update({ where: { id: callId }, data: { recordingUrl: firstSeg.url } });
      // A recording just landed — generate its AI summary + transcript in the
      // background (never blocks the sync). No-ops if the queue already has it.
      this.insights.enqueue(callId);
    }
    return saved;
  }

  /** Walk every page of SMS history for one (lead × workspace number) pair. */
  private async syncMessagesFor(leadId: string, phone: string, number: OpenPhoneNumber): Promise<number> {
    let pageToken: string | undefined;
    let saved = 0;
    let pages = 0;

    do {
      const res = await this.schedule(() =>
        this.openphone.listMessages({ phoneNumberId: number.id, participant: phone, selfNumber: number.number, maxResults: 100, pageToken }),
      );
      if (!res.success) {
        this.logger.warn(`listMessages failed for ${phone} on ${number.number}: ${res.error}`);
        break;
      }
      for (const m of res.data?.data ?? []) {
        if (await this.upsertMessage(leadId, m)) saved++;
      }
      pageToken = res.data?.nextPageToken ?? undefined;
    } while (pageToken && ++pages < 20);

    return saved;
  }

  private async upsertMessage(leadId: string, m: OpenPhoneMessage): Promise<boolean> {
    if (!m.id) return false;
    const body = m.text ?? m.body ?? '';
    const direction = this.dir(m.direction);
    const existing = await this.prisma.message.findFirst({ where: { quoMessageId: m.id }, select: { id: true } });
    if (existing) {
      await this.prisma.message.update({
        where: { id: existing.id },
        data: { status: m.status ?? undefined, body: body || undefined, leadId },
      });
      return false; // updated, not newly synced
    }
    await this.prisma.message.create({
      data: {
        leadId,
        direction,
        body,
        fromNumber: this.first(m.from),
        toNumber: this.first(m.to),
        status: m.status ?? null,
        quoMessageId: m.id,
        conversationId: m.conversationId ?? null,
        ...(m.createdAt ? { createdAt: new Date(m.createdAt) } : {}),
      },
    });
    return true;
  }

  // ── Backfill run state ──
  // A full sweep can run for many minutes, far longer than an HTTP request should
  // wait, so the endpoint starts it and returns. Progress is polled instead.
  private running = false;
  private lastRun: (SyncAllResult & { finishedAt: Date }) | null = null;
  private startedAt: Date | null = null;

  get backfillStatus() {
    return { running: this.running, startedAt: this.startedAt, lastRun: this.lastRun };
  }

  /** Start a backfill unless one is already in flight. Returns immediately. */
  startBackfill(): { started: boolean; running: boolean; startedAt: Date | null } {
    if (this.running) return { started: false, running: true, startedAt: this.startedAt };
    this.running = true;
    this.startedAt = new Date();
    void this.syncAll()
      .then((r) => {
        this.lastRun = { ...r, finishedAt: new Date() };
      })
      .catch((err) => {
        this.logger.error(`Backfill failed: ${(err as Error).message}`);
      })
      .finally(() => {
        this.running = false;
      });
    return { started: true, running: true, startedAt: this.startedAt };
  }

  /**
   * Backfill everything Quo knows about.
   *
   * Discovery runs off GET /v1/conversations — the one history endpoint that
   * doesn't require a participant. That makes the sweep both complete (it finds
   * conversations with numbers that aren't leads yet, creating the lead like the
   * webhook does) and cheap: two requests per real conversation, instead of
   * every lead × every workspace number, most of which have no history at all.
   *
   * Sandbox has no conversation feed to walk, so it falls back to the lead sweep.
   */
  async syncAll(): Promise<SyncAllResult> {
    if (this.openphone.isSandbox) return this.syncAllByLeads();

    const totals = { conversations: 0, skipped: 0, leads: 0, calls: 0, recordings: 0, messages: 0, failed: 0 };
    const seenLeads = new Set<string>();
    let pageToken: string | undefined;
    let pages = 0;
    const maxPages = Number(process.env.QUO_SYNC_MAX_PAGES ?? 40);

    await this.adoptLegacyRecordings();

    do {
      const res = await this.schedule(() => this.openphone.listConversations({ maxResults: 50, pageToken }));
      if (!res.success) {
        this.logger.warn(`listConversations failed: ${res.error}`);
        break;
      }
      for (const conv of res.data?.data ?? []) {
        if (conv.deletedAt) continue;
        const participant = conv.participants?.[0];
        if (!participant) continue;
        totals.conversations++;
        try {
          const lead = await this.findLeadByPhone(participant);
          if (!lead) {
            totals.skipped++;
            continue;
          }
          seenLeads.add(lead.id);
          const callerId = await this.resolveCallerId(lead.assignedToId);
          const number: OpenPhoneNumber = { id: conv.phoneNumberId, number: conv.phoneNumberId };
          const r = await this.syncCallsFor(lead.id, participant, number, callerId);
          totals.calls += r.calls;
          totals.recordings += r.recordings;
          // This conversation's own message count — testing the running total
          // would touch every later lead once any conversation had a message.
          const msgs = await this.syncMessagesFor(lead.id, participant, number);
          totals.messages += msgs;
          if (r.calls || msgs) {
            await this.prisma.lead.update({ where: { id: lead.id }, data: { lastCommunicationAt: new Date() } });
          }
        } catch (err) {
          totals.failed++;
          this.logger.warn(`Sync failed for conversation ${conv.id}: ${(err as Error).message}`);
        }
      }
      pageToken = res.data?.nextPageToken ?? undefined;
    } while (pageToken && ++pages < maxPages);

    totals.leads = seenLeads.size;
    this.logger.log(`Quo backfill: ${JSON.stringify(totals)}`);
    return { ...totals, sandbox: false };
  }

  /** Sandbox/fallback sweep: pull history per lead phone × workspace number. */
  private async syncAllByLeads(limit = 500): Promise<SyncAllResult> {
    const leads = await this.prisma.lead.findMany({
      where: { deletedAt: null, phone: { not: '' } },
      select: { id: true },
      orderBy: { lastCommunicationAt: { sort: 'desc', nulls: 'last' } },
      take: limit,
    });

    const totals = { conversations: 0, skipped: 0, leads: 0, calls: 0, recordings: 0, messages: 0, failed: 0 };
    for (const l of leads) {
      try {
        const r = await this.syncLead(l.id);
        totals.leads++;
        totals.calls += r.calls;
        totals.recordings += r.recordings;
        totals.messages += r.messages;
      } catch (err) {
        totals.failed++;
        this.logger.warn(`Sync failed for lead ${l.id}: ${(err as Error).message}`);
      }
    }
    this.logger.log(`Quo backfill (lead sweep): ${JSON.stringify(totals)}`);
    return { ...totals, sandbox: this.openphone.isSandbox };
  }

  /**
   * Keep recently-active leads fresh without spending the rate limit on the
   * whole book. Webhooks remain the real-time path; this is the safety net that
   * catches anything they missed.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async syncRecentlyActive() {
    if (process.env.QUO_SYNC_CRON === 'off') return;
    const since = new Date(Date.now() - 7 * 86_400_000);
    const leads = await this.prisma.lead.findMany({
      where: { deletedAt: null, phone: { not: '' }, lastCommunicationAt: { gte: since } },
      select: { id: true },
      orderBy: { lastCommunicationAt: 'desc' },
      take: Number(process.env.QUO_SYNC_CRON_LIMIT ?? 25),
    });
    for (const l of leads) {
      try {
        await this.syncLead(l.id);
      } catch (err) {
        this.logger.warn(`Scheduled sync failed for lead ${l.id}: ${(err as Error).message}`);
      }
    }
  }
}
