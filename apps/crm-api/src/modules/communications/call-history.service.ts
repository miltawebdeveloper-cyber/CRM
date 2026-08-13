import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { CommDirection, Prisma, Role } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { OpenPhoneService } from '../openphone/openphone.service';

export interface HistoryQuery {
  search?: string;
  direction?: 'inbound' | 'outbound';
  status?: string;
  from?: string;
  to?: string;
  leadId?: string;
  take?: number;
}

const dayStart = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 0, 0, 0, 0); };
const dayEnd = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 59, 999); };

/** Parse a yyyy-mm-dd filter, tolerating a full ISO timestamp. */
const parseFrom = (s?: string) => (s ? dayStart(s.slice(0, 10)) : undefined);
const parseTo = (s?: string) => (s ? dayEnd(s.slice(0, 10)) : undefined);

/**
 * Read side of the Calling Panel's Recordings and SMS tabs.
 *
 * Sync (quo-sync.service) writes; this only reads what's already local, so the
 * tabs stay fast and keep working when Quo is unreachable.
 */
@Injectable()
export class CallHistoryService {
  private readonly logger = new Logger(CallHistoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openphone: OpenPhoneService,
  ) {}

  private isManager(role: Role) {
    return role === Role.admin || role === Role.team_leader;
  }

  /**
   * PERM: managers see every recording; everyone else sees only calls they made.
   *
   * Employees need their own recordings to review their work, but a rep must not
   * be able to listen to a colleague's calls — so this scopes rather than blocks,
   * the same rule Calls Made and the SMS list already apply.
   */
  private recordingScope(user: { id: string; role: Role }): Prisma.CallWhereInput {
    return this.isManager(user.role) ? {} : { callerId: user.id };
  }

  /**
   * Recordings list for the tab. Only calls that actually have a recording are
   * returned — "display the recording only if it is available for that call".
   */
  async listRecordings(q: HistoryQuery, user: { id: string; role: Role }) {
    const where: Prisma.CallWhereInput = { recordings: { some: {} }, ...this.recordingScope(user) };
    if (q.leadId) where.leadId = q.leadId;
    if (q.direction) where.direction = q.direction as CommDirection;
    const from = parseFrom(q.from);
    const to = parseTo(q.to);
    if (from || to) where.startTime = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
    // Search across the customer's name and number, the agent who called, and the
    // AI summary + transcript text (so a keyword only spoken on the call matches).
    const search = q.search?.trim();
    if (search) {
      where.OR = [
        { lead: { businessName: { contains: search, mode: 'insensitive' } } },
        { lead: { contactName: { contains: search, mode: 'insensitive' } } },
        { lead: { phone: { contains: search } } },
        { caller: { name: { contains: search, mode: 'insensitive' } } },
        { insight: { summaryText: { contains: search, mode: 'insensitive' } } },
        { insight: { transcriptText: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const calls = await this.prisma.call.findMany({
      where,
      include: {
        lead: { select: { id: true, businessName: true, contactName: true, phone: true } },
        caller: { select: { name: true } },
        recordings: { orderBy: [{ startTime: 'asc' }, { createdAt: 'asc' }] },
        // Only the status — the full summary/transcript JSON is fetched on demand
        // when the manager opens a recording, keeping the list query light.
        insight: { select: { status: true } },
      },
      orderBy: { startTime: 'desc' },
      take: Math.min(q.take ?? 200, 500),
    });

    return calls.map((c) => ({
      callId: c.id,
      // Null on an unknown call — recorded, playable, and simply not attached to
      // anybody's lead. The tab shows the number instead of a name.
      leadId: c.lead?.id ?? null,
      customerName: c.lead?.contactName || c.lead?.businessName || 'Unknown caller',
      businessName: c.lead?.businessName ?? null,
      phone: c.lead?.phone ?? c.externalNumber ?? '',
      at: c.startTime,
      direction: c.direction,
      status: c.status,
      // Prefer the call's own duration; fall back to the segments' total.
      durationSecs: c.durationSecs ?? c.recordings.reduce((a, r) => a + (r.durationSecs ?? 0), 0),
      by: c.caller?.name ?? null,
      // Caller identity the customer saw. Null on legacy outbound calls placed
      // before the line was recorded — the tab flags those so a manager can verify.
      from: c.fromNumber,
      recordings: c.recordings.map((r) => ({
        id: r.id,
        durationSecs: r.durationSecs,
        mimeType: r.mimeType,
        status: r.status,
      })),
      // AI Summary + Transcript status. 'ready' means both are available; the full
      // content is loaded when the manager opens the recording's insight.
      insight: c.insight ? { status: c.insight.status } : null,
    }));
  }

  /**
   * SMS history. Employees are scoped to leads assigned to them, matching how
   * every other cross-lead list in the app treats callers.
   */
  /**
   * WHERE shared by the SMS list and its status facet counts, so the menu can
   * never describe a different set of messages than the list.
   *
   * `includeStatus: false` deliberately drops the status filter for the facets:
   * counting statuses within the status you already picked would collapse the
   * menu to that one option, leaving no way to switch away from it.
   */
  private smsWhere(q: HistoryQuery, user: { id: string; role: Role }, includeStatus = true): Prisma.MessageWhereInput {
    const where: Prisma.MessageWhereInput = {};
    if (q.leadId) where.leadId = q.leadId;
    if (q.direction) where.direction = q.direction as CommDirection;
    if (includeStatus && q.status) where.status = q.status;
    if (user.role === Role.employee) where.lead = { assignedToId: user.id };

    const from = parseFrom(q.from);
    const to = parseTo(q.to);
    if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };

    const search = q.search?.trim();
    if (search) {
      where.OR = [
        { body: { contains: search, mode: 'insensitive' } },
        { fromNumber: { contains: search } },
        { toNumber: { contains: search } },
        { lead: { businessName: { contains: search, mode: 'insensitive' } } },
        { lead: { phone: { contains: search } } },
      ];
    }
    return where;
  }

  async listSms(q: HistoryQuery, user: { id: string; role: Role }) {
    const where = this.smsWhere(q, user);

    const messages = await this.prisma.message.findMany({
      where,
      include: {
        lead: { select: { id: true, businessName: true, contactName: true, phone: true } },
        sender: { select: { name: true, openphoneNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(q.take ?? 300, 1000),
    });

    return messages.map((m) => ({
      id: m.id,
      leadId: m.leadId,
      businessName: m.lead?.businessName ?? null,
      customerName: m.lead?.contactName || m.lead?.businessName || null,
      direction: m.direction,
      body: m.body,
      from: m.fromNumber,
      to: m.toNumber,
      status: m.status,
      conversationId: m.conversationId,
      at: m.createdAt,
      // Who sent it, and whether it went out from that agent's own assigned line.
      // Only meaningful for outbound sends with a known sender + assigned number.
      by: m.sender?.name ?? null,
      senderMismatch:
        m.direction === CommDirection.outbound &&
        !!m.sender?.openphoneNumber &&
        m.fromNumber !== m.sender.openphoneNumber,
    }));
  }

  /**
   * Statuses present in the CURRENT view — drives the SMS status filter.
   * Faceted on the same search/direction/date scope as the list, so the counts
   * match what's on screen rather than the whole workspace.
   */
  async smsStatuses(q: HistoryQuery, user: { id: string; role: Role }) {
    const where = this.smsWhere(q, user, false);
    const rows = await this.prisma.message.groupBy({ by: ['status'], where, _count: { _all: true } });
    return rows
      .filter((r) => r.status)
      .map((r) => ({ status: r.status as string, count: r._count._all }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Fetch a recording's audio through the API rather than handing the browser the
   * provider URL: it keeps the manager-only rule enforceable server-side and
   * avoids leaking a provider link that may outlive the user's session.
   */
  async recordingAudio(recordingId: string, user: { id: string; role: Role }): Promise<{ body: Buffer; mimeType: string; filename: string }> {
    const rec = await this.prisma.callRecording.findUnique({
      where: { id: recordingId },
      include: { call: { include: { lead: { select: { businessName: true, phone: true } } } } },
    });
    if (!rec) throw new NotFoundException('Recording not found');
    // Ownership is checked here, on every play and download — the list query's
    // scope can't protect a URL somebody guessed or kept from an earlier session.
    if (!this.isManager(user.role) && rec.call.callerId !== user.id) {
      throw new ForbiddenException('That recording belongs to another caller');
    }
    return this.loadAudio(rec);
  }

  /**
   * Fetch a recording's audio bytes for server-side use (transcription), with no
   * permission check — callers are internal (CallInsightsService), not the browser.
   * Returns null instead of throwing so a failed fetch just skips transcription.
   */
  async recordingAudioInternal(recordingId: string): Promise<{ body: Buffer; mimeType: string; filename: string } | null> {
    const rec = await this.prisma.callRecording.findUnique({
      where: { id: recordingId },
      include: { call: { include: { lead: { select: { businessName: true, phone: true } } } } },
    });
    if (!rec) return null;
    try {
      return await this.loadAudio(rec);
    } catch (err) {
      this.logger.warn(`Recording audio unavailable for transcription (${recordingId}): ${(err as Error).message}`);
      return null;
    }
  }

  /** Resolve a recording row to its audio bytes (sandbox tone, or the signed
   *  provider URL with a one-time refresh if the stored URL has expired). */
  private async loadAudio(
    rec: Prisma.CallRecordingGetPayload<{ include: { call: { include: { lead: { select: { businessName: true; phone: true } } } } } }>,
  ): Promise<{ body: Buffer; mimeType: string; filename: string }> {
    const stamp = (rec.startTime ?? rec.call.startTime).toISOString().slice(0, 19).replace(/[:T]/g, '-');
    // An unknown call has no business name to file the download under, so it is
    // named after the number that rang — still identifiable, still unique.
    const safeName = (rec.call.lead?.businessName || rec.call.externalNumber || 'recording')
      .replace(/[^\w.-]+/g, '_')
      .slice(0, 40);

    if (rec.url.startsWith('sandbox://')) {
      const secs = Number(new URL(rec.url).searchParams.get('d') ?? 10);
      return { body: this.sandboxTone(secs), mimeType: 'audio/wav', filename: `${safeName}_${stamp}.wav` };
    }

    let res = await this.fetchAudio(rec.url);

    // Quo serves recordings from share.quo.com behind a `sig` query param. The
    // signature is stable, so the stored URL normally keeps working — but if it
    // is ever rejected, ask the API for a fresh one and retry once before failing.
    if (!res.ok && [401, 403, 404, 410].includes(res.status) && rec.call.quoCallId) {
      const fresh = await this.openphone.getCallRecordings(rec.call.quoCallId);
      const match = (fresh.data ?? []).find((r) => r.id === rec.quoRecordingId) ?? (fresh.data ?? [])[0];
      if (match?.url && match.url !== rec.url) {
        this.logger.log(`Refreshed expired recording URL for ${rec.id}`);
        await this.prisma.callRecording.update({ where: { id: rec.id }, data: { url: match.url } });
        res = await this.fetchAudio(match.url);
      }
    }

    if (!res.ok) {
      this.logger.warn(`Recording fetch failed (${res.status}) for ${rec.id}`);
      throw new NotFoundException(`Recording is unavailable from the provider (HTTP ${res.status})`);
    }
    const mimeType = rec.mimeType || res.headers.get('content-type') || 'audio/mpeg';
    const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('ogg') ? 'ogg' : 'mp3';
    return {
      body: Buffer.from(await res.arrayBuffer()),
      mimeType,
      filename: `${safeName}_${stamp}.${ext}`,
    };
  }

  /**
   * Recording audio lives on a signed share host (share.quo.com?sig=…) where the
   * signature — not our key — is the authorization. So credentials go ONLY to the
   * API host itself; they are never sent to whatever host a stored URL points at.
   */
  private fetchAudio(url: string) {
    const headers: Record<string, string> = {};
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      throw new NotFoundException('Recording URL is invalid');
    }
    if (/^api\.(openphone|quo)\.com$/.test(host) && process.env.OPENPHONE_API_KEY) {
      headers.Authorization = process.env.OPENPHONE_API_KEY;
    }
    return fetch(url, { headers });
  }

  /**
   * A short tone standing in for real audio in sandbox mode, so the player,
   * scrubber and download are demonstrable without Quo credentials.
   */
  private sandboxTone(seconds: number): Buffer {
    const rate = 8000;
    const secs = Math.max(1, Math.min(seconds || 10, 30));
    const samples = rate * secs;
    const data = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      const t = i / rate;
      // Two alternating tones with a soft envelope — reads as "audio", not a buzz.
      const freq = Math.floor(t * 2) % 2 === 0 ? 440 : 350;
      const env = Math.min(1, t * 4, (secs - t) * 4);
      data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * t) * 6000 * env), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
  }
}
