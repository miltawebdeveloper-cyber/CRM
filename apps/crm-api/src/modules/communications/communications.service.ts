import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import * as crypto from 'crypto';
import { CommDirection, Timezone, LeadStatus, Prisma } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { OpenPhoneService } from '../openphone/openphone.service';
import { CallInsightsService } from './call-insights.service';

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const digits = (v: string) => v.replace(/\D/g, '');

/**
 * Normalise a phone number to E.164 for the OpenPhone API, which rejects `from`/`to`
 * that aren't E.164 ("Expected string to match '^\+[1-9]…'"). A `PN…` phone-number id
 * is left as-is (OpenPhone accepts that form too). US-centric, matching the workspace lines.
 */
const toE164 = (raw: string): string => {
  const t = (raw ?? '').trim();
  if (/^PN/.test(t)) return t; // already an OpenPhone phone-number id
  const d = t.replace(/\D/g, '');
  if (!d) return t;
  if (t.startsWith('+')) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return `+${d}`;
};

/**
 * Quo's documented deep link for placing a call:
 * `openphone://dial?number=<e164>&from=<line>&action=call`.
 *
 * Returned to the client so a call always reaches the Quo app. Deliberately not a
 * `tel:` URL — `tel:` is handed to whatever the OS registered as the default
 * calling app, which is routinely a browser page or a "how do you want to open
 * this?" chooser, and browser redirection is exactly what calling must never do.
 * The scheme is brand-specific (OpenPhone `openphone://`, Quo `quo://`), hence
 * the env override.
 */
const quoDialUrl = (phone: string, from?: string): string => {
  const number = toE164(phone);
  const line = from?.trim() ? toE164(from) : '';
  // QUO_DIAL_TEMPLATE overrides the whole URL ({number}/{from} placeholders), so a
  // deployment can adapt to a different app build without a code change — the
  // vendor documents this scheme for its mobile apps only.
  const template = process.env.QUO_DIAL_TEMPLATE?.trim();
  if (template) {
    return template.replace('{number}', encodeURIComponent(number)).replace('{from}', encodeURIComponent(line));
  }
  const scheme = (process.env.QUO_APP_SCHEME ?? 'openphone://').replace(/:\/\/.*$/, '').replace(/:$/, '');
  const params = new URLSearchParams({ number });
  if (line) params.set('from', line);
  params.set('action', 'call');
  return `${scheme}://dial?${params.toString()}`;
};

/** AppSetting row holding the calling on/off switch (JSON blob, no migration). */
const CALLING_MODE_KEY = 'calling:mode';

export interface CallingMode {
  /**
   * When false the CRM places NO calls: the Quo handoff, the queue's auto-dial and
   * every dial button are switched off, while the queue itself — lead card, notes,
   * outcome, save-and-advance — keeps working. A temporary lead-processing mode,
   * not a removal: nothing is deleted, and flipping this back restores calling.
   */
  callingEnabled: boolean;
  /** Shown to agents wherever a dial button used to be, so the silence is explained. */
  disabledReason: string;
}

const CALLING_MODE_DEFAULT: CallingMode = {
  callingEnabled: true,
  disabledReason: 'Calling is temporarily disabled — process the queue and save your notes as usual.',
};

@Injectable()
export class CommunicationsService {
  private readonly logger = new Logger(CommunicationsService.name);
  private fallbackAdminId: string | null = null;

  // Last webhook the provider actually delivered — the single fact that tells you
  // whether Quo's real-time push is reaching the CRM at all, or whether inbound
  // calls are only ever arriving via the 10-minute REST backfill (which can never
  // drive a live incoming-call popup). Exposed read-only via GET
  // /communications/webhook/health so it's checkable without server log access.
  private lastWebhook: { at: Date; type: string } | null = null;
  private webhookCount = 0;
  // Deliveries turned away because the signature matched none of the configured
  // secrets. A steadily climbing count with deliveries also being accepted is the
  // signature of a SECOND webhook subscription in Quo signing with a different
  // secret: half of every event pair 403s and is retried forever. Counted here so
  // that diagnosis doesn't require server log access.
  private webhookRejected = 0;
  private lastRejected: { at: Date; type: string } | null = null;
  noteRejectedWebhook(type: string) {
    this.webhookRejected += 1;
    this.lastRejected = { at: new Date(), type };
  }
  get webhookHealth() {
    return {
      everReceived: this.webhookCount > 0,
      count: this.webhookCount,
      lastAt: this.lastWebhook?.at ?? null,
      lastType: this.lastWebhook?.type ?? null,
      secondsSinceLast: this.lastWebhook ? Math.round((Date.now() - this.lastWebhook.at.getTime()) / 1000) : null,
      signatureEnforced: this.webhookSecrets.length > 0,
      /** How many signing secrets are configured (a workspace may have several subscriptions). */
      secretsConfigured: this.webhookSecrets.length,
      rejected: this.webhookRejected,
      lastRejectedAt: this.lastRejected?.at ?? null,
      lastRejectedType: this.lastRejected?.type ?? null,
      /**
       * Accepted AND rejected traffic at the same time = another subscription is
       * posting here with a secret this deployment doesn't know. Fix it by adding
       * that secret to QUO_WEBHOOK_SECRET (comma-separated) or deleting the
       * duplicate subscription in Quo.
       */
      duplicateSubscriptionSuspected: this.webhookCount > 0 && this.webhookRejected > 0,
    };
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly openphone: OpenPhoneService,
    private readonly insights: CallInsightsService,
  ) {}

  // ── Calling on/off (temporary lead-processing mode) ──

  /**
   * Whether the CRM may place calls right now.
   *
   * Stored in app_settings so it is a switch an admin flips, not a deploy — the
   * whole point is that calling comes back without any development. `CALLING_DISABLED=true`
   * in the environment forces it off regardless, as a lever that works even when
   * the admin UI isn't reachable.
   */
  async getCallingMode(): Promise<CallingMode> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: CALLING_MODE_KEY } });
    const merged = { ...CALLING_MODE_DEFAULT, ...((row?.value as Partial<CallingMode> | undefined) ?? {}) };
    if (process.env.CALLING_DISABLED === 'true') merged.callingEnabled = false;
    return merged;
  }

  async saveCallingMode(patch: Partial<CallingMode>, userId: string): Promise<CallingMode> {
    const current = await this.getCallingMode();
    const next: CallingMode = {
      callingEnabled: patch.callingEnabled ?? current.callingEnabled,
      disabledReason: (patch.disabledReason ?? current.disabledReason).trim() || CALLING_MODE_DEFAULT.disabledReason,
    };
    await this.prisma.appSetting.upsert({
      where: { key: CALLING_MODE_KEY },
      create: { key: CALLING_MODE_KEY, value: { ...next } },
      update: { value: { ...next } },
    });
    // Turning dialling off for a whole team is worth a trail of who and when.
    await this.prisma.activity
      .create({
        data: {
          leadId: null,
          userId,
          action: next.callingEnabled ? 'calling_enabled' : 'calling_disabled',
          newValue: String(next.callingEnabled),
          remarks: next.callingEnabled
            ? 'Calling re-enabled — dialling restored across the CRM.'
            : `Calling temporarily disabled — queue processing continues without dialling. Reason shown to agents: ${next.disabledReason}`,
        },
      })
      .catch(() => undefined);
    return next;
  }

  /**
   * Refuse to place a call while the CRM is in lead-processing mode. Enforced in
   * the service, not just hidden in the UI: a stale tab, a queued retry or a
   * direct API call must not put a real call through when the team has been told
   * none are being made.
   */
  private async assertCallingEnabled() {
    const mode = await this.getCallingMode();
    if (!mode.callingEnabled) throw new ForbiddenException(mode.disabledReason);
  }

  // ── Webhook signature (HMAC-SHA256 of the raw body) ──
  /**
   * Every signing secret this deployment will accept.
   *
   * A Quo workspace can have MORE THAN ONE webhook subscription pointed at this
   * URL, and each one signs with its own secret — so a single configured secret
   * means half the deliveries 403 and are retried indefinitely, which is both
   * noise and a real risk of a missed event if the accepted subscription is ever
   * the one that gets deleted. Both env vars therefore take a comma- (or
   * whitespace-) separated list, and a delivery is accepted if ANY of them
   * verifies it. Deleting the duplicate subscription in Quo is still the tidier
   * fix; this makes the CRM correct either way.
   */
  get webhookSecrets(): string[] {
    return [process.env.QUO_WEBHOOK_SECRET, process.env.OPENPHONE_WEBHOOK_SECRET]
      .flatMap((v) => (v ?? '').split(/[,\s]+/))
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * Verify a webhook signature against each configured secret.
   *
   * OpenPhone/Quo scheme: the `openphone-signature` header is
   * `hmac;<version>;<timestamp>;<digest>`. The digest is base64(HMAC-SHA256)
   * where the KEY is the base64-DECODED signing secret and the signed data is
   * `${timestamp}.${rawBody}`. Falls back to a plain hex/base64 HMAC of the raw
   * body (secret as a UTF-8 key) for simpler/other providers.
   */
  verifySignature(raw: Buffer | string, signature?: string): boolean {
    const secrets = this.webhookSecrets;
    if (secrets.length === 0) {
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
      const signed = Buffer.concat([Buffer.from(`${timestamp}.`), body]);
      const ok = secrets.some((secret) =>
        eq(digest, crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(signed).digest('base64')),
      );
      if (!ok) this.warnSignatureMismatch(secrets.length);
      return ok;
    }

    // Fallback: plain HMAC of the raw body, secret used as a UTF-8 key.
    const provided = signature.replace(/^sha256=/, '');
    const ok = secrets.some((secret) => {
      const hex = crypto.createHmac('sha256', secret).update(body).digest('hex');
      return eq(provided, hex) || eq(provided, Buffer.from(hex, 'hex').toString('base64'));
    });
    if (!ok) this.warnSignatureMismatch(secrets.length);
    return ok;
  }

  /** One rejection message that names the likely cause instead of just "mismatch". */
  private warnSignatureMismatch(secretCount: number) {
    this.logger.warn(
      `Webhook rejected: signature matched none of the ${secretCount} configured signing secret(s). ` +
        'If Quo shows more than one webhook subscription for this URL, either delete the duplicate or add its ' +
        'signing secret to QUO_WEBHOOK_SECRET (comma-separated) — otherwise that subscription 403s and retries forever.',
    );
  }

  // ── Event dispatch ──
  async handleEvent(payload: Json) {
    const type = str(payload.type) ?? '';
    const data = (payload.data as Json) ?? {};
    const obj = ((data.object as Json) ?? data) as Json;
    // Stamp the delivery the moment it's accepted (after signature/token checks in
    // the controller) so webhookHealth reflects real pushes only.
    this.lastWebhook = { at: new Date(), type: type || 'unknown' };
    this.webhookCount++;
    this.logger.log(`Quo webhook: ${type}`);

    if (type.startsWith('message.')) return this.handleMessage(type, obj);
    if (type.startsWith('call.')) return this.handleCall(type, obj);
    if (type.startsWith('contact.')) return this.handleContact(obj);
    return { ignored: type };
  }

  /**
   * The caller identity an outbound communication MUST go out as: the logged-in
   * user's own admin-assigned OpenPhone line, plus their display name.
   *
   * Hard-fails when the user has no assigned number rather than falling back to a
   * shared workspace line — that silent fallback is exactly what makes a customer
   * see another employee's caller ID. The number is unique per user (DB constraint),
   * so a resolved identity always maps 1:1 to the employee placing the call.
   */
  private async resolveCallerIdentity(callerId: string): Promise<{ name: string; fromNumber: string }> {
    const caller = await this.prisma.user.findUnique({
      where: { id: callerId },
      select: { name: true, openphoneNumber: true },
    });
    if (!caller) throw new NotFoundException('Caller not found');
    const fromNumber = caller.openphoneNumber?.trim();
    if (!fromNumber) {
      throw new BadRequestException(
        'No caller ID is assigned to your account. Ask an admin to assign your OpenPhone number (Admin → Users) before placing calls, so the customer sees you as the caller.',
      );
    }
    return { name: caller.name, fromNumber };
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
   * Owner of an inbound call — i.e. whose phone is actually ringing, and therefore
   * the ONLY user who should see the incoming-call popup.
   *
   * Order matters:
   *  1. The Quo line the customer dialled (`to`). Each user's `openphoneNumber` is
   *     unique, so that number names exactly one agent — it is the closest thing
   *     the provider gives us to "this extension rang". Nothing else can override
   *     it: if the customer called Priya's number, the call is Priya's.
   *  2. The agent who last called this customer, so a returning caller reaches the
   *     person who was working them (and a missed call lands with that person).
   *  3. The lead's assignee, then an admin.
   */
  private async resolveInboundOwner(leadId: string, assignedToId: string | null, toNumber?: string | null): Promise<string> {
    const dialed = await this.userByLine(toNumber);
    if (dialed) return dialed;
    const lastOutbound = await this.prisma.call.findFirst({
      where: { leadId, direction: CommDirection.outbound },
      orderBy: { startTime: 'desc' },
      select: { callerId: true },
    });
    return lastOutbound?.callerId ?? (await this.resolveCallerId(assignedToId));
  }

  /**
   * The user who owns a Quo line. Matched on the last 10 digits because the same
   * number is written several ways (+1 555…, (555) …, 555…) between the provider's
   * payload and what an admin typed into the user record.
   */
  private async userByLine(number?: string | null): Promise<string | null> {
    const last10 = digits(number ?? '').slice(-10);
    if (last10.length < 10) return null;
    const user = await this.prisma.user.findFirst({
      where: { openphoneNumber: { contains: last10 }, isActive: true },
      select: { id: true },
    });
    return user?.id ?? null;
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

  /**
   * Direction of a webhook event.
   *
   * The payload's own field wins (case/variant tolerant). When the provider omits
   * it — or sends a value we don't recognise — fall back to the EVENT NAME rather
   * than defaulting to outbound: a `message.received` filed as outbound would
   * resolve the "customer" from our OWN workspace number, minting a junk lead and
   * hiding the message from the real conversation.
   */
  private dir(v: unknown, type = ''): CommDirection {
    const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
    if (s === 'incoming' || s === 'inbound') return CommDirection.inbound;
    if (s === 'outgoing' || s === 'outbound') return CommDirection.outbound;
    return /\.received$/.test(type) ? CommDirection.inbound : CommDirection.outbound;
  }

  private async touchLead(leadId: string) {
    await this.prisma.lead.update({ where: { id: leadId }, data: { lastCommunicationAt: new Date() } });
  }

  /**
   * Pull the recording out of a call.* payload.
   *
   * OpenPhone doesn't use one shape: `call.recording.completed` delivers segments
   * in a `media` array, while other events (and older/other providers) use a flat
   * `recordingUrl` or a nested `recording` object. Matching only the latter two
   * silently dropped every webhook-delivered recording, so accept all of them.
   */
  private recordingFrom(o: Json): { id?: string; url?: string; durationSecs?: number | null; mimeType?: string } {
    const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
    const media = (Array.isArray(o.media) ? o.media : Array.isArray(o.recordings) ? o.recordings : []) as Json[];
    const seg = media.find((m) => m && str(m.url));
    const rec = (o.recording as Json) ?? undefined;

    const url = str(o.recordingUrl) ?? (rec ? str(rec.url) : undefined) ?? (seg ? str(seg.url) : undefined);
    if (!url) return {};
    return {
      id: (rec ? str(rec.id) : undefined) ?? (seg ? str(seg.id) : undefined),
      url,
      durationSecs: num(rec?.duration) ?? num(seg?.duration) ?? null,
      mimeType: (rec ? str(rec.type) : undefined) ?? (seg ? str(seg.type) : undefined),
    };
  }

  /**
   * Mirror a webhook-delivered recording into call_recordings so it shows up in
   * the Calling Panel's Recordings tab, which reads segments rather than the
   * single Call.recordingUrl column.
   *
   * Deduped on the provider's recording id when it sends one — recording URLs are
   * signed and can change between deliveries, so keying on the URL alone would
   * stack up a duplicate row every time the same recording is re-delivered.
   */
  private async linkRecording(
    callId: string,
    rec: { id?: string; url?: string; durationSecs?: number | null; mimeType?: string },
    fallbackDuration?: number | null,
  ) {
    if (!rec.url) return;
    const durationSecs = rec.durationSecs ?? fallbackDuration ?? null;
    if (rec.id) {
      await this.prisma.callRecording.upsert({
        where: { quoRecordingId: rec.id },
        create: {
          callId, quoRecordingId: rec.id, url: rec.url, durationSecs,
          status: 'completed', startTime: new Date(), mimeType: rec.mimeType ?? null,
        },
        update: { url: rec.url, durationSecs, ...(rec.mimeType ? { mimeType: rec.mimeType } : {}) },
      });
      // A webhook-delivered recording — generate its AI summary + transcript in
      // the background, mirroring the pull-sync path.
      this.insights.enqueue(callId);
      return;
    }
    const exists = await this.prisma.callRecording.findFirst({ where: { callId, url: rec.url }, select: { id: true } });
    if (exists) return;
    await this.prisma.callRecording.create({
      data: { callId, url: rec.url, durationSecs, status: 'completed', startTime: new Date(), mimeType: rec.mimeType ?? null },
    });
    this.insights.enqueue(callId);
  }

  // ── Messages (SMS) ──
  private async handleMessage(type: string, o: Json) {
    const direction = this.dir(o.direction, type);
    const from = str(o.from) ?? '';
    const to = Array.isArray(o.to) ? str(o.to[0]) ?? '' : str(o.to) ?? '';
    const external = direction === CommDirection.inbound ? from : to;
    if (!external) return { ignored: 'no phone' };

    const lead = await this.findOrCreateLeadByPhone(external);
    const quoMessageId = str(o.id);
    const status = str(o.status) ?? (type === 'message.received' ? 'received' : 'sent');
    // OpenPhone sends the text as `text`; `body` is our own column name.
    const body = str(o.text) ?? str(o.body) ?? '';

    const existing = quoMessageId
      ? await this.prisma.message.findFirst({ where: { quoMessageId } })
      : null;
    if (existing) {
      // Also re-assert direction/lead: a message first stored from an event that
      // omitted `direction` may have been filed outbound against the wrong lead,
      // so a later event for the same id repairs it instead of leaving it broken.
      await this.prisma.message.update({
        where: { id: existing.id },
        data: { status, direction, leadId: lead.id, ...(body ? { body } : {}) },
      });
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

    const rec = this.recordingFrom(o);
    const transcript = str(o.transcript) ?? str((o.transcript as Json)?.text);
    const aiSummary = str(o.summary) ?? str((o.aiSummary as Json)?.text) ?? str(o.aiSummary);

    // Sub-events (recording / transcript / summary) arrive AFTER the call, and
    // their type ALSO contains "completed". Treating them as the call's own
    // completion re-stamps endTime with the webhook's arrival time and inflates
    // the logged duration — they enrich a call, they never end one.
    const isSubEvent = /^call\.(recording|transcript|summary|voicemail)\b/.test(type);

    // A recording event that carries no URL we recognise means the provider used
    // yet another payload shape. Say so — a silent drop here is what made missing
    // recordings so hard to spot — and name the keys that actually arrived.
    if (/^call\.recording\b/.test(type) && !rec.url) {
      this.logger.warn(`${type} carried no recognisable recording URL; payload keys: ${Object.keys(o).join(', ')}`);
    }

    // Normalize the live phase from the event type when the provider omits an
    // explicit status — drives the in-CRM widget's Ringing/Connected/Hold states.
    const statusFromType = isSubEvent
      ? ''
      : type.includes('ringing') ? 'ringing'
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
    const isFinal = !isSubEvent && (type.includes('completed') || type.includes('ended') || durationSecs != null);

    // Known call (e.g. one placed via the Quo queue) — enrich it in place. No
    // phone lookup needed; the call already knows its lead. This is the main
    // path for call.completed / recording / transcript / summary events.
    if (existing) {
      // Backfill the caller identity if the record doesn't have one yet (e.g. a call
      // first seen via webhook): for an outbound call `from` is the line it went out
      // on. Never overwrite an identity we already stamped at dial time.
      const fromNumber =
        existing.fromNumber == null && existing.direction === CommDirection.outbound ? str(o.from) : undefined;
      await this.prisma.call.update({
        where: { id: existing.id },
        data: {
          ...(status ? { status } : {}),
          ...(durationSecs != null ? { durationSecs } : {}),
          ...(fromNumber ? { fromNumber } : {}),
          recordingUrl: rec.url ?? undefined,
          transcript: transcript ?? undefined,
          aiSummary: aiSummary ?? undefined,
          // Never overwrite a real end time with the webhook's arrival time.
          ...(isFinal && !existing.endTime ? { endTime: new Date() } : {}),
        },
      });
      await this.linkRecording(existing.id, rec, durationSecs);
      await this.touchLead(existing.leadId);
      // Log the completion to the Activity Log exactly once — when the call first
      // reaches a final state (same guard as stamping endTime above).
      if (isFinal && !existing.endTime) {
        await this.logCallCompleted(existing.leadId, existing.callerId, existing.direction, status, durationSecs ?? existing.durationSecs);
      }
      return { ok: true, callId: existing.id };
    }

    // New / inbound call from the provider — needs a phone to resolve the lead.
    const direction = this.dir(o.direction, type);
    const from = str(o.from) ?? '';
    const to = Array.isArray(o.to) ? str(o.to[0]) ?? '' : str(o.to) ?? '';
    const external = direction === CommDirection.inbound ? from : to;
    if (!external) {
      // Never drop a call event silently. A verified `call.ringing` that lands here
      // creates no Call row, so the incoming-call popup has nothing to show and the
      // failure is invisible — which is exactly how this went unnoticed. Name the
      // keys that actually arrived so a payload-shape mismatch is obvious.
      this.logger.warn(
        `${type} dropped ('no phone'): direction=${direction} from=${from || '(empty)'} to=${to || '(empty)'}; payload keys: ${Object.keys(o).join(', ') || '(none)'}`,
      );
      return { ignored: 'no phone' };
    }

    const lead = await this.findOrCreateLeadByPhone(external);
    // Inbound calls belong to the agent whose Quo line was dialled (falling back
    // to whoever last worked the customer); outbound falls back to the assignee.
    // This is what makes the incoming-call popup reach one agent instead of the
    // whole floor.
    const callerId =
      direction === CommDirection.inbound
        ? await this.resolveInboundOwner(lead.id, lead.assignedToId, to)
        : ((await this.userByLine(from)) ?? (await this.resolveCallerId(lead.assignedToId)));
    const startTime = o.createdAt ? new Date(o.createdAt as string) : new Date();
    // For an outbound call the provider's `from` is the line it went out on — that's
    // the caller identity. Inbound `from` is the customer, so it isn't our identity.
    const fromNumber = direction === CommDirection.outbound ? str(o.from) : undefined;

    // The call the CRM already logged when the agent hit Call, if this event is
    // that same call coming back from Quo. Adopting it keeps ONE record — the
    // agent's outcome and notes on the same row as the provider's duration and
    // recording — instead of the duplicate pair this used to leave behind.
    const adopted = await this.adoptPendingOutboundCall(lead.id, direction, startTime, quoCallId);
    if (adopted) {
      await this.prisma.call.update({
        where: { id: adopted.id },
        data: {
          quoCallId,
          conversationId: str(o.conversationId) ?? undefined,
          ...(status ? { status } : {}),
          ...(durationSecs != null ? { durationSecs } : {}),
          ...(adopted.fromNumber == null && fromNumber ? { fromNumber } : {}),
          recordingUrl: rec.url ?? undefined,
          transcript: transcript ?? undefined,
          aiSummary: aiSummary ?? undefined,
          // Keep the agent's own wrap-up time if they already ended the call.
          ...(isFinal && !adopted.endTime
            ? { endTime: durationSecs != null ? new Date(startTime.getTime() + durationSecs * 1000) : new Date() }
            : {}),
        },
      });
      await this.linkRecording(adopted.id, rec, durationSecs);
      await this.touchLead(lead.id);
      if (isFinal && !adopted.endTime) {
        await this.logCallCompleted(lead.id, adopted.callerId, direction, status, durationSecs);
      }
      return { ok: true, callId: adopted.id, adopted: true as const };
    }

    let created: { id: string };
    try {
      created = await this.prisma.call.create({
        data: {
          leadId: lead.id, callerId, direction, status, durationSecs, fromNumber,
          recordingUrl: rec.url ?? undefined, transcript: transcript ?? undefined, aiSummary: aiSummary ?? undefined,
          quoCallId, conversationId: str(o.conversationId),
          startTime,
          // Derive the end from when the call actually started plus its duration,
          // rather than "now" — a late-arriving event must not stretch the call.
          endTime: durationSecs != null ? new Date(startTime.getTime() + durationSecs * 1000) : null,
        },
      });
    } catch (err) {
      // Two deliveries of the same event can both get past the lookup above and
      // race here; the unique quoCallId turns that into a constraint error instead
      // of a duplicate call. Whoever lost simply re-reads the winner's row — the
      // event is already recorded, which is the outcome that matters.
      if ((err as { code?: string }).code === 'P2002' && quoCallId) {
        const winner = await this.prisma.call.findFirst({ where: { quoCallId }, select: { id: true } });
        if (winner) return { ok: true, callId: winner.id, deduped: true as const };
      }
      throw err;
    }
    await this.linkRecording(created.id, rec, durationSecs);
    await this.touchLead(lead.id);

    // A provider event that already carries a final state (e.g. call.completed for
    // a call we never saw ring) → log the completion to the Activity Log.
    if (isFinal) {
      await this.logCallCompleted(lead.id, callerId, direction, status, durationSecs);
    }

    // Workflow: missed inbound call → follow-up task for the owner.
    const missed = ['missed', 'no-answer', 'no_answer'].includes(status) || (direction === CommDirection.inbound && durationSecs === 0);
    if (missed) {
      await this.prisma.task.create({
        data: { title: `Follow up: missed call from ${lead.businessName} (${external})`, ownerId: callerId, priority: 'high' },
      });
    }
    return { ok: true, callId: created.id, missed };
  }

  /**
   * Find the CRM-side row for a call Quo is now telling us about.
   *
   * An outbound call is created here the moment the agent clicks Call, before Quo
   * has any id for it — so the `call.*` events that follow carry a `quoCallId` we
   * have never seen and used to create a SECOND row for the same conversation.
   * That is what doubled call counts, split the recording away from the agent's
   * outcome, and made the Calls Made figures untrustworthy.
   *
   * Match conservatively: same lead, outbound, never linked to a provider call,
   * and started within a couple of hours of the provider's own start time. Most
   * recent first, so back-to-back attempts adopt the right one. Inbound is
   * excluded — those rows only ever originate from the provider, so there is
   * nothing to adopt and a wrong match would misroute the popup.
   */
  private async adoptPendingOutboundCall(
    leadId: string,
    direction: CommDirection,
    providerStart: Date,
    quoCallId: string | undefined,
  ) {
    if (direction !== CommDirection.outbound || !quoCallId) return null;
    const WINDOW_MS = 2 * 60 * 60 * 1000;
    return this.prisma.call.findFirst({
      where: {
        leadId,
        direction: CommDirection.outbound,
        quoCallId: null,
        startTime: {
          gte: new Date(providerStart.getTime() - WINDOW_MS),
          lte: new Date(providerStart.getTime() + WINDOW_MS),
        },
      },
      orderBy: { startTime: 'desc' },
      select: { id: true, callerId: true, endTime: true, fromNumber: true },
    });
  }

  /**
   * Record a "call completed" entry in the lead's Activity Log when a call first
   * reaches a final state — so the log reflects the finished call (direction,
   * duration, status) alongside the synced recording, summary and transcript.
   */
  private async logCallCompleted(
    leadId: string,
    userId: string,
    direction: CommDirection | null,
    status: string,
    durationSecs?: number | null,
  ) {
    const secs = Math.max(0, Math.round(durationSecs ?? 0));
    const dur = `${Math.floor(secs / 60)}m ${secs % 60}s`;
    const dirLabel = direction === CommDirection.inbound ? 'Inbound' : 'Outbound';
    await this.prisma.activity.create({
      data: {
        leadId,
        userId,
        action: 'call_completed',
        newValue: status || 'completed',
        remarks: `${dirLabel} call completed via Quo — ${dur} (${status || 'completed'}).`,
      },
    });
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

    // Resolve the "from" number: an explicit override wins (manual/admin sends);
    // otherwise the caller's own assigned line. No silent fallback to a shared
    // workspace number — the recipient must always see the sender's own identity,
    // the same rule outbound calls follow.
    let fromNumber = from;
    if (!fromNumber && callerId) {
      fromNumber = (await this.resolveCallerIdentity(callerId)).fromNumber;
    }
    if (!fromNumber) throw new BadRequestException('No OpenPhone number available to send from');

    // OpenPhone requires E.164 for both ends; leads/agent lines may be stored in display form.
    const result = await this.openphone.sendSms({ from: toE164(fromNumber), to: [toE164(lead.phone)], content: body });
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
        // Attribute the send to the CRM user, so history shows who sent it (and from
        // which line) — the SMS counterpart of a call's caller identity.
        senderId: callerId ?? undefined,
      },
    });
    await this.touchLead(lead.id);
    return { success: result.success, message, error: result.success ? null : result.error ?? null };
  }

  // ── Outbound: click-to-call ──
  /**
   * Start an outbound call. Quo exposes no API to place a call, so outbound is an
   * app-handoff: the CRM logs the call and the client launches the Quo app with
   * the number via Quo's documented deep link, staying the live monitor. The
   * resulting call.* webhook enriches THIS Call record with status, duration,
   * recording, transcript and AI summary (see adoptPendingOutboundCall) rather
   * than creating a second one.
   */
  async startCall(leadId: string, callerId: string) {
    await this.assertCallingEnabled();
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, deletedAt: null } });
    if (!lead) throw new NotFoundException('Lead not found');

    // Validate the caller before dialing: they must have their own assigned OpenPhone
    // line. This both blocks the shared-line fallback (no cross-employee caller ID)
    // and gives us the identity to stamp on the call and surface to the agent.
    const { name, fromNumber } = await this.resolveCallerIdentity(callerId);
    const call = await this.prisma.call.create({
      data: {
        leadId: lead.id,
        callerId,
        direction: CommDirection.outbound,
        status: 'initiated',
        startTime: new Date(),
        fromNumber,
      },
    });
    await this.prisma.activity.create({
      data: {
        leadId: lead.id,
        userId: callerId,
        action: 'call_started',
        newValue: 'initiated',
        remarks: `Outbound call to ${lead.phone} as ${name} (${fromNumber}) via the Quo app`,
      },
    });
    await this.touchLead(lead.id);
    // `from`/`callerName` let the client confirm the identity the customer will see,
    // so the agent dials from the right line (Quo has no dial API to force it).
    return {
      callId: call.id,
      dialUrl: quoDialUrl(lead.phone, fromNumber),
      phone: lead.phone,
      from: fromNumber,
      callerName: name,
    };
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
        // Caller identity the customer saw — kept on the call itself, so history is
        // consistent even if the caller's assigned number later changes.
        from: c.fromNumber,
      })),
      ...messages.map((m) => ({ kind: 'message' as const, id: m.id, at: m.createdAt, direction: m.direction, body: m.body, status: m.status })),
      ...notes.map((n) => ({ kind: 'note' as const, id: n.id, at: n.createdAt, body: n.noteText, by: n.createdBy?.name ?? null })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    return items;
  }

  // ── Outbound: dial-pad call to an arbitrary number ──
  /** Place a call to a typed number: resolve (or create) the lead, then dial. */
  async startCallByPhone(phone: string, callerId: string) {
    await this.assertCallingEnabled();
    const trimmed = phone?.trim();
    if (!trimmed || digits(trimmed).length < 3) throw new BadRequestException('A valid phone number is required');
    // Validate the caller's identity before resolving the lead, so a rejected call
    // (no assigned caller ID) never leaves a stray "Unknown caller" lead behind.
    await this.resolveCallerIdentity(callerId);
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
      // The line this call is going out on — the caller identity the customer sees.
      from: call.fromNumber,
    };
  }

  /**
   * Record how the agent answered the incoming-call popup.
   *
   * IMPORTANT — what "decline" can and cannot do: OpenPhone/Quo exposes no
   * call-control API (its only write operations are sending a message and
   * creating a contact), so the CRM cannot reject a ringing call on the carrier.
   * Declining here records the agent's decision and closes the popup; the call
   * itself keeps ringing in OpenPhone until it is rejected there or times out
   * into voicemail, at which point the provider's own `call.*` webhook writes the
   * real final status. That provider status deliberately wins on the record — the
   * activity trail is what preserves "the agent saw this and declined it", which
   * is the part that distinguishes a declined call from one nobody noticed.
   */
  async respondToCall(callId: string, userId: string, role: string, action: 'attend' | 'decline') {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Call not found');
    if (role !== 'admin' && role !== 'team_leader' && call.callerId !== userId) {
      throw new ForbiddenException('Not your call');
    }

    await this.prisma.activity.create({
      data: {
        leadId: call.leadId,
        userId,
        action: action === 'attend' ? 'call_attended' : 'call_declined',
        newValue: action,
        remarks:
          action === 'attend'
            ? 'Opened OpenPhone from the CRM incoming-call popup to answer.'
            : 'Declined from the CRM incoming-call popup. OpenPhone has no reject API, so the call was not hung up on the carrier — it rings out unless also declined in OpenPhone.',
      },
    });

    // Mark a still-ringing call as declined so the log separates "declined" from
    // "nobody was looking". A later provider webhook may overwrite this with the
    // carrier's own outcome, which is the more authoritative answer.
    if (action === 'decline' && !call.endTime) {
      await this.prisma.call.update({ where: { id: call.id }, data: { status: 'declined' } });
    }
    return { ok: true, action, rejectedOnCarrier: false as const };
  }

  // ── Incoming-call popup: the ringing call THIS user is meant to answer ──
  // Strictly one recipient. handleCall stamps an inbound call's `callerId` via
  // resolveInboundOwner — the agent whose Quo line was dialled, falling back to
  // whoever last worked the customer — and the popup is scoped to that person for
  // every role, managers included. A team leader used to get a popup for every
  // call in the workspace, which is both noise and a privacy leak: an admin has no
  // business being interrupted by a call ringing on someone else's extension. The
  // manager-wide view of inbound activity lives in Calls Made / Missed Calls,
  // which are lists, not interruptions.
  async latestIncoming(userId: string) {
    const now = Date.now();
    // Three ways an inbound call earns a popup, deliberately narrow so the 10-minute
    // REST backfill (which imports already-finished calls minutes-to-hours late)
    // can never surface one:
    //   1. Just arrived — startTime within the last 90s. A real-time `call.ringing`
    //      whose payload timestamp is fresh lands here.
    //   2. Still live by call time — a ringing/connected call that hasn't ended yet,
    //      kept visible past 90s (ring + talk-time can run longer) but capped to 5 min
    //      and gated on endTime = null.
    //   3. Just LEARNED and still live — the row was created (its first event seen) in
    //      the last 3 min, is a live status, and hasn't ended. This is the one that
    //      matters in practice: Quo delivers `call.ringing` with the call's ORIGINAL
    //      createdAt, which can be minutes stale (delivery lag / retries), so keying
    //      the popup off the payload's startTime alone misses live rings. `createdAt`
    //      is the CRM's own server receipt time — for a live call the ringing webhook
    //      is the first event, so it ≈ "the phone is ringing now", regardless of how
    //      stale the provider's timestamp is. Backfilled rows are terminal (endTime
    //      set / non-live status), so this branch still can't surface them.
    const freshSince = new Date(now - 90_000);
    const liveSince = new Date(now - 5 * 60_000);
    const learnedSince = new Date(now - 3 * 60_000);
    const LIVE_STATUSES = ['ringing', 'in-progress', 'in_progress', 'answered', 'connected', 'ongoing', 'active'];
    const where: Prisma.CallWhereInput = {
      direction: CommDirection.inbound,
      OR: [
        { startTime: { gte: freshSince } },
        { status: { in: LIVE_STATUSES }, endTime: null, startTime: { gte: liveSince } },
        { status: { in: LIVE_STATUSES }, endTime: null, createdAt: { gte: learnedSince } },
      ],
    };
    // Every role, not just employees: the popup belongs to the extension that rang.
    where.callerId = userId;
    const call = await this.prisma.call.findFirst({
      where,
      include: {
        lead: { select: { id: true, businessName: true, contactName: true, phone: true, city: true, state: true, status: true, callStatus: true, callbackAt: true, callbackCompletedAt: true } },
        caller: { select: { id: true, name: true } },
      },
      // Most recently LEARNED wins, not most recent call time — a live ring that Quo
      // delivered with a stale timestamp must outrank an older freshly-missed call.
      orderBy: { createdAt: 'desc' },
    });
    if (!call) return null;
    // "Connected" = Quo reports the call as live/answered (drives the popup's
    // auto-open). Conservative allowlist so ringing/initiated don't trigger it.
    const connected = ['in-progress', 'in_progress', 'answered', 'connected', 'ongoing', 'active'].includes((call.status ?? '').toLowerCase());
    // Recognition context: the last logged outcome (resolved to its display name)
    // and whether this customer had a callback pending — so the handler answers
    // knowing who's calling back and why.
    let lastOutcome: string | null = null;
    if (call.lead.callStatus) {
      const oc = await this.prisma.outcome.findUnique({ where: { slug: call.lead.callStatus }, select: { name: true } });
      lastOutcome = oc?.name ?? call.lead.callStatus;
    }
    const pendingCallback = !!call.lead.callbackAt && !call.lead.callbackCompletedAt;
    return {
      callId: call.id,
      at: call.startTime,
      status: call.status,
      connected,
      // Who handled this customer before — their own name for the handler, or the
      // owner's name when a manager sees the callback.
      handledBy: call.caller?.name ?? null,
      handledById: call.callerId,
      lastOutcome,
      pendingCallback,
      lead: {
        id: call.lead.id,
        businessName: call.lead.businessName,
        // Contact person at the company — the "customer name" shown on the popup.
        contactName: call.lead.contactName,
        phone: call.lead.phone,
        city: call.lead.city,
        state: call.lead.state,
        status: call.lead.status,
      },
    };
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
