import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import * as crypto from 'crypto';
import { CommDirection, Timezone, LeadStatus, Prisma } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { OpenPhoneService } from '../openphone/openphone.service';

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const digits = (v: string) => v.replace(/\D/g, '');

@Injectable()
export class CommunicationsService {
  private readonly logger = new Logger(CommunicationsService.name);
  private fallbackAdminId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly openphone: OpenPhoneService,
  ) {}

  // ── Webhook signature (HMAC-SHA256 of the raw body) ──
  get webhookSecret() {
    return process.env.QUO_WEBHOOK_SECRET || process.env.OPENPHONE_WEBHOOK_SECRET || '';
  }

  /**
   * Verify a webhook signature.
   *
   * OpenPhone/Quo scheme: the `openphone-signature` header is
   * `hmac;<version>;<timestamp>;<digest>`. The digest is base64(HMAC-SHA256)
   * where the KEY is the base64-DECODED signing secret and the signed data is
   * `${timestamp}.${rawBody}`. Falls back to a plain hex/base64 HMAC of the raw
   * body (secret as a UTF-8 key) for simpler/other providers.
   */
  verifySignature(raw: Buffer | string, signature?: string): boolean {
    const secret = this.webhookSecret;
    if (!secret) {
      this.logger.warn('No QUO_WEBHOOK_SECRET set — accepting webhook unverified (dev only)');
      return true;
    }
    if (!signature) {
      this.logger.warn('Webhook rejected: no signature header present');
      return false;
    }
    const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const eq = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

    const parts = signature.split(';');
    // OpenPhone/Quo: hmac;version;timestamp;digest
    if (parts.length >= 4) {
      const timestamp = parts[2];
      const digest = parts[3];
      const key = Buffer.from(secret, 'base64');
      const signed = Buffer.concat([Buffer.from(`${timestamp}.`), body]);
      const computed = crypto.createHmac('sha256', key).update(signed).digest('base64');
      const ok = eq(digest, computed);
      if (!ok) this.logger.warn('Webhook rejected: OpenPhone signature mismatch');
      return ok;
    }

    // Fallback: plain HMAC of the raw body, secret used as a UTF-8 key.
    const provided = signature.replace(/^sha256=/, '');
    const hex = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const b64 = Buffer.from(hex, 'hex').toString('base64');
    const ok = eq(provided, hex) || eq(provided, b64);
    if (!ok) this.logger.warn('Webhook rejected: signature mismatch');
    return ok;
  }

  // ── Event dispatch ──
  async handleEvent(payload: Json) {
    const type = str(payload.type) ?? '';
    const data = (payload.data as Json) ?? {};
    const obj = ((data.object as Json) ?? data) as Json;
    this.logger.log(`Quo webhook: ${type}`);

    if (type.startsWith('message.')) return this.handleMessage(type, obj);
    if (type.startsWith('call.')) return this.handleCall(type, obj);
    if (type.startsWith('contact.')) return this.handleContact(obj);
    return { ignored: type };
  }

  private async resolveCallerId(assignedToId: string | null): Promise<string> {
    if (assignedToId) return assignedToId;
    if (!this.fallbackAdminId) {
      const admin = await this.prisma.user.findFirst({ where: { role: 'admin' }, select: { id: true } });
      this.fallbackAdminId = admin?.id ?? (await this.prisma.user.findFirst({ select: { id: true } }))!.id;
    }
    return this.fallbackAdminId;
  }

  /**
   * Owner of an inbound call: the agent who most recently called this customer
   * (outbound) before it. That way a missed call is assigned to whoever was
   * working the lead, not a fallback admin. Falls back to the lead's assignee,
   * then an admin.
   */
  private async resolveInboundOwner(leadId: string, assignedToId: string | null): Promise<string> {
    const lastOutbound = await this.prisma.call.findFirst({
      where: { leadId, direction: CommDirection.outbound },
      orderBy: { startTime: 'desc' },
      select: { callerId: true },
    });
    return lastOutbound?.callerId ?? (await this.resolveCallerId(assignedToId));
  }

  /** Find a lead by phone (last 10 digits) or create a minimal one. */
  private async findOrCreateLeadByPhone(phone: string) {
    const last10 = digits(phone).slice(-10);
    let lead = last10
      ? await this.prisma.lead.findFirst({ where: { deletedAt: null, phone: { contains: last10 } } })
      : null;
    if (!lead) {
      lead = await this.prisma.lead.create({
        data: {
          leadId: `L-${Date.now().toString(36).toUpperCase()}`,
          businessName: 'Unknown caller',
          phone,
          state: 'Unknown',
          city: 'Unknown',
          timezone: Timezone.EST,
          status: LeadStatus.new,
        },
      });
      this.logger.log(`Created lead from unknown caller ${phone}`);
    }
    return lead;
  }

  private dir(v: unknown): CommDirection {
    return v === 'incoming' || v === 'inbound' ? CommDirection.inbound : CommDirection.outbound;
  }

  private async touchLead(leadId: string) {
    await this.prisma.lead.update({ where: { id: leadId }, data: { lastCommunicationAt: new Date() } });
  }

  /**
   * Mirror a webhook-delivered recording into call_recordings so it shows up in
   * the Calling Panel's Recordings tab, which reads segments rather than the
   * single Call.recordingUrl column. Keyed on the URL so repeated call.* events
   * for the same recording don't stack up duplicate rows.
   */
  private async linkRecording(callId: string, url: string, durationSecs?: number | null) {
    const exists = await this.prisma.callRecording.findFirst({ where: { callId, url }, select: { id: true } });
    if (exists) return;
    await this.prisma.callRecording.create({
      data: { callId, url, durationSecs: durationSecs ?? null, status: 'completed', startTime: new Date() },
    });
  }

  // ── Messages (SMS) ──
  private async handleMessage(type: string, o: Json) {
    const direction = this.dir(o.direction);
    const from = str(o.from) ?? '';
    const to = Array.isArray(o.to) ? str(o.to[0]) ?? '' : str(o.to) ?? '';
    const external = direction === CommDirection.inbound ? from : to;
    if (!external) return { ignored: 'no phone' };

    const lead = await this.findOrCreateLeadByPhone(external);
    const quoMessageId = str(o.id);
    const status = str(o.status) ?? (type === 'message.received' ? 'received' : 'sent');
    const body = str(o.body) ?? str(o.text) ?? '';

    const existing = quoMessageId
      ? await this.prisma.message.findFirst({ where: { quoMessageId } })
      : null;
    if (existing) {
      await this.prisma.message.update({ where: { id: existing.id }, data: { status } });
    } else {
      await this.prisma.message.create({
        data: { leadId: lead.id, direction, body, fromNumber: from, toNumber: to, status, quoMessageId, conversationId: str(o.conversationId) },
      });
    }
    await this.touchLead(lead.id);
    return { ok: true, leadId: lead.id };
  }

  // ── Calls ──
  private async handleCall(type: string, o: Json) {
    const quoCallId = str(o.id);
    const existing = quoCallId ? await this.prisma.call.findFirst({ where: { quoCallId } }) : null;

    const recordingUrl = str(o.recordingUrl) ?? str((o.recording as Json)?.url);
    const transcript = str(o.transcript) ?? str((o.transcript as Json)?.text);
    const aiSummary = str(o.summary) ?? str((o.aiSummary as Json)?.text) ?? str(o.aiSummary);
    // Normalize the live phase from the event type when the provider omits an
    // explicit status — drives the in-CRM widget's Ringing/Connected/Hold states.
    const statusFromType =
      type.includes('ringing') ? 'ringing'
      : type.includes('unhold') ? 'in-progress'
      : type.includes('hold') ? 'on_hold'
      : type.includes('answered') || type.includes('in-progress') || type.includes('in_progress') ? 'in-progress'
      : type.includes('completed') || type.includes('ended') ? 'completed'
      : '';
    const status = str(o.status) ?? statusFromType;
    // Quo's exact field name for duration is unknown — tolerate the variants.
    const durationSecs =
      typeof o.duration === 'number' ? (o.duration as number)
      : typeof o.durationSec === 'number' ? (o.durationSec as number)
      : typeof o.durationSecs === 'number' ? (o.durationSecs as number)
      : undefined;
    const isFinal = type.includes('completed') || type.includes('ended') || durationSecs != null;

    // Known call (e.g. one placed via the Quo queue) — enrich it in place. No
    // phone lookup needed; the call already knows its lead. This is the main
    // path for call.completed / recording / transcript / summary events.
    if (existing) {
      await this.prisma.call.update({
        where: { id: existing.id },
        data: {
          ...(status ? { status } : {}),
          ...(durationSecs != null ? { durationSecs } : {}),
          recordingUrl: recordingUrl ?? undefined,
          transcript: transcript ?? undefined,
          aiSummary: aiSummary ?? undefined,
          ...(isFinal ? { endTime: new Date() } : {}),
        },
      });
      if (recordingUrl) await this.linkRecording(existing.id, recordingUrl, durationSecs);
      await this.touchLead(existing.leadId);
      return { ok: true, callId: existing.id };
    }

    // New / inbound call from the provider — needs a phone to resolve the lead.
    const direction = this.dir(o.direction);
    const from = str(o.from) ?? '';
    const to = Array.isArray(o.to) ? str(o.to[0]) ?? '' : str(o.to) ?? '';
    const external = direction === CommDirection.inbound ? from : to;
    if (!external) return { ignored: 'no phone' };

    const lead = await this.findOrCreateLeadByPhone(external);
    // Inbound calls are owned by whoever last called this customer (so missed
    // calls land with the right agent); outbound falls back to the assignee.
    const callerId =
      direction === CommDirection.inbound
        ? await this.resolveInboundOwner(lead.id, lead.assignedToId)
        : await this.resolveCallerId(lead.assignedToId);
    const startTime = o.createdAt ? new Date(o.createdAt as string) : new Date();
    const created = await this.prisma.call.create({
      data: {
        leadId: lead.id, callerId, direction, status, durationSecs,
        recordingUrl: recordingUrl ?? undefined, transcript: transcript ?? undefined, aiSummary: aiSummary ?? undefined,
        quoCallId, conversationId: str(o.conversationId),
        startTime, endTime: durationSecs != null ? new Date() : null,
      },
    });
    if (recordingUrl) await this.linkRecording(created.id, recordingUrl, durationSecs);
    await this.touchLead(lead.id);

    // Workflow: missed inbound call → follow-up task for the owner.
    const missed = ['missed', 'no-answer', 'no_answer'].includes(status) || (direction === CommDirection.inbound && durationSecs === 0);
    if (missed) {
      await this.prisma.task.create({
        data: { title: `Follow up: missed call from ${lead.businessName} (${external})`, ownerId: callerId, priority: 'high' },
      });
    }
    return { ok: true, callId: created.id, missed };
  }

  // ── Contacts ──
  private async handleContact(o: Json) {
    const phones = Array.isArray(o.phoneNumbers) ? o.phoneNumbers : [];
    const phone = str(o.phoneNumber) ?? str((phones[0] as Json)?.value) ?? str(phones[0]);
    if (!phone) return { ignored: 'no phone' };
    const lead = await this.findOrCreateLeadByPhone(phone);
    await this.prisma.lead.update({ where: { id: lead.id }, data: { quoContactId: str(o.id) } });
    return { ok: true, leadId: lead.id };
  }

  // ── Outbound: SMS ──
  /** Send an SMS to a lead and record it on the timeline. */
  async sendSms(leadId: string, body: string, callerId?: string, from?: string) {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, deletedAt: null } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (!body?.trim()) throw new BadRequestException('Message body is required');

    // Resolve a "from" number, in order of precedence:
    //  1. explicit override, 2. the caller's admin-assigned OpenPhone number,
    //  3. the first workspace number.
    let fromNumber = from;
    if (!fromNumber && callerId) {
      const caller = await this.prisma.user.findUnique({ where: { id: callerId }, select: { openphoneNumber: true } });
      fromNumber = caller?.openphoneNumber ?? undefined;
    }
    if (!fromNumber) {
      const status = await this.openphone.status();
      fromNumber = status.phoneNumbers[0]?.number;
    }
    if (!fromNumber) throw new BadRequestException('No OpenPhone number available to send from');

    const result = await this.openphone.sendSms({ from: fromNumber, to: [lead.phone], content: body });
    const data = result.data as { id?: string; status?: string } | undefined;
    const message = await this.prisma.message.create({
      data: {
        leadId: lead.id,
        direction: CommDirection.outbound,
        body,
        fromNumber,
        toNumber: lead.phone,
        status: result.success ? data?.status ?? 'queued' : 'failed',
        quoMessageId: data?.id,
      },
    });
    await this.touchLead(lead.id);
    return { success: result.success, message, error: result.success ? null : result.error ?? null };
  }

  // ── Outbound: click-to-call ──
  /**
   * Start an outbound call. Quo/OpenPhone exposes no API to place a call, so
   * outbound is an app-handoff: the CRM logs the call and hands the number to the
   * agent's OpenPhone dialer via a tel: link, staying the live monitor. The
   * resulting call.* webhook enriches this Call record with status, duration,
   * recording, transcript and AI summary.
   */
  async startCall(leadId: string, callerId: string) {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, deletedAt: null } });
    if (!lead) throw new NotFoundException('Lead not found');

    // The caller's admin-assigned OpenPhone number is the line they dial from.
    const caller = await this.prisma.user.findUnique({ where: { id: callerId }, select: { openphoneNumber: true } });
    const call = await this.prisma.call.create({
      data: {
        leadId: lead.id,
        callerId,
        direction: CommDirection.outbound,
        status: 'initiated',
        startTime: new Date(),
      },
    });
    await this.prisma.activity.create({
      data: {
        leadId: lead.id,
        userId: callerId,
        action: 'call_started',
        newValue: 'initiated',
        remarks: caller?.openphoneNumber
          ? `Outbound call to ${lead.phone} from ${caller.openphoneNumber} (via OpenPhone dialer)`
          : `Outbound call to ${lead.phone} (via OpenPhone dialer)`,
      },
    });
    await this.touchLead(lead.id);
    return { callId: call.id, tel: `tel:${lead.phone}`, phone: lead.phone };
  }

  // ── Unified conversation timeline for a lead ──
  // PERM: recordings / transcripts / AI summaries are redacted unless the
  // caller may view them (admin + team leader). Pass canViewRecordings.
  async getTimeline(leadId: string, canViewRecordings = true) {
    const [calls, messages, notes] = await Promise.all([
      this.prisma.call.findMany({ where: { leadId }, include: { caller: { select: { name: true } } }, orderBy: { startTime: 'desc' }, take: 100 }),
      this.prisma.message.findMany({ where: { leadId }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.prisma.note.findMany({ where: { leadId }, include: { createdBy: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
    ]);

    const items = [
      ...calls.map((c) => ({
        kind: 'call' as const, id: c.id, at: c.startTime, direction: c.direction, status: c.status,
        durationSecs: c.durationSecs,
        recordingUrl: canViewRecordings ? c.recordingUrl : null,
        transcript: canViewRecordings ? c.transcript : null,
        aiSummary: canViewRecordings ? c.aiSummary : null,
        by: c.caller?.name ?? null,
      })),
      ...messages.map((m) => ({ kind: 'message' as const, id: m.id, at: m.createdAt, direction: m.direction, body: m.body, status: m.status })),
      ...notes.map((n) => ({ kind: 'note' as const, id: n.id, at: n.createdAt, body: n.noteText, by: n.createdBy?.name ?? null })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    return items;
  }

  // ── Outbound: dial-pad call to an arbitrary number ──
  /** Place a call to a typed number: resolve (or create) the lead, then dial. */
  async startCallByPhone(phone: string, callerId: string) {
    const trimmed = phone?.trim();
    if (!trimmed || digits(trimmed).length < 3) throw new BadRequestException('A valid phone number is required');
    const lead = await this.findOrCreateLeadByPhone(trimmed);
    const result = await this.startCall(lead.id, callerId);
    return {
      ...result,
      lead: { id: lead.id, businessName: lead.businessName, phone: lead.phone, city: lead.city, state: lead.state },
    };
  }

  // ── Live call state (polled by the in-CRM call widget) ──
  // Cockpit model: the queue/provider places the call; the CRM is the single
  // interface showing live state. Until real provider webhooks drive the status
  // (i.e. sandbox or no queue configured), the phase is simulated deterministically
  // from elapsed time so the whole experience is demoable without a live provider.
  async getCallState(callId: string, userId: string, role: string) {
    const call = await this.prisma.call.findUnique({
      where: { id: callId },
      include: {
        lead: { select: { id: true, businessName: true, phone: true, city: true, state: true } },
        caller: { select: { name: true } },
      },
    });
    if (!call) throw new NotFoundException('Call not found');
    if (role !== 'admin' && role !== 'team_leader' && call.callerId !== userId) {
      throw new ForbiddenException('Not your call');
    }

    const raw = (call.status ?? '').toLowerCase();
    const terminal = ['completed', 'ended', 'failed', 'missed', 'no-answer', 'no_answer', 'canceled', 'cancelled'];
    const ended = !!call.endTime || terminal.includes(raw);
    // Outbound is an app-handoff with no API-driven live state, so live phases are
    // simulated from elapsed time. Real inbound statuses (from call.* webhooks) are
    // honored above via `raw` before this time-based fallback applies.
    const simulated = true;
    const elapsedMs = Date.now() - call.startTime.getTime();

    type Phase = 'initiated' | 'ringing' | 'connected' | 'on_hold' | 'ended';
    let phase: Phase;
    if (ended) phase = 'ended';
    else if (['hold', 'on_hold', 'on-hold'].includes(raw)) phase = 'on_hold';
    else if (['in-progress', 'in_progress', 'answered', 'connected', 'ongoing', 'active'].includes(raw)) phase = 'connected';
    else if (raw === 'ringing') phase = 'ringing';
    else if (simulated) phase = elapsedMs < 2000 ? 'initiated' : elapsedMs < 4500 ? 'ringing' : 'connected';
    else phase = 'initiated';

    const connected = phase === 'connected' || phase === 'on_hold';
    // Simulated calls "connect" ~4.5s in; don't count the ring time as talk time.
    const talkSecs = Math.max(0, Math.round(elapsedMs / 1000) - (simulated ? 4 : 0));
    const durationSecs = ended
      ? call.durationSecs ?? Math.max(0, Math.round(((call.endTime ?? new Date()).getTime() - call.startTime.getTime()) / 1000))
      : connected
        ? talkSecs
        : 0;

    const canViewRecordings = role === 'admin' || role === 'team_leader';
    return {
      callId: call.id,
      phase,
      status: call.status,
      onHold: phase === 'on_hold',
      startedAt: call.startTime,
      endedAt: call.endTime,
      durationSecs: Math.max(0, durationSecs),
      recordingUrl: canViewRecordings ? call.recordingUrl : null,
      lead: call.lead,
      by: call.caller?.name ?? null,
    };
  }

  // ── Incoming-call popup: most recent inbound call in the last 60s ──
  async latestIncoming(userId: string, role: string) {
    const since = new Date(Date.now() - 60_000);
    const where: { direction: CommDirection; startTime: { gte: Date }; lead?: { assignedToId: string } } = {
      direction: CommDirection.inbound,
      startTime: { gte: since },
    };
    if (role === 'employee') where.lead = { assignedToId: userId }; // callers only see their own
    const call = await this.prisma.call.findFirst({
      where,
      include: { lead: { select: { id: true, businessName: true, phone: true, city: true, state: true, status: true } } },
      orderBy: { startTime: 'desc' },
    });
    if (!call) return null;
    // "Connected" = Quo reports the call as live/answered (drives the popup's
    // auto-open). Conservative allowlist so ringing/initiated don't trigger it.
    const connected = ['in-progress', 'in_progress', 'answered', 'connected', 'ongoing', 'active'].includes((call.status ?? '').toLowerCase());
    return { callId: call.id, at: call.startTime, status: call.status, connected, lead: call.lead };
  }

  // ── Missed calls (dashboard "Missed Calls" widget) ──
  /** Recent missed inbound calls. Employees see only the ones assigned to them
   *  (i.e. calls attributed to them via resolveInboundOwner); managers see all. */
  async getMissedCalls(userId: string, role: string, limit = 20) {
    const where: Prisma.CallWhereInput = {
      direction: CommDirection.inbound,
      OR: [{ status: { in: ['missed', 'no-answer', 'no_answer'] } }, { durationSecs: 0 }],
    };
    if (role === 'employee') where.callerId = userId;
    const calls = await this.prisma.call.findMany({
      where,
      include: {
        lead: { select: { id: true, businessName: true, phone: true, city: true, state: true } },
        caller: { select: { id: true, name: true } },
      },
      orderBy: { startTime: 'desc' },
      take: limit,
    });
    return calls.map((c) => ({
      id: c.id,
      at: c.startTime,
      leadId: c.lead.id,
      businessName: c.lead.businessName,
      phone: c.lead.phone,
      status: c.status,
      assignedTo: c.caller?.name ?? null,
      assignedToId: c.callerId,
    }));
  }

  // ── Communication analytics ──
  private periodStart(period: string): Date {
    const now = new Date();
    if (period === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (period === 'month') return new Date(now.getTime() - 30 * 86400000);
    if (period === 'all') return new Date(0);
    return new Date(now.getTime() - 7 * 86400000); // default: week
  }

  async getAnalytics(period = 'week') {
    const since = this.periodStart(period);
    const [calls, messages] = await Promise.all([
      this.prisma.call.findMany({ where: { startTime: { gte: since } }, select: { direction: true, status: true, durationSecs: true, startTime: true } }),
      this.prisma.message.findMany({ where: { createdAt: { gte: since } }, select: { direction: true, createdAt: true } }),
    ]);

    const isMissed = (c: { status: string | null; direction: 'inbound' | 'outbound' | null; durationSecs: number | null }) =>
      ['missed', 'no-answer', 'no_answer'].includes(c.status ?? '') || (c.direction === 'inbound' && c.durationSecs === 0);
    const talk = calls.reduce((a, c) => a + (c.durationSecs ?? 0), 0);
    const answered = calls.filter((c) => (c.durationSecs ?? 0) > 0).length;

    // Per-day series across the period (cap 30 buckets).
    const days = Math.min(30, Math.max(1, Math.ceil((Date.now() - since.getTime()) / 86400000)));
    const series = Array.from({ length: days }, (_, i) => {
      const d = new Date(Date.now() - (days - 1 - i) * 86400000);
      const key = d.toISOString().slice(0, 10);
      return {
        date: key,
        calls: calls.filter((c) => c.startTime.toISOString().slice(0, 10) === key).length,
        messages: messages.filter((m) => m.createdAt.toISOString().slice(0, 10) === key).length,
      };
    });

    return {
      period,
      calls: {
        total: calls.length,
        inbound: calls.filter((c) => c.direction === 'inbound').length,
        outbound: calls.filter((c) => c.direction === 'outbound').length,
        missed: calls.filter(isMissed).length,
        avgDurationSecs: answered ? Math.round(talk / answered) : 0,
        totalTalkSecs: talk,
      },
      messages: {
        total: messages.length,
        inbound: messages.filter((m) => m.direction === 'inbound').length,
        outbound: messages.filter((m) => m.direction === 'outbound').length,
      },
      series,
    };
  }
}
