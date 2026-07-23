import { Controller, Post, Req, Headers, Param, ForbiddenException, HttpCode, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { CommunicationsService } from './communications.service';

/**
 * Record the outcome of every webhook delivery attempt to stdout, so the incoming-call
 * flow stays traceable in a hosted environment (the platform captures stdout as runtime
 * logs). A REJECTED line is the single most useful signal there is: it means the provider
 * IS delivering and the signing secret is out of sync — the failure that silently breaks
 * the popup. Rejections log at warn so they stand out; accepted deliveries stay at debug
 * level noise-wise but remain greppable.
 */
const deliveryLog = new Logger('WebhookDelivery');
function recordWebhook(endpoint: string, type: string, signed: boolean, result: string) {
  const line = `endpoint=${endpoint} type=${type} signed=${signed} result=${result}`;
  if (result.startsWith('REJECTED')) deliveryLog.warn(line);
  else deliveryLog.log(line);
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
    const ok = this.comms.verifySignature(raw, sig);
    recordWebhook('/api/webhooks/quo', type, !!sig, ok ? 'ACCEPTED' : 'REJECTED(signature-mismatch)');
    if (!ok) throw new ForbiddenException('Invalid webhook signature');
    return this.comms.handleEvent((req.body as Record<string, unknown>) ?? {});
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
    const ok = this.comms.verifySignature(raw, sig);
    recordWebhook('/hook/:token', type, !!sig, ok ? 'ACCEPTED' : 'REJECTED(signature-mismatch)');
    if (!ok) throw new ForbiddenException('Invalid webhook signature');

    return this.comms.handleEvent((req.body as Record<string, unknown>) ?? {});
  }
}

