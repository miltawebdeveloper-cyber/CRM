import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { CommDirection, Prisma, Role } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { OpenPhoneService } from '../openphone/openphone.service';
import { LlmService } from '../llm/llm.service';
import { GroqService } from '../llm/groq.service';
import { CallHistoryService } from './call-history.service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const digits = (v: string) => v.replace(/\D/g, '');
const last10 = (v?: string | null) => (v ? digits(v).slice(-10) : '');

/**
 * What to call the other party on a call.
 *
 * A call from an unknown number has no lead, so there is no name to use: the
 * number itself is the identity, and the transcript labels and summary say so
 * rather than calling every unknown caller "Customer" and losing which one it was.
 */
const customerLabel = (call: {
  lead: { businessName: string; contactName: string | null } | null;
  externalNumber: string | null;
}) => call.lead?.contactName || call.lead?.businessName || call.externalNumber || 'Customer';

/** One speaker turn in the rendered transcript. */
export interface TranscriptTurn {
  speaker: 'employee' | 'customer';
  speakerName: string;
  text: string;
  startSecs: number | null;
  endSecs: number | null;
}

/** The nine structured sections of an AI call summary. */
export interface CallSummary {
  purpose: string;
  keyPoints: string[];
  customerRequirements: string[];
  questionsAsked: string[];
  employeeResponses: string[];
  decisions: string[];
  followUps: string[];
  outcome: string;
  nextSteps: string[];
}

/** JSON schema the LLM's structured output is constrained to (all fields required). */
const SUMMARY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'purpose', 'keyPoints', 'customerRequirements', 'questionsAsked',
    'employeeResponses', 'decisions', 'followUps', 'outcome', 'nextSteps',
  ],
  properties: {
    purpose: { type: 'string', description: 'The reason the call took place, in one sentence.' },
    keyPoints: { type: 'array', items: { type: 'string' }, description: 'Main discussion points.' },
    customerRequirements: { type: 'array', items: { type: 'string' }, description: 'What the customer needs or is asking for.' },
    questionsAsked: { type: 'array', items: { type: 'string' }, description: 'Questions the customer raised.' },
    employeeResponses: { type: 'array', items: { type: 'string' }, description: 'How the employee answered or addressed them.' },
    decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions or agreements made on the call.' },
    followUps: { type: 'array', items: { type: 'string' }, description: 'Follow-up actions committed to.' },
    outcome: { type: 'string', description: 'The overall outcome of the call, in one sentence.' },
    nextSteps: { type: 'array', items: { type: 'string' }, description: 'Suggested next steps to move the deal forward.' },
  },
};

/**
 * Turns a recorded call into an AI Summary + speaker-labelled Transcript, stored
 * on the CallInsight row (1:1 with Call), leaving the original recording untouched.
 *
 * Generation is automatic: QuoSyncService and the call.* webhook enqueue a call
 * once its recording lands, and this service drains the queue in the background so
 * it never blocks the sync request. Without an ANTHROPIC_API_KEY it degrades to a
 * deterministic heuristic summary (and the sandbox transcript), so the whole
 * experience is demonstrable without an LLM — the same philosophy as the sandbox
 * OpenPhone client.
 */
@Injectable()
export class CallInsightsService {
  private readonly logger = new Logger(CallInsightsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openphone: OpenPhoneService,
    private readonly llm: LlmService,
    private readonly groq: GroqService,
    private readonly callHistory: CallHistoryService,
  ) {}

  private isManager(role: Role) {
    return role === Role.admin || role === Role.team_leader;
  }

  // ── Background queue ──
  // Single-flight drain, same shape as QuoSyncService.startBackfill: a Set dedupes
  // re-enqueues of the same call, and a small gap between generations keeps LLM
  // usage gentle. Enqueue never blocks the caller.
  private queue = new Set<string>();
  private running = false;
  private lastRun: { processed: number; failed: number; finishedAt: Date } | null = null;
  private minGapMs = Number(process.env.INSIGHTS_MIN_GAP_MS ?? 400);

  get backfillStatus() {
    return { running: this.running, queued: this.queue.size, lastRun: this.lastRun };
  }

  /** Queue a call for insight generation. Safe to call repeatedly. */
  enqueue(callId: string) {
    this.queue.add(callId);
    this.drain();
  }

  private drain() {
    if (this.running) return;
    this.running = true;
    void (async () => {
      let processed = 0;
      let failed = 0;
      while (this.queue.size) {
        const id = this.queue.values().next().value as string;
        this.queue.delete(id);
        try {
          await this.generateForCall(id);
          processed++;
        } catch (err) {
          failed++;
          this.logger.warn(`Insight generation failed for ${id}: ${(err as Error).message}`);
        }
        if (this.queue.size) await sleep(this.minGapMs);
      }
      this.running = false;
      this.lastRun = { processed, failed, finishedAt: new Date() };
    })();
  }

  /** Enqueue every recorded call that doesn't yet have a ready insight. */
  async backfillAll(): Promise<{ queued: number }> {
    const calls = await this.prisma.call.findMany({
      where: {
        recordings: { some: {} },
        OR: [{ insight: null }, { insight: { status: { not: 'ready' } } }],
      },
      select: { id: true },
      orderBy: { startTime: 'desc' },
      take: Number(process.env.INSIGHTS_BACKFILL_LIMIT ?? 1000),
    });
    for (const c of calls) this.enqueue(c.id);
    this.logger.log(`Insight backfill: queued ${calls.length} call(s)`);
    return { queued: calls.length };
  }

  // ── Generation ──

  /**
   * Build (or rebuild) the insight for one call. Idempotent — safe to re-run to
   * regenerate. Only recorded calls get an insight; a call with no transcript is
   * marked `unavailable` rather than failed.
   */
  async generateForCall(callId: string): Promise<void> {
    const call = await this.prisma.call.findUnique({
      where: { id: callId },
      include: {
        lead: { select: { businessName: true, contactName: true, phone: true } },
        caller: { select: { name: true } },
        recordings: { select: { id: true } },
        insight: { select: { id: true } },
      },
    });
    if (!call) return;
    if (call.recordings.length === 0) return; // insight is for recorded calls only

    await this.upsertInsight(callId, { status: 'processing', error: null });

    const transcript = await this.resolveTranscript(call);
    if (!transcript || transcript.turns.length === 0) {
      await this.upsertInsight(callId, { status: 'unavailable', error: 'No transcript available for this call' });
      return;
    }

    const { summary, model, error } = await this.buildSummary(call, transcript.turns);
    const summaryText = this.flattenSummary(summary);
    const transcriptText = transcript.turns.map((t) => `${this.label(t)}: ${t.text}`).join('\n');

    await this.upsertInsight(callId, {
      status: 'ready',
      summary: summary as unknown as Prisma.InputJsonValue,
      transcript: transcript.turns as unknown as Prisma.InputJsonValue,
      summaryText,
      transcriptText,
      model,
      source: transcript.source,
      error,
      generatedAt: new Date(),
    });

    // Mirror the flattened text onto the Call so the lead timeline (which reads
    // Call.transcript / Call.aiSummary) shows the same insight for free.
    await this.prisma.call.update({
      where: { id: callId },
      data: { transcript: transcriptText, aiSummary: summaryText },
    });
  }

  private async upsertInsight(callId: string, data: Omit<Prisma.CallInsightUncheckedCreateInput, 'callId'>) {
    await this.prisma.callInsight.upsert({
      where: { callId },
      create: { callId, ...data },
      update: data as Prisma.CallInsightUncheckedUpdateInput,
    });
  }

  private label(t: TranscriptTurn) {
    return t.speaker === 'employee' ? `Employee (${t.speakerName})` : `Customer (${t.speakerName})`;
  }

  /**
   * Get the transcript for a call as employee/customer turns. Prefers the
   * provider's own transcript (OpenPhone/Quo); when that's absent, falls back to
   * transcribing the recording audio ourselves with Groq Whisper — so a summary
   * is possible even without the provider's paid transcription.
   */
  private async resolveTranscript(call: {
    id: string;
    quoCallId: string | null;
    direction: CommDirection | null;
    fromNumber: string | null;
    externalNumber: string | null;
    caller: { name: string } | null;
    lead: { businessName: string; contactName: string | null; phone: string } | null;
    recordings: { id: string }[];
  }): Promise<{ turns: TranscriptTurn[]; source: string } | null> {
    const employeeName = call.caller?.name || 'Employee';
    const customerName = customerLabel(call);

    // 1) Provider transcript. Sandbox synthesises one for any id; live mode needs
    //    the provider's own call id to look one up.
    if (this.openphone.isSandbox || call.quoCallId) {
      const res = await this.openphone.getCallTranscript(call.quoCallId ?? call.id);
      if (res.success && res.data?.dialogue?.length) {
        const customer10 = last10(call.lead?.phone ?? call.externalNumber);
        const employee10 = last10(call.fromNumber);
        const turns: TranscriptTurn[] = res.data.dialogue
          .filter((d) => (d.content ?? '').trim())
          .map((d) => {
            // A workspace userId marks the employee; otherwise match the speaker's
            // number to the customer's line, defaulting the workspace side to employee.
            let speaker: 'employee' | 'customer';
            if (d.userId) speaker = 'employee';
            else {
              const id10 = last10(d.identifier);
              if (id10 && id10 === customer10) speaker = 'customer';
              else if (id10 && id10 === employee10) speaker = 'employee';
              else speaker = 'customer';
            }
            return {
              speaker,
              speakerName: speaker === 'employee' ? employeeName : customerName,
              text: (d.content ?? '').trim(),
              startSecs: typeof d.start === 'number' ? d.start : null,
              endSecs: typeof d.end === 'number' ? d.end : null,
            };
          });
        if (turns.length) return { turns, source: this.openphone.isSandbox ? 'sandbox' : 'quo' };
      }
    }

    // 2) Fallback: transcribe the recording audio with Groq Whisper.
    if (this.groq.isConfigured && call.recordings.length) {
      const turns = await this.transcribeWithGroq(call, employeeName, customerName);
      if (turns?.length) return { turns, source: 'groq' };
    }

    return null;
  }

  /**
   * Transcribe a call's recording segments with Groq Whisper and split them into
   * employee/customer turns. Whisper gives timestamped segments but no speaker, so
   * a small Groq Llama pass labels each segment; if that's unavailable we fall back
   * to flipping speaker on natural pauses.
   */
  private async transcribeWithGroq(
    call: { direction: CommDirection | null; recordings: { id: string }[] },
    employeeName: string,
    customerName: string,
  ): Promise<TranscriptTurn[] | null> {
    // Transcribe each segment in order, offsetting timestamps so a multi-part call
    // reads as one continuous timeline.
    const segs: { start: number; end: number; text: string }[] = [];
    let offset = 0;
    for (const r of call.recordings) {
      const audio = await this.callHistory.recordingAudioInternal(r.id);
      if (!audio) continue;
      const t = await this.groq.transcribe(audio.body, audio.filename, audio.mimeType);
      if (!t?.segments.length) continue;
      for (const s of t.segments) segs.push({ start: s.start + offset, end: s.end + offset, text: s.text });
      offset += t.segments[t.segments.length - 1].end;
    }
    if (!segs.length) return null;

    const labels = await this.groq.labelSpeakers(segs, {
      employee: employeeName,
      customer: customerName,
      direction: call.direction ?? 'unknown',
    });

    // Fallback attribution: the caller speaks first (outbound → employee), and the
    // speaker flips whenever there's a >1.5s gap between segments.
    let cur: 'employee' | 'customer' = call.direction === CommDirection.inbound ? 'customer' : 'employee';
    let prevEnd = 0;
    return segs.map((s, i) => {
      let speaker: 'employee' | 'customer';
      if (labels) speaker = labels[i];
      else {
        if (i > 0 && s.start - prevEnd > 1.5) cur = cur === 'employee' ? 'customer' : 'employee';
        speaker = cur;
      }
      prevEnd = s.end;
      return {
        speaker,
        speakerName: speaker === 'employee' ? employeeName : customerName,
        text: s.text,
        startSecs: Math.round(s.start),
        endSecs: Math.round(s.end),
      };
    });
  }

  /**
   * Produce the nine-section summary. Uses the LLM when configured; otherwise —
   * or if the LLM call fails — a deterministic heuristic built from the transcript
   * so an insight is always available.
   */
  private async buildSummary(
    call: {
      direction: CommDirection | null;
      caller: { name: string } | null;
      lead: { businessName: string; contactName: string | null } | null;
      externalNumber: string | null;
    },
    turns: TranscriptTurn[],
  ): Promise<{ summary: CallSummary; model: string; error: string | null }> {
    const plain = turns.map((t) => `${this.label(t)}: ${t.text}`).join('\n');

    // Shared prompt — the JSON key list makes it work for both Groq's JSON mode
    // and Anthropic's structured output.
    const system =
      'You summarise sales and service phone calls for Milta Financial Services, a bookkeeping and accounting firm, ' +
      'so a manager can review the call without listening to it. The Employee is the Milta agent; the Customer is the ' +
      'lead/prospect. Use only facts stated in the transcript — never invent details. Be precise and concise. ' +
      // Stated explicitly because a model left to itself answers in whatever
      // language the transcript is in. Managers read these summaries in English,
      // and one call transcribed differently should not produce a summary they
      // can't read. Quoted phrases are kept verbatim so the summary stays
      // faithful to what was actually said.
      'Write every field in English, even if the transcript is wholly or partly in another language; ' +
      'translate as needed, but keep any directly quoted phrase in its original wording. ' +
      'Respond ONLY with a JSON object with exactly these keys: "purpose" (string), "keyPoints" (string[]), ' +
      '"customerRequirements" (string[]), "questionsAsked" (string[]), "employeeResponses" (string[]), ' +
      '"decisions" (string[]), "followUps" (string[]), "outcome" (string), "nextSteps" (string[]). ' +
      'Use an empty array for any list section with no content.';
    const user =
      `Call context: customer = ${customerLabel(call)}; ` +
      `direction = ${call.direction ?? 'unknown'}; employee = ${call.caller?.name ?? 'unknown'}.\n\n` +
      `Transcript:\n${plain}\n\nSummarise this call into the required structured fields.`;

    // Prefer Groq (free tier) for the summary; fall back to Anthropic, then to the
    // deterministic heuristic so an insight is always produced.
    if (this.groq.isConfigured) {
      const g = await this.groq.summarizeJson(system, user);
      if (g) return { summary: this.normalise(g as Partial<CallSummary>), model: this.groq.chatModel, error: null };
    }
    if (this.llm.isConfigured) {
      const summary = await this.llm.generateJson<CallSummary>({ system, user, schema: SUMMARY_SCHEMA });
      if (summary) return { summary: this.normalise(summary), model: this.llm.model, error: null };
    }

    // No model produced output — deliver a heuristic so the manager isn't left with
    // nothing, and record why the real model wasn't used (if one was configured).
    const hadModel = this.groq.isConfigured || this.llm.isConfigured;
    return {
      summary: this.heuristicSummary(call, turns),
      model: 'heuristic',
      error: hadModel ? 'LLM unavailable — used heuristic summary' : null,
    };
  }

  /** Guard against a partial LLM object — every field must be the right shape. */
  private normalise(s: Partial<CallSummary>): CallSummary {
    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    return {
      purpose: str(s.purpose),
      keyPoints: arr(s.keyPoints),
      customerRequirements: arr(s.customerRequirements),
      questionsAsked: arr(s.questionsAsked),
      employeeResponses: arr(s.employeeResponses),
      decisions: arr(s.decisions),
      followUps: arr(s.followUps),
      outcome: str(s.outcome),
      nextSteps: arr(s.nextSteps),
    };
  }

  /**
   * A deterministic summary derived from the transcript with simple keyword rules.
   * Not as fluent as the LLM, but genuinely reflects each call — so the feature is
   * fully demonstrable in sandbox/dev without a key.
   */
  private heuristicSummary(
    call: {
      caller: { name: string } | null;
      lead: { businessName: string; contactName: string | null } | null;
      externalNumber: string | null;
    },
    turns: TranscriptTurn[],
  ): CallSummary {
    const employee = turns.filter((t) => t.speaker === 'employee');
    const customer = turns.filter((t) => t.speaker === 'customer');
    const has = (t: string, words: string[]) => words.some((w) => t.toLowerCase().includes(w));
    const trim = (t: string) => t.replace(/\s+/g, ' ').trim();
    const uniq = (a: string[]) => Array.from(new Set(a));
    const who = customerLabel(call);

    const questionsAsked = customer.filter((t) => t.text.includes('?')).map((t) => trim(t.text));
    // The employee turn right after each customer question is the response to it.
    const employeeResponses: string[] = [];
    turns.forEach((t, i) => {
      if (t.speaker === 'customer' && t.text.includes('?')) {
        const next = turns.slice(i + 1).find((n) => n.speaker === 'employee');
        if (next) employeeResponses.push(trim(next.text));
      }
    });

    const requirements = customer
      .filter((t) => has(t.text, ['need', 'want', 'require', 'help', 'problem', 'mess', 'looking', "don't have", 'struggle', 'cost']))
      .map((t) => trim(t.text));
    const decisions = turns
      .filter((t) => has(t.text, ['works', 'sounds good', "let's", 'agree', 'yes, please', 'will review', 'go ahead', 'that is fine', "that's fine"]))
      .map((t) => trim(t.text));
    const followUps = turns
      .filter((t) => has(t.text, ['send ', 'email', 'follow up', 'follow-up', 'quote', 'checklist', 'pencil you in', 'call back', 'call you', 'schedule', 'next week', 'first week']))
      .map((t) => trim(t.text));

    const agreed = decisions.length > 0 || has(turns.map((t) => t.text).join(' '), ['works', 'yes, please', 'sounds good']);

    return {
      purpose: employee[0] ? trim(employee[0].text) : `Discuss ${who}'s bookkeeping needs.`,
      keyPoints: uniq(turns.slice(0, 6).map((t) => `${t.speaker === 'employee' ? 'Employee' : 'Customer'}: ${trim(t.text)}`)),
      customerRequirements: uniq(requirements).slice(0, 6),
      questionsAsked: uniq(questionsAsked).slice(0, 6),
      employeeResponses: uniq(employeeResponses).slice(0, 6),
      decisions: uniq(decisions).slice(0, 6),
      followUps: uniq(followUps).slice(0, 6),
      outcome: agreed
        ? `Positive — ${who} is interested and a follow-up was agreed.`
        : `${who} discussed their needs; no firm commitment yet.`,
      nextSteps: uniq(
        followUps.length
          ? followUps.slice(0, 4)
          : [`Follow up with ${who} to move the conversation forward.`],
      ),
    };
  }

  /** A readable multiline rendering of the summary, mirrored onto Call.aiSummary. */
  private flattenSummary(s: CallSummary): string {
    const section = (title: string, body: string | string[]) => {
      const lines = Array.isArray(body) ? body : body ? [body] : [];
      if (!lines.length) return '';
      return `${title}:\n${lines.map((l) => `• ${l}`).join('\n')}`;
    };
    return [
      section('Purpose', s.purpose),
      section('Key discussion points', s.keyPoints),
      section('Customer requirements', s.customerRequirements),
      section('Questions asked', s.questionsAsked),
      section('Employee responses', s.employeeResponses),
      section('Decisions made', s.decisions),
      section('Follow-up actions', s.followUps),
      section('Overall outcome', s.outcome),
      section('Suggested next steps', s.nextSteps),
    ].filter(Boolean).join('\n\n');
  }

  // ── Read side (Calling Panel modal) ──

  /**
   * Full insight for one call. PERM: managers see any call; an employee sees only
   * their own — the same rule the recording audio proxy enforces.
   */
  async getInsight(callId: string, user: { id: string; role: Role }) {
    const call = await this.prisma.call.findUnique({
      where: { id: callId },
      select: { id: true, callerId: true, insight: true },
    });
    if (!call) throw new NotFoundException('Call not found');
    if (!this.isManager(user.role) && call.callerId !== user.id) {
      throw new ForbiddenException('That call belongs to another caller');
    }
    const i = call.insight;
    return {
      callId,
      status: i?.status ?? 'none',
      summary: (i?.summary as unknown as CallSummary | null) ?? null,
      transcript: (i?.transcript as unknown as TranscriptTurn[] | null) ?? null,
      model: i?.model ?? null,
      source: i?.source ?? null,
      generatedAt: i?.generatedAt ?? null,
      error: i?.error ?? null,
    };
  }

  /** Regenerate one call's insight (manager or owner). Returns the queued status. */
  async regenerate(callId: string, user: { id: string; role: Role }) {
    const call = await this.prisma.call.findUnique({ where: { id: callId }, select: { id: true, callerId: true } });
    if (!call) throw new NotFoundException('Call not found');
    if (!this.isManager(user.role) && call.callerId !== user.id) {
      throw new ForbiddenException('That call belongs to another caller');
    }
    await this.upsertInsight(callId, { status: 'pending', error: null });
    this.enqueue(callId);
    return { callId, status: 'pending' as const };
  }
}
