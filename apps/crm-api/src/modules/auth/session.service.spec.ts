import { describe, expect, it, jest } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SessionService } from './session.service.js';

/**
 * Sessions are what make a token revocable, and rotation is what makes a stolen
 * refresh token detectable. These pin the rules that decide whether a refresh
 * keeps someone signed in or signs them out — the two failures that matter are
 * a thief keeping a session alive, and a legitimate user with three tabs open
 * being signed out because the tabs refreshed together.
 */
describe('SessionService', () => {
  type Row = {
    id: string;
    userId: string;
    generation: number;
    rotatedAt: Date | null;
    revokedAt: Date | null;
    revokedReason: string | null;
    expiresAt: Date;
    user: { id: string; email: string; role: 'employee'; isActive: boolean };
  };

  function harness(overrides: Partial<Row> = {}) {
    const row: Row = {
      id: 'sid-1',
      userId: 'u1',
      generation: 0,
      rotatedAt: null,
      revokedAt: null,
      revokedReason: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      user: { id: 'u1', email: 'rep@example.com', role: 'employee', isActive: true },
      ...overrides,
    };
    const activityCreate = jest.fn(async () => ({}));
    const prisma = {
      authSession: {
        findUnique: jest.fn(async () => ({ ...row, user: { ...row.user } })),
        updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
          // Honour the conditional parts of the WHERE the service relies on.
          if (where.id !== row.id) return { count: 0 };
          if ('revokedAt' in where && where.revokedAt === null && row.revokedAt) return { count: 0 };
          if ('generation' in where && where.generation !== row.generation) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
      activity: { create: activityCreate },
    } as unknown as PrismaService;
    return { service: new SessionService(prisma), row, activityCreate };
  }

  it('rotates the current generation forward by one', async () => {
    const { service, row } = harness();
    const r = await service.rotate('sid-1', 0, 'u1');
    expect(r.generation).toBe(1);
    expect(row.generation).toBe(1);
    expect(row.rotatedAt).not.toBeNull();
  });

  it('answers a just-replaced token with the CURRENT generation, so racing tabs converge', async () => {
    const { service, row } = harness();
    await service.rotate('sid-1', 0, 'u1'); // tab A
    const b = await service.rotate('sid-1', 0, 'u1'); // tab B, same old token, moments later
    expect(b.generation).toBe(1);
    expect(row.generation).toBe(1); // no second rotation
    expect(row.revokedAt).toBeNull();
  });

  it('treats an old token outside the grace window as theft and ends the session', async () => {
    const { service, row, activityCreate } = harness({ generation: 3, rotatedAt: new Date(Date.now() - 5 * 60_000) });
    await expect(service.rotate('sid-1', 2, 'u1')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedReason).toBe('refresh_token_reuse');
    expect(activityCreate).toHaveBeenCalled();
  });

  it('treats a token two generations old as theft even inside the window', async () => {
    const { service, row } = harness({ generation: 5, rotatedAt: new Date() });
    await expect(service.rotate('sid-1', 3, 'u1')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(row.revokedAt).not.toBeNull();
  });

  it('refuses a revoked session, an expired one, and a deactivated account', async () => {
    for (const o of [
      { revokedAt: new Date() },
      { expiresAt: new Date(Date.now() - 1000) },
      { user: { id: 'u1', email: 'x', role: 'employee' as const, isActive: false } },
    ]) {
      const { service } = harness(o);
      await expect(service.rotate('sid-1', 0, 'u1')).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it('refuses a token whose subject is not the session owner', async () => {
    const { service } = harness();
    await expect(service.rotate('sid-1', 0, 'someone-else')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('caches a valid session briefly, and a revoke takes effect immediately', async () => {
    const { service } = harness();
    const prisma = (service as unknown as { prisma: { authSession: { findUnique: jest.Mock } } }).prisma;
    await expect(service.validate('sid-1', 'u1')).resolves.toMatchObject({ id: 'u1' });
    await expect(service.validate('sid-1', 'u1')).resolves.toMatchObject({ id: 'u1' });
    expect(prisma.authSession.findUnique).toHaveBeenCalledTimes(1); // second answer came from the cache
    await service.revoke('sid-1', 'logout');
    await expect(service.validate('sid-1', 'u1')).resolves.toBeNull(); // not served stale after revoke
  });

  it('validate() only passes a live session belonging to the token subject', async () => {
    const live = harness();
    await expect(live.service.validate('sid-1', 'u1')).resolves.toMatchObject({ id: 'u1' });
    await expect(live.service.validate('sid-1', 'u2')).resolves.toBeNull();
    const revoked = harness({ revokedAt: new Date() });
    await expect(revoked.service.validate('sid-1', 'u1')).resolves.toBeNull();
  });
});
