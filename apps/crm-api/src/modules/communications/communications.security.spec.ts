import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OpenPhoneService } from '../openphone/openphone.service.js';
import { CallInsightsService } from './call-insights.service.js';
import { CommunicationsService } from './communications.service.js';

/**
 * The two doors into communications that an outsider or a colleague could abuse:
 * the public webhook (forged events) and the lead-scoped send/call routes (one
 * rep acting on another's lead, or texting as someone else).
 */

const SECRET = Buffer.from('test-signing-secret-that-is-long-enough').toString('base64');
const BODY = JSON.stringify({ type: 'call.ringing', data: { object: { id: 'c1' } } });
const sign = (ts: number, secret = SECRET) =>
  `hmac;1;${ts};${crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(`${ts}.${BODY}`).digest('base64')}`;

const ENV_KEYS = ['NODE_ENV', 'QUO_WEBHOOK_SECRET', 'OPENPHONE_WEBHOOK_SECRET', 'WEBHOOK_MAX_AGE_SECONDS'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function service(prisma: Partial<Record<string, unknown>> = {}, openphone: Partial<Record<string, unknown>> = {}) {
  return new CommunicationsService(
    prisma as unknown as PrismaService,
    openphone as unknown as OpenPhoneService,
    { enqueue: jest.fn() } as unknown as CallInsightsService,
  );
}

describe('webhook verification', () => {
  it('refuses unsigned deliveries in production when no secret is configured', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.QUO_WEBHOOK_SECRET;
    delete process.env.OPENPHONE_WEBHOOK_SECRET;
    expect(service().verifyWebhook(BODY, undefined)).toEqual({ ok: false, reason: 'no-secret-configured' });
    // The token route has its own credential, so it may run without a secret.
    expect(service().verifyWebhook(BODY, undefined, { allowUnsigned: true }).ok).toBe(true);
  });

  it('still accepts unsigned deliveries outside production (local development)', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.QUO_WEBHOOK_SECRET;
    delete process.env.OPENPHONE_WEBHOOK_SECRET;
    expect(service().verifyWebhook(BODY, undefined).ok).toBe(true);
  });

  it('accepts a fresh, correctly signed delivery', () => {
    process.env.QUO_WEBHOOK_SECRET = SECRET;
    expect(service().verifyWebhook(BODY, sign(Date.now())).ok).toBe(true);
  });

  it('refuses a correctly signed delivery that is too old to be anything but a replay', () => {
    process.env.QUO_WEBHOOK_SECRET = SECRET;
    process.env.WEBHOOK_MAX_AGE_SECONDS = '600';
    expect(service().verifyWebhook(BODY, sign(Date.now() - 3_600_000))).toEqual({ ok: false, reason: 'stale-signature' });
  });

  it('refuses a signature made with some other secret', () => {
    process.env.QUO_WEBHOOK_SECRET = SECRET;
    const other = Buffer.from('a-completely-different-secret-value').toString('base64');
    expect(service().verifyWebhook(BODY, sign(Date.now(), other))).toEqual({ ok: false, reason: 'signature-mismatch' });
  });
});

describe('lead-scoped sends and calls', () => {
  const LEAD = { id: 'lead-1', phone: '+18135550199', assignedToId: 'rep-a', closedById: null, deletedAt: null };

  function harness() {
    const sendSms = jest.fn(async () => ({ success: true, data: { id: 'm1', status: 'queued' } }));
    const prisma = {
      lead: { findFirst: jest.fn(async () => LEAD), update: jest.fn(async () => LEAD), updateMany: jest.fn(async () => ({ count: 1 })) },
      user: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({ name: where.id, openphoneNumber: `+1555000${where.id === 'admin' ? '0001' : '0002'}` })),
        findFirst: jest.fn(async ({ where }: { where: { openphoneNumber: string } }) => (where.openphoneNumber === '+15550009999' ? { id: 'rep-b' } : null)),
      },
      message: { create: jest.fn(async ({ data }: { data: unknown }) => data) },
      appSetting: { findUnique: jest.fn(async () => null) },
    };
    return { svc: service(prisma, { sendSms }), sendSms };
  }

  it("refuses an employee texting another rep's lead, as if the lead did not exist", async () => {
    const { svc, sendSms } = harness();
    await expect(svc.sendSms('lead-1', 'hi', { id: 'rep-b', role: 'employee' })).rejects.toBeInstanceOf(NotFoundException);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('refuses a non-admin choosing the number they send from', async () => {
    const { svc, sendSms } = harness();
    await expect(svc.sendSms('lead-1', 'hi', { id: 'rep-a', role: 'employee' }, '+15550009999')).rejects.toBeInstanceOf(ForbiddenException);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('lets an admin send from a line that is assigned in the workspace — and only such a line', async () => {
    const { svc, sendSms } = harness();
    await expect(svc.sendSms('lead-1', 'hi', { id: 'admin', role: 'admin' }, '+15550001234')).rejects.toBeInstanceOf(BadRequestException);
    await svc.sendSms('lead-1', 'hi', { id: 'admin', role: 'admin' }, '+15550009999');
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it("refuses an employee dialling another rep's lead by id", async () => {
    const { svc } = harness();
    await expect(svc.startCall('lead-1', 'rep-b', 'employee')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('webhook delivery dedupe', () => {
  function harness() {
    const seen = new Set<string>();
    const webhookEvent = {
      create: jest.fn(async ({ data }: { data: { id: string } }) => {
        if (seen.has(data.id)) throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        seen.add(data.id);
        return data;
      }),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        seen.delete(where.id);
        return {};
      }),
    };
    const svc = service({ webhookEvent });
    return { svc, webhookEvent, seen };
  }

  it('processes an event once and acknowledges the duplicate delivery without reprocessing it', async () => {
    const { svc } = harness();
    const handle = jest.spyOn(svc, 'handleEvent').mockResolvedValue({ ok: true } as never);
    await svc.handleWebhook({ id: 'EV1', type: 'call.ringing' });
    const second = await svc.handleWebhook({ id: 'EV1', type: 'call.ringing' });
    expect(handle).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ duplicate: true, eventId: 'EV1' });
  });

  it('releases the claim when processing fails, so the provider retry is processed', async () => {
    const { svc, seen } = harness();
    const handle = jest.spyOn(svc, 'handleEvent').mockRejectedValueOnce(new Error('db down')).mockResolvedValue({ ok: true } as never);
    await expect(svc.handleWebhook({ id: 'EV2', type: 'call.completed' })).rejects.toThrow('db down');
    expect(seen.has('EV2')).toBe(false);
    await svc.handleWebhook({ id: 'EV2', type: 'call.completed' });
    expect(handle).toHaveBeenCalledTimes(2);
  });
});

describe('SMS opt-out', () => {
  it('marks every lead on the number opted out on a STOP reply — and only on a reply that IS the keyword', async () => {
    const updateMany = jest.fn(async (_args: unknown) => ({ count: 2 }));
    const svc = service({
      lead: { findFirst: jest.fn(async () => null), updateMany },
      message: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
    });
    const inbound = (text: string) =>
      svc.handleEvent({ type: 'message.received', data: { object: { id: `m-${text}`, direction: 'incoming', from: '+18135550199', to: '+18135550100', text } } });

    await inbound('Please do not stop calling');
    expect(updateMany).not.toHaveBeenCalled();

    await inbound(' Stop! ');
    expect(updateMany).toHaveBeenCalledWith({
      where: { deletedAt: null, phone: { contains: '8135550199' }, smsOptOutAt: null },
      data: { smsOptOutAt: expect.any(Date) },
    });
  });

  it('refuses to text a contact who opted out', async () => {
    const sendSms = jest.fn();
    const svc = service(
      { lead: { findFirst: jest.fn(async () => ({ id: 'l1', phone: '+18135550199', assignedToId: 'rep-a', closedById: null, smsOptOutAt: new Date() })) } },
      { sendSms },
    );
    await expect(svc.sendSms('l1', 'hello', { id: 'rep-a', role: 'employee' })).rejects.toThrow(/opted out/);
    expect(sendSms).not.toHaveBeenCalled();
  });
});
