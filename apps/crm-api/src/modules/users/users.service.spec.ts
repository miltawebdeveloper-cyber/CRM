import { describe, expect, it, jest } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import { Role } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TrustedDeviceService } from '../auth/trusted-device.service.js';
import { UsersService } from './users.service.js';

/**
 * Deleting a user is allowed only where there is no history to protect.
 *
 * A user who has called, written a note or been assigned a lead IS the
 * attribution on those records — "who made this call" is part of what the record
 * means. So `remove` is for the account created by mistake and never used, and
 * everything else is refused with a sentence saying to deactivate instead.
 *
 * These pin the three refusals and the one success, including that the refusal
 * NAMES what is in the way: an admin who is told "no" with no reason has learned
 * nothing and will try again.
 */
describe('UsersService — permanent delete', () => {
  interface UserRow {
    id: string;
    name: string;
    email: string;
    role: Role;
    isActive: boolean;
  }
  const TARGET: UserRow = {
    id: 'user-2',
    name: 'Sam Patel',
    email: 'sam@example.com',
    role: Role.employee,
    isActive: true,
  };
  const ADMIN = { id: 'admin-1' };

  /**
   * `counts` is what the work scan finds, in the order `workAttachedTo` asks:
   * calls, activities, notes, assigned leads, closed leads, assignments,
   * handovers, productivity, coaching, meetings, targets, messages, follow-ups.
   * All zeroes means an account that never did anything.
   */
  function harness(
    { user = TARGET, counts = new Array(13).fill(0) as number[], otherActiveAdmins = 2 }: {
      user?: UserRow;
      counts?: number[];
      otherActiveAdmins?: number;
    } = {},
  ) {
    type Where = { where: Record<string, unknown> };
    const userDelete = jest.fn(async (_args: Where) => ({}));
    const notificationDeleteMany = jest.fn(async (_args: Where) => ({ count: 0 }));
    const aiDeleteMany = jest.fn(async (_args: Where) => ({ count: 0 }));
    const activityCreate = jest.fn(async (_args: { data: Record<string, unknown> }) => ({}));
    const revoke = jest.fn(async () => undefined);

    const tx = {
      notification: { deleteMany: notificationDeleteMany },
      aiTrainingSession: { deleteMany: aiDeleteMany },
      user: { delete: userDelete },
      activity: { create: activityCreate },
    };

    const prisma = {
      user: {
        findUnique: jest.fn(async () => user),
        count: jest.fn(async () => otherActiveAdmins),
      },
      // The count batch. Each entry is a thenable stand-in; the service hands
      // them to $transaction, which resolves to the array below.
      call: { count: jest.fn() },
      activity: { count: jest.fn() },
      note: { count: jest.fn() },
      lead: { count: jest.fn() },
      assignment: { count: jest.fn() },
      productivityLog: { count: jest.fn() },
      voiceCoachingReport: { count: jest.fn() },
      zoomMeeting: { count: jest.fn() },
      target: { count: jest.fn() },
      message: { count: jest.fn() },
      leadFollowup: { count: jest.fn() },
      $transaction: jest.fn(async (arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (t: typeof tx) => Promise<unknown>)(tx)
          : counts,
      ),
    } as unknown as PrismaService;

    const service = new UsersService(prisma, { revokeOnSecurityChange: revoke } as unknown as TrustedDeviceService);
    return { service, userDelete, activityCreate, revoke, notificationDeleteMany, aiDeleteMany };
  }

  it('deletes an account that never recorded anything', async () => {
    const { service, userDelete, revoke } = harness();
    const res = await service.remove(TARGET.id, ADMIN);

    expect(res).toEqual({ id: TARGET.id, deleted: true });
    expect(userDelete).toHaveBeenCalledWith({ where: { id: TARGET.id } });
    // A device trusted by an account that no longer exists must not survive it.
    expect(revoke).toHaveBeenCalled();
  });

  it('clears the account\'s own inbox and coaching material first', async () => {
    // Both are required relations, so they have to go before the user row.
    const { service, notificationDeleteMany, aiDeleteMany } = harness();
    await service.remove(TARGET.id, ADMIN);

    expect(notificationDeleteMany).toHaveBeenCalledWith({ where: { userId: TARGET.id } });
    expect(aiDeleteMany).toHaveBeenCalledWith({ where: { userId: TARGET.id } });
  });

  it('records the deletion against the admin who did it, not the deleted user', async () => {
    const { service, activityCreate } = harness();
    await service.remove(TARGET.id, ADMIN);

    const data = activityCreate.mock.calls[0][0].data;
    // Attributing it to the deleted user would delete the audit entry with them.
    expect(data.userId).toBe(ADMIN.id);
    expect(data.leadId).toBeNull();
    expect(data.action).toBe('user_deleted');
    expect(String(data.remarks)).toContain(TARGET.email);
  });

  it('refuses a user with recorded work, and says what is in the way', async () => {
    // 12 calls and 3 notes on record.
    const counts = new Array(13).fill(0);
    counts[0] = 12; // calls
    counts[2] = 3; // notes
    const { service, userDelete } = harness({ counts });

    await expect(service.remove(TARGET.id, ADMIN)).rejects.toThrow(ConflictException);
    await expect(service.remove(TARGET.id, ADMIN)).rejects.toThrow(/12 calls/);
    await expect(service.remove(TARGET.id, ADMIN)).rejects.toThrow(/3 notes/);
    // And names the operation they actually want.
    await expect(service.remove(TARGET.id, ADMIN)).rejects.toThrow(/[Dd]eactivate/);
    expect(userDelete).not.toHaveBeenCalled();
  });

  it('counts a single record in the singular', async () => {
    const counts = new Array(13).fill(0);
    counts[0] = 1;
    const { service } = harness({ counts });

    await expect(service.remove(TARGET.id, ADMIN)).rejects.toThrow(/1 call\b/);
  });

  it('refuses to delete the account you are signed in as', async () => {
    const { service, userDelete } = harness({ user: { ...TARGET, id: ADMIN.id } });

    await expect(service.remove(ADMIN.id, ADMIN)).rejects.toThrow(/signed in as/);
    expect(userDelete).not.toHaveBeenCalled();
  });

  it('refuses to delete the last active admin', async () => {
    const admin = { ...TARGET, id: 'user-9', role: Role.admin };
    const { service, userDelete } = harness({ user: admin, otherActiveAdmins: 0 });

    await expect(service.remove(admin.id, ADMIN)).rejects.toThrow(/only active admin/);
    expect(userDelete).not.toHaveBeenCalled();
  });

  it('allows deleting an admin while another active one remains', async () => {
    const admin = { ...TARGET, id: 'user-9', role: Role.admin };
    const { service, userDelete } = harness({ user: admin, otherActiveAdmins: 1 });

    await service.remove(admin.id, ADMIN);
    expect(userDelete).toHaveBeenCalled();
  });
});
