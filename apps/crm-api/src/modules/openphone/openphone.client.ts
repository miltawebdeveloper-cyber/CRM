import { Injectable, Logger } from '@nestjs/common';
import {
  OpenPhoneNumber, OpenPhoneMessagePayload, OpenPhoneResult, OpenPhoneContactPayload, OpenPhoneContact,
  OpenPhoneHistoryQuery, OpenPhonePage, OpenPhoneCall, OpenPhoneMessage, OpenPhoneRecording, OpenPhoneConversation,
  OpenPhoneTranscript,
} from './openphone.types.js';

/**
 * Stable fake provider id. The index goes AFTER the hex slice: hex-encoding the
 * participant and then truncating would cut the index off the end, collapsing
 * every call/message of a lead onto one id.
 */
const fakeId = (prefix: string, participant: string, i: number) =>
  `${prefix}${Buffer.from(participant).toString('hex').slice(0, 18)}${i}`;

/** Deterministic pseudo-random in [0,1) from a string — keeps sandbox data
 *  stable across calls so a synced sandbox lead doesn't churn on every sync. */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/**
 * Low-level HTTP client for OpenPhone (https://www.openphone.com/docs/).
 * Auth: the API key is sent in the `Authorization` header (no Bearer prefix).
 *
 * Sandbox mode: when OPENPHONE_API_KEY is not set (or OPENPHONE_SANDBOX=true)
 * it simulates OpenPhone so the integration is demonstrable without real
 * credentials. Set the env var later to switch to the live API — no code change.
 */
@Injectable()
export class OpenPhoneClient {
  private readonly logger = new Logger(OpenPhoneClient.name);

  private get baseUrl() {
    return (process.env.OPENPHONE_BASE_URL || 'https://api.openphone.com/v1').replace(/\/$/, '');
  }
  private get apiKey() {
    return process.env.OPENPHONE_API_KEY ?? '';
  }
  private get timeoutMs() {
    return Number(process.env.OPENPHONE_TIMEOUT_MS ?? 10_000);
  }

  get isSandbox(): boolean {
    return process.env.OPENPHONE_SANDBOX === 'true' || !this.apiKey;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<OpenPhoneResult<T>> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.apiKey, // OpenPhone uses the raw key (no "Bearer ")
          ...(init?.headers ?? {}),
        },
        signal: controller.signal,
      });
      const raw = await res.json().catch(() => undefined);
      const durationMs = Date.now() - startedAt;
      if (!res.ok) {
        return {
          success: false,
          statusCode: res.status,
          error: (raw as { message?: string })?.message ?? `OpenPhone returned HTTP ${res.status}`,
          durationMs,
        };
      }
      return { success: true, statusCode: res.status, data: raw as T, durationMs };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const e = err as { name?: string; message?: string };
      const aborted = e?.name === 'AbortError';
      this.logger.warn(`OpenPhone call failed: ${e?.message}`);
      return {
        success: false,
        error: aborted ? `OpenPhone request timed out after ${this.timeoutMs}ms` : e?.message ?? 'Network error',
        durationMs,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** List workspace phone numbers — also used to verify the connection. */
  async listPhoneNumbers(): Promise<OpenPhoneResult<OpenPhoneNumber[]>> {
    if (this.isSandbox) {
      await new Promise((r) => setTimeout(r, 120));
      return {
        success: true,
        statusCode: 200,
        data: [
          { id: 'op_sandbox_1', number: '+13055550100', name: 'Sandbox Main Line' },
          { id: 'op_sandbox_2', number: '+14155550199', name: 'Sandbox Sales Line' },
        ],
        durationMs: 120,
      };
    }
    // OpenPhone returns { data: [{ id, phoneNumber/ number, name }] }
    const res = await this.request<{ data?: Array<{ id: string; number?: string; phoneNumber?: string; name?: string }> }>(
      '/phone-numbers',
      { method: 'GET' },
    );
    if (!res.success) return res as OpenPhoneResult<OpenPhoneNumber[]>;
    const data = (res.data?.data ?? []).map((n) => ({ id: n.id, number: n.number ?? n.phoneNumber ?? '', name: n.name }));
    return { ...res, data };
  }

  /** Send an SMS via OpenPhone. */
  async sendMessage(payload: OpenPhoneMessagePayload): Promise<OpenPhoneResult> {
    if (this.isSandbox) {
      await new Promise((r) => setTimeout(r, 120));
      return { success: true, statusCode: 202, data: { id: `op_msg_${Math.random().toString(36).slice(2, 10)}`, status: 'queued' }, durationMs: 120 };
    }
    return this.request('/messages', { method: 'POST', body: JSON.stringify(payload) });
  }

  /**
   * One page of workspace conversations. This is the only history endpoint that
   * does NOT require a participant, so it's used to discover which conversations
   * exist before pulling each one's calls and messages.
   */
  async listConversations(opts: { maxResults?: number; pageToken?: string } = {}): Promise<OpenPhoneResult<OpenPhonePage<OpenPhoneConversation>>> {
    if (this.isSandbox) return this.sandboxConversations(opts);
    const p = new URLSearchParams({ maxResults: String(opts.maxResults ?? 50) });
    if (opts.pageToken) p.set('pageToken', opts.pageToken);
    const res = await this.request<{ data?: OpenPhoneConversation[]; nextPageToken?: string | null }>(
      `/conversations?${p.toString()}`,
      { method: 'GET' },
    );
    if (!res.success) return res as OpenPhoneResult<OpenPhonePage<OpenPhoneConversation>>;
    return { ...res, data: { data: res.data?.data ?? [], nextPageToken: res.data?.nextPageToken ?? null } };
  }

  /** Sandbox conversations: one per simulated customer number. */
  private sandboxConversations(opts: { pageToken?: string }): OpenPhoneResult<OpenPhonePage<OpenPhoneConversation>> {
    if (opts.pageToken) return { success: true, statusCode: 200, data: { data: [], nextPageToken: null }, durationMs: 10 };
    const data: OpenPhoneConversation[] = [];
    return { success: true, statusCode: 200, data: { data, nextPageToken: null }, durationMs: 20 };
  }

  private historyQuery(q: OpenPhoneHistoryQuery): string {
    const p = new URLSearchParams({
      phoneNumberId: q.phoneNumberId,
      // OpenPhone expects the array form: participants[]=+1555…
      'participants[]': q.participant,
      maxResults: String(q.maxResults ?? 100),
    });
    if (q.pageToken) p.set('pageToken', q.pageToken);
    if (q.createdAfter) p.set('createdAfter', q.createdAfter);
    return p.toString();
  }

  /**
   * One page of call history for a 1:1 conversation.
   * Both phoneNumberId and a participant are mandatory — the API has no
   * workspace-wide call feed, so history is always pulled per customer number.
   */
  async listCalls(q: OpenPhoneHistoryQuery): Promise<OpenPhoneResult<OpenPhonePage<OpenPhoneCall>>> {
    if (this.isSandbox) return this.sandboxCalls(q);
    const res = await this.request<{ data?: OpenPhoneCall[]; nextPageToken?: string | null }>(
      `/calls?${this.historyQuery(q)}`,
      { method: 'GET' },
    );
    if (!res.success) return res as OpenPhoneResult<OpenPhonePage<OpenPhoneCall>>;
    return { ...res, data: { data: res.data?.data ?? [], nextPageToken: res.data?.nextPageToken ?? null } };
  }

  /** One page of SMS history for a 1:1 conversation. Same constraints as listCalls. */
  async listMessages(q: OpenPhoneHistoryQuery): Promise<OpenPhoneResult<OpenPhonePage<OpenPhoneMessage>>> {
    if (this.isSandbox) return this.sandboxMessages(q);
    const res = await this.request<{ data?: OpenPhoneMessage[]; nextPageToken?: string | null }>(
      `/messages?${this.historyQuery(q)}`,
      { method: 'GET' },
    );
    if (!res.success) return res as OpenPhoneResult<OpenPhonePage<OpenPhoneMessage>>;
    return { ...res, data: { data: res.data?.data ?? [], nextPageToken: res.data?.nextPageToken ?? null } };
  }

  /** Recording segments for a call — chronological, oldest segment first. */
  async getCallRecordings(callId: string): Promise<OpenPhoneResult<OpenPhoneRecording[]>> {
    if (this.isSandbox) return this.sandboxRecordings(callId);
    const res = await this.request<{ data?: OpenPhoneRecording[] }>(`/call-recordings/${encodeURIComponent(callId)}`, {
      method: 'GET',
    });
    if (!res.success) return res as OpenPhoneResult<OpenPhoneRecording[]>;
    return { ...res, data: res.data?.data ?? [] };
  }

  /**
   * The AI transcript for a call — chronological dialogue turns.
   * `userId` on a turn marks the workspace user (the employee); the customer's
   * turns carry only their `identifier` (phone number).
   */
  async getCallTranscript(callId: string): Promise<OpenPhoneResult<OpenPhoneTranscript>> {
    if (this.isSandbox) return this.sandboxTranscript(callId);
    const res = await this.request<{ data?: OpenPhoneTranscript }>(`/call-transcripts/${encodeURIComponent(callId)}`, {
      method: 'GET',
    });
    if (!res.success) return res as OpenPhoneResult<OpenPhoneTranscript>;
    const t = res.data?.data;
    return { ...res, data: { dialogue: t?.dialogue ?? [], status: t?.status ?? null, duration: t?.duration ?? null, language: t?.language ?? null, callId } };
  }

  // ── Sandbox history ──
  // Deterministic per participant, so repeated syncs converge on the same rows
  // instead of inventing new calls each time.

  private sandboxCalls(q: OpenPhoneHistoryQuery): OpenPhoneResult<OpenPhonePage<OpenPhoneCall>> {
    if (q.pageToken) return { success: true, statusCode: 200, data: { data: [], nextPageToken: null }, durationMs: 10 };
    const rnd = seeded(`calls:${q.participant}`);
    const self = q.selfNumber ?? q.phoneNumberId;
    const count = 1 + Math.floor(rnd() * 4);
    const data: OpenPhoneCall[] = Array.from({ length: count }, (_, i) => {
      const answered = rnd() > 0.25;
      const incoming = rnd() > 0.45;
      const at = new Date(Date.now() - (i + 1) * (3 + Math.floor(rnd() * 40)) * 3600_000);
      return {
        id: fakeId('AC', q.participant, i),
        direction: incoming ? 'incoming' : 'outgoing',
        status: answered ? 'completed' : 'no-answer',
        duration: answered ? 45 + Math.floor(rnd() * 400) : 0,
        from: incoming ? q.participant : self,
        to: incoming ? self : q.participant,
        conversationId: `CN${Buffer.from(q.participant).toString('hex').slice(0, 16)}`,
        createdAt: at.toISOString(),
      };
    });
    return { success: true, statusCode: 200, data: { data, nextPageToken: null }, durationMs: 40 };
  }

  private sandboxMessages(q: OpenPhoneHistoryQuery): OpenPhoneResult<OpenPhonePage<OpenPhoneMessage>> {
    if (q.pageToken) return { success: true, statusCode: 200, data: { data: [], nextPageToken: null }, durationMs: 10 };
    const rnd = seeded(`msgs:${q.participant}`);
    const self = q.selfNumber ?? q.phoneNumberId;
    const thread = [
      'Hi, this is Milta Financial Services — is now a good time to talk about your bookkeeping?',
      'Sorry, I missed your call. Can you try me tomorrow morning?',
      'Sure — I have you down for 9:30am tomorrow. Talk then!',
      'Could you send over the pricing sheet before we speak?',
      'Just sent the pricing over to your email. Let me know if it looks right.',
    ];
    const count = 1 + Math.floor(rnd() * thread.length);
    const statuses = ['delivered', 'sent', 'delivered', 'undelivered'];
    const data: OpenPhoneMessage[] = Array.from({ length: count }, (_, i) => {
      const incoming = i % 2 === 1;
      return {
        id: fakeId('MSG', q.participant, i),
        direction: incoming ? 'incoming' : 'outgoing',
        status: incoming ? 'received' : statuses[Math.floor(rnd() * statuses.length)],
        text: thread[i],
        from: incoming ? q.participant : self,
        to: incoming ? self : q.participant,
        conversationId: `CN${Buffer.from(q.participant).toString('hex').slice(0, 16)}`,
        createdAt: new Date(Date.now() - (count - i) * 3600_000).toISOString(),
      };
    });
    return { success: true, statusCode: 200, data: { data, nextPageToken: null }, durationMs: 40 };
  }

  private sandboxRecordings(callId: string): OpenPhoneResult<OpenPhoneRecording[]> {
    const rnd = seeded(`rec:${callId}`);
    // Not every call is recorded — mirrors "display the recording only if available".
    if (rnd() < 0.25) return { success: true, statusCode: 200, data: [], durationMs: 20 };
    const duration = 30 + Math.floor(rnd() * 300);
    return {
      success: true,
      statusCode: 200,
      // sandbox:// is resolved by the audio proxy into a generated tone, so the
      // player is demonstrable without real Quo credentials.
      data: [{
        id: `REC${callId.slice(2, 14)}`,
        url: `sandbox://recording/${callId}?d=${Math.min(duration, 20)}`,
        duration, startTime: new Date(Date.now() - 86_400_000).toISOString(),
        status: 'completed', type: 'audio/wav',
      }],
      durationMs: 20,
    };
  }

  /**
   * A deterministic stand-in transcript so AI Summary + Transcript are
   * demonstrable without a live Quo transcript. Seeded by callId, so the same
   * call always produces the same conversation. Employee turns carry a `userId`;
   * the customer's turns carry only an `identifier`, mirroring the real payload.
   */
  private sandboxTranscript(callId: string): OpenPhoneResult<OpenPhoneTranscript> {
    const rnd = seeded(`transcript:${callId}`);
    // A realistic Milta Financial Services bookkeeping discovery call. Turns
    // alternate employee/customer; a seeded length keeps calls varied but stable.
    const script: Array<{ who: 'employee' | 'customer'; text: string }> = [
      { who: 'employee', text: 'Hi, thanks for taking my call — this is Priya from Milta Financial Services. Is now still a good time to talk about your bookkeeping?' },
      { who: 'customer', text: 'Yeah, I have a few minutes. We are a small landscaping business and our books are honestly a bit of a mess right now.' },
      { who: 'employee', text: 'Totally understand, that is very common this time of year. Can I ask — are you doing the bookkeeping yourself at the moment, or do you have someone?' },
      { who: 'customer', text: 'I do it myself in spreadsheets. We are about fifteen employees now and it is getting away from me, especially payroll and sales tax.' },
      { who: 'employee', text: 'Got it. So the big pain points are payroll and sales tax filing. Are you on QuickBooks at all, or purely spreadsheets today?' },
      { who: 'customer', text: 'Purely spreadsheets. I looked at QuickBooks but never set it up properly. I also need last year cleaned up before taxes are due.' },
      { who: 'employee', text: 'Okay, so two things: a cleanup of last year, and then ongoing monthly bookkeeping with payroll and sales tax handled. We do both. What is your rough monthly transaction volume?' },
      { who: 'customer', text: 'Maybe two hundred transactions a month, plus the payroll runs every two weeks. What would something like that cost?' },
      { who: 'employee', text: 'For that volume, ongoing monthly runs around four hundred a month, and the one-time cleanup depends on the state of the records — I would scope that after a quick review. Would it help if I emailed you a written quote and a short onboarding checklist?' },
      { who: 'customer', text: 'Yes, please send the pricing to my email. I would want to start after tax season though, not right now.' },
      { who: 'employee', text: 'That is completely fine. I will send the quote today and pencil you in for a follow-up in early May to get you onboarded. Does a call the first week of May work?' },
      { who: 'customer', text: 'First week of May works. Send the details over and I will review with my partner.' },
      { who: 'employee', text: 'Perfect. I will email the quote and checklist this afternoon and follow up the first week of May. Thanks so much for your time!' },
    ];
    // 8–13 turns, seeded — always ends on an employee wrap-up for a natural close.
    let len = 8 + Math.floor(rnd() * (script.length - 8 + 1));
    if (len % 2 === 0) len = Math.min(script.length, len + 1); // odd -> ends employee
    const turns = script.slice(0, len);

    let t = 2; // first word ~2s in
    const dialogue = turns.map((turn) => {
      const words = turn.text.split(' ').length;
      const dur = Math.max(3, Math.round(words / 2.5)); // ~150 wpm
      const start = t;
      t += dur + 1; // a beat between speakers
      return {
        identifier: turn.who === 'employee' ? '+13055550100' : '+15615550142',
        userId: turn.who === 'employee' ? 'op_user_sandbox' : null,
        content: turn.text,
        start,
        end: start + dur,
      };
    });

    return {
      success: true,
      statusCode: 200,
      data: { callId, status: 'completed', duration: t, dialogue, language: 'en' },
      durationMs: 25,
    };
  }

  /** Create (upsert) a contact in the OpenPhone workspace — used for lead sync. */
  async createContact(payload: OpenPhoneContactPayload): Promise<OpenPhoneResult<OpenPhoneContact>> {
    if (this.isSandbox) {
      await new Promise((r) => setTimeout(r, 150));
      // Deterministic error hook for testing: a phone ending "0000" is rejected.
      const phone = payload.defaultFields.phoneNumbers?.[0]?.value ?? '';
      if (phone.endsWith('0000')) {
        return { success: false, statusCode: 422, error: 'OpenPhone (sandbox) rejected the contact: invalid phone number', durationMs: 150 };
      }
      return {
        success: true,
        statusCode: 201,
        data: { id: `op_ct_${Math.random().toString(36).slice(2, 12)}`, externalId: payload.externalId ?? null },
        durationMs: 150,
      };
    }
    // OpenPhone returns { data: { id, externalId, defaultFields, ... } }
    const res = await this.request<{ data?: OpenPhoneContact }>('/contacts', { method: 'POST', body: JSON.stringify(payload) });
    if (!res.success) return res as OpenPhoneResult<OpenPhoneContact>;
    return { ...res, data: res.data?.data };
  }
}
