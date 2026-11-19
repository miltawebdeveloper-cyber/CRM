import { Controller, Post, Req, Headers, Param, ForbiddenException, HttpCode, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator.js';
import { CommunicationsService } from './communications.service.js';

/**
 * Record the outcome of every webhook delivery attempt to stdout, so the incoming-call
 * flow stays traceable in a hosted environment (the platform captures stdout as runtime
 * logs). A REJECTED line is the single most useful signal there is: it means the provider
 * IS delivering and the signing secret is out of sync — the failure that silently breaks
 * the popup. Rejections log at warn so they stand out; accepted deliveries stay at debug
 * level noise-wise but remain greppable.
 */
const deliveryLog = new Logger('WebhookDelivery');
function recordWebhook(endpoint: string, type: string, signed: boolean, result: string, body?: unknown) {
  const line = `endpoint=${endpoint} type=${type} signed=${signed} result=${result}`;
  if (result.startsWith('REJECTED')) deliveryLog.warn(line);
  else deliveryLog.log(line);
  // Dump the SHAPE of accepted call.* events. An ACCEPTED `call.ringing` that
  // produces no Call row means handleCall dropped it (e.g. `ignored: no phone`)
  // because the provider nests/names fields differently from what it reads
  // (data.object.from / .to / .direction) — and the payload's shape is the only
  // way to see that. It is REDACTED: this used to write customers' phone numbers,
  // call transcripts and AI summaries verbatim into the platform logs, which are
  // retained and readable far more widely than the database. Keys, ids, types,
  // statuses and timestamps survive; numbers keep their last 4 digits; free text
  // is replaced. WEBHOOK_LOG_PAYLOADS=full restores the raw dump for a debugging
  // session (and says so loudly); =off disables the dump entirely.
  const mode = (process.env.WEBHOOK_LOG_PAYLOADS ?? 'redacted').toLowerCase();
  if (result === 'ACCEPTED' && type.startsWith('call.') && body !== undefined && mode !== 'off') {
    try {
      if (mode === 'full') {
        deliveryLog.warn(`PAYLOAD(UNREDACTED — WEBHOOK_LOG_PAYLOADS=full) ${type}: ${JSON.stringify(body).slice(0, 4000)}`);
      } else {
        deliveryLog.log(`PAYLOAD ${type}: ${JSON.stringify(redactPayload(body)).slice(0, 4000)}`);
      }
    } catch {
      /* diagnostics must never break delivery */
    }
  }
}

/** Fields whose values are free text or personal data — replaced outright. */
const REDACT_KEYS = /transcript|summary|body|text|content|message|note|email|name|dialogue|recordingurl|^url$|media/i;
/** Something that looks like a phone number. */
const PHONE = /\+?\d[\d\s().-]{6,}\d/g;

/** A copy of a webhook payload safe to log: structure kept, PII masked. */
export function redactPayload(value: unknown, key = '', depth = 0): unknown {
  if (depth > 8) return '[…]';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (REDACT_KEYS.test(key)) return `[redacted ${value.length} chars]`;
    return value.replace(PHONE, (m) => {
      const digits = m.replace(/\D/g, '');
      return `…${digits.slice(-4)}`;
    });
  }
  if (Array.isArray(value)) {
    if (REDACT_KEYS.test(key)) return `[redacted ${value.length} item(s)]`;
    return value.slice(0, 20).map((v) => redactPayload(v, key, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactPayload(v, k, depth + 1);
    return out;
  }
  return String(value);
}

/** Inbound Quo (OpenPhone) webhooks — public, but HMAC-verified. */
@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(private readonly comms: CommunicationsService) {}

  @Public()
  @Post('quo')
  @HttpCode(200)
  async quo(@Req() req: RawBodyRequest<Request>, @Headers() headers: Record<string, string>) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const sig =
      headers['x-quo-signature'] ||
      headers['openphone-signature'] ||
      headers['x-openphone-signature'] ||
      headers['x-webhook-signature'];
    // Log every delivery so a real QUO event is visible even if it later fails
    // signature verification (distinguishes "not delivered" from "rejected").
    const type = (req.body as { type?: string })?.type ?? 'unknown';
    this.logger.log(`Webhook delivery received: type=${type}, signed=${sig ? 'yes' : 'no'}`);
    // Fails closed in production when no signing secret is configured — this
    // route has no other credential (see CommunicationsService.verifyWebhook).
    const { ok, reason } = this.comms.verifyWebhook(raw, sig);
    recordWebhook('/api/webhooks/quo', type, !!sig, ok ? 'ACCEPTED' : `REJECTED(${reason})`, req.body);
    if (!ok) {
      // Counted, so GET /communications/webhook/health can show accepted AND
      // rejected traffic side by side — the fingerprint of a duplicate Quo
      // subscription signing with a secret this deployment doesn't hold.
      this.comms.noteRejectedWebhook(type);
      throw new ForbiddenException('Invalid webhook signature');
    }
    return this.comms.handleWebhook((req.body as Record<string, unknown>) ?? {});
  }
}

/**
 * Quo delivers to `POST /hook/<token>` — a bare path proxied straight through to
 * this API, so it sits outside the `/api` prefix (see main.ts `exclude`).
 *
 * The token in the URL is the credential. This endpoint is public and it WRITES:
 * a forged payload can create leads, calls and follow-up tasks. So it fails
 * closed — an unset token is a misconfiguration, not a reason to accept
 * everything — and the comparison is timing-safe, since a leaky compare on a
 * secret in a URL is exactly how such a token gets guessed.
 */
@ApiTags('webhooks')
@Controller('hook')
export class QuoHookController {
  private readonly logger = new Logger(QuoHookController.name);

  constructor(private readonly comms: CommunicationsService) {}

  private tokenOk(provided: string): boolean {
    const expected = process.env.QUO_WEBHOOK_PATH_TOKEN ?? '';
    if (!expected) {
      this.logger.error('Rejected /hook delivery: QUO_WEBHOOK_PATH_TOKEN is not set. Set it to the token in your Quo webhook URL.');
      return false;
    }
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  @Public()
  @Post(':token')
  @HttpCode(200)
  async quoHook(
    @Param('token') token: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string>,
  ) {
    const type = (req.body as { type?: string })?.type ?? 'unknown';
    this.logger.log(`Hook delivery received: type=${type}`);
    if (!this.tokenOk(token)) {
      recordWebhook('/hook/:token', type, false, 'REJECTED(bad-token)');
      throw new ForbiddenException('Invalid webhook token');
    }

    // Signature is verified too when a signing secret is configured; the path
    // token alone proves the URL, not that Quo sent this particular body.
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const sig =
      headers['x-quo-signature'] ||
      headers['openphone-signature'] ||
      headers['x-openphone-signature'] ||
      headers['x-webhook-signature'];
    // The URL token has already been checked, so an unsigned delivery is allowed
    // here when no secret is configured; a configured secret is always enforced,
    // freshness included.
    const { ok, reason } = this.comms.verifyWebhook(raw, sig, { allowUnsigned: true });
    recordWebhook('/hook/:token', type, !!sig, ok ? 'ACCEPTED' : `REJECTED(${reason})`, req.body);
    if (!ok) {
      this.comms.noteRejectedWebhook(type);
      throw new ForbiddenException('Invalid webhook signature');
    }

    return this.comms.handleWebhook((req.body as Record<string, unknown>) ?? {});
  }
}

