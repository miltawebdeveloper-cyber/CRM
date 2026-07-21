import { Injectable, Logger } from '@nestjs/common';

export interface WhisperSegment {
  start: number; // seconds
  end: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  segments: WhisperSegment[];
  language?: string;
}

/**
 * Groq (https://console.groq.com) — a free-tier provider used to transcribe call
 * recordings when the telephony provider (OpenPhone/Quo) has no transcript of its
 * own. Whisper produces timestamped segments; a small Llama pass then labels each
 * segment as the employee or the customer (Whisper alone doesn't diarize).
 *
 * OpenAI-compatible REST API, called with plain fetch to match the OpenPhone
 * client's dependency-free style. Everything degrades to null on failure so the
 * caller falls back rather than breaking insight generation.
 */
@Injectable()
export class GroqService {
  private readonly logger = new Logger(GroqService.name);
  private readonly base = 'https://api.groq.com/openai/v1';

  get isConfigured(): boolean {
    return !!process.env.GROQ_API_KEY;
  }
  private get key(): string {
    return process.env.GROQ_API_KEY ?? '';
  }
  get transcribeModel(): string {
    return process.env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3';
  }
  get chatModel(): string {
    return process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  }

  /** Transcribe audio to timestamped segments. Returns null on any failure. */
  async transcribe(audio: Buffer, filename: string, mimeType: string): Promise<TranscriptionResult | null> {
    if (!this.isConfigured) return null;
    try {
      const form = new FormData();
      // Copy into a plain ArrayBuffer — a Node Buffer's backing store is typed as
      // ArrayBufferLike (possibly SharedArrayBuffer), which Blob's types reject.
      const ab = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
      form.append('file', new Blob([ab], { type: mimeType || 'audio/mpeg' }), filename);
      form.append('model', this.transcribeModel);
      form.append('response_format', 'verbose_json'); // gives us per-segment timestamps
      form.append('temperature', '0');
      const res = await fetch(`${this.base}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.key}` },
        body: form,
      });
      if (!res.ok) {
        this.logger.warn(`Groq transcription failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
        return null;
      }
      const data = (await res.json()) as { text?: string; language?: string; segments?: Array<{ start?: number; end?: number; text?: string }> };
      const segments: WhisperSegment[] = (data.segments ?? [])
        .map((s) => ({ start: Number(s.start ?? 0), end: Number(s.end ?? 0), text: (s.text ?? '').trim() }))
        .filter((s) => s.text);
      return { text: data.text ?? '', segments, language: data.language };
    } catch (err) {
      this.logger.warn(`Groq transcription error: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Label each transcript segment 'employee' or 'customer'. Returns an array
   * aligned 1:1 with `segments`, or null if unavailable/malformed so the caller
   * can fall back to a heuristic attribution.
   */
  async labelSpeakers(
    segments: { text: string }[],
    ctx: { employee: string; customer: string; direction: string },
  ): Promise<Array<'employee' | 'customer'> | null> {
    if (!this.isConfigured || segments.length === 0) return null;
    try {
      const numbered = segments.map((s, i) => `${i}: ${s.text}`).join('\n');
      const system =
        `You label each numbered line of a two-party phone call transcript. "employee" is the ${ctx.employee} ` +
        `(a Milta Financial Services bookkeeping agent); "customer" is the ${ctx.customer} (the lead/prospect). ` +
        `The call direction is ${ctx.direction}. Consecutive lines are usually the same speaker; speakers alternate ` +
        `at natural turn boundaries. Respond ONLY with JSON {"speakers":[...]} containing exactly one value ` +
        `("employee" or "customer") per numbered line, in order.`;
      const res = await fetch(`${this.base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.chatModel,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: numbered },
          ],
        }),
      });
      if (!res.ok) {
        this.logger.warn(`Groq speaker labeling failed (${res.status})`);
        return null;
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;
      if (!content) return null;
      const parsed = JSON.parse(content) as { speakers?: unknown };
      const arr = parsed.speakers;
      if (!Array.isArray(arr) || arr.length !== segments.length) return null;
      return arr.map((x) => (x === 'employee' ? 'employee' : 'customer'));
    } catch (err) {
      this.logger.warn(`Groq speaker labeling error: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Summarise a transcript into a JSON object. The required shape must be spelled
   * out in `system` (Groq uses JSON mode, not a schema param). Returns the parsed
   * object or null on any failure so the caller can fall back to a heuristic.
   */
  async summarizeJson(system: string, user: string): Promise<Record<string, unknown> | null> {
    if (!this.isConfigured) return null;
    try {
      const res = await fetch(`${this.base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.chatModel,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!res.ok) {
        this.logger.warn(`Groq summary failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
        return null;
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;
      if (!content) return null;
      return JSON.parse(content) as Record<string, unknown>;
    } catch (err) {
      this.logger.warn(`Groq summary error: ${(err as Error).message}`);
      return null;
    }
  }
}
