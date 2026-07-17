import { Controller, Post, Req, Headers, ForbiddenException, HttpCode, Logger } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { CommunicationsService } from './communications.service';

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
    if (!this.comms.verifySignature(raw, sig)) throw new ForbiddenException('Invalid webhook signature');
    return this.comms.handleEvent((req.body as Record<string, unknown>) ?? {});
  }
}
