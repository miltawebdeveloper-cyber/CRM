import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MailService } from '../mail/mail.service.js';
import { LoginOtpService } from './login-otp.service.js';

/**
 * A login code that never arrives strands the user on the OTP screen. These pin
 * that a failed email is SAID to the person signing in, that a merely slow one
 * still goes out behind the response, and that production never pretends to
 * send a code it has no way to deliver.
 */
describe('LoginOtpService delivery', () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, WAIT: process.env.OTP_DELIVERY_WAIT_MS };
  afterEach(() => {
    process.env.NODE_ENV = saved.NODE_ENV;
    if (saved.WAIT === undefined) delete process.env.OTP_DELIVERY_WAIT_MS;
    else process.env.OTP_DELIVERY_WAIT_MS = saved.WAIT;
  });

  const USER = { id: 'u1', email: 'rep@crm.test', name: 'Rep' };

  function harness(send: () => Promise<boolean>, enabled = true) {
    const rows = new Map<string, { id: string; consumedAt: Date | null; createdAt: Date; user: typeof USER }>();
    const prisma = {
      appSetting: { findUnique: jest.fn(async () => null) },
      activity: { create: jest.fn(async () => ({})) },
      loginOtp: {
        updateMany: jest.fn(async ({ where, data }: { where: { id?: string }; data: { consumedAt: Date } }) => {
          for (const r of rows.values()) if (!where.id || r.id === where.id) r.consumedAt = data.consumedAt;
          return { count: 1 };
        }),
        create: jest.fn(async () => {
          const row = { id: `otp-${rows.size + 1}`, consumedAt: null, createdAt: new Date(), user: USER };
          rows.set(row.id, row);
          return { id: row.id };
        }),
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      },
    } as unknown as PrismaService;
    const mail = { enabled, send: jest.fn(send) } as unknown as MailService;
    return { service: new LoginOtpService(prisma, mail), rows };
  }

  it('tells the user straight away when the email fails, and spends the code', async () => {
    const { service, rows } = harness(async () => false);
    await expect(service.issue(USER)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect([...rows.values()][0].consumedAt).not.toBeNull();
  });

  it('answers without waiting out a slow send, and lets the user resend at once if it then fails', async () => {
    process.env.OTP_DELIVERY_WAIT_MS = '20';
    let fail!: () => void;
    const { service } = harness(() => new Promise<boolean>((resolve) => (fail = () => resolve(false))));
    const { challengeId } = await service.issue(USER); // returned while the send is still going
    fail();
    await new Promise((r) => setTimeout(r, 0));
    // Inside the normal 60 s resend cooldown — allowed, because the email is
    // known to have failed (otherwise this is a "Please wait" BadRequest).
    const again = await service.resend(challengeId);
    expect(again.challengeId).not.toBe(challengeId);
  });

  it('still enforces the resend cooldown for a code whose email went out', async () => {
    const { service } = harness(async () => true);
    const { challengeId } = await service.issue(USER);
    await expect(service.resend(challengeId)).rejects.toThrow(/Please wait/);
  });

  it('refuses to issue a code in production when no mail is configured', async () => {
    process.env.NODE_ENV = 'production';
    const { service, rows } = harness(async () => true, false);
    await expect(service.issue(USER)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(rows.size).toBe(0);
  });
});
