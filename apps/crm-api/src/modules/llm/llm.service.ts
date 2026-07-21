import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

export interface GenerateJsonOptions {
  system: string;
  user: string;
  /** JSON schema the model's output is constrained to (Anthropic structured outputs). */
  schema: Record<string, unknown>;
  maxTokens?: number;
}

/**
 * Thin wrapper over the official Anthropic SDK, used to turn a call transcript
 * into a structured summary.
 *
 * Kept deliberately small and provider-swappable: the model id comes from
 * ANTHROPIC_MODEL (default claude-opus-4-8), and everything degrades to `null`
 * when no key is configured — callers (CallInsightsService) then fall back to a
 * deterministic heuristic so the feature still works in sandbox/dev, matching how
 * the OpenPhone client simulates the provider without real credentials.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private client: Anthropic | null = null;

  /** True when a real LLM call can be made; otherwise callers use the fallback. */
  get isConfigured(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  get model(): string {
    return process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
  }

  private get anthropic(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return this.client;
  }

  /**
   * Ask the model for a JSON object matching `schema`. Returns the parsed object,
   * or null on any failure (no key, refusal, timeout, malformed JSON) so the
   * caller can fall back rather than propagate an error into the sync pipeline.
   */
  async generateJson<T>(opts: GenerateJsonOptions): Promise<T | null> {
    if (!this.isConfigured) return null;
    try {
      const res = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: opts.maxTokens ?? 4096,
        system: opts.system,
        // Structured outputs: constrain the response to the schema so the text
        // block is always a parseable JSON document of the shape we expect.
        output_config: { format: { type: 'json_schema', schema: opts.schema } },
        messages: [{ role: 'user', content: opts.user }],
      });

      if (res.stop_reason === 'refusal') {
        this.logger.warn('LLM declined to summarise this call');
        return null;
      }
      const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
      if (!text) return null;
      return JSON.parse(text) as T;
    } catch (err) {
      this.logger.warn(`LLM summary generation failed: ${(err as Error).message}`);
      return null;
    }
  }
}
