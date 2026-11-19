import { describe, expect, it, jest } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import { Role } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TrustedDeviceService } from '../auth/trusted-device.service.js';
import { SessionService } from '../auth/session.service.js';
import { UsersService } from './users.service.js';

/**
 * The Users page must never be able to leave the system with nobody who can
 * administer it, nor let an admin lock themselves out — the only recovery from
 * either is editing the database by hand.
 */
describe('UsersService admin guards', () => {
  function harness(target: { id: string; role: Role; isActive: boolean; email?: string }, otherActiveAdmins: number) {
    const update = jest.fn(async () => ({ ...target }));
    const prisma = {
      user: {
        findUnique: jest.fn(async ({ where }: { where: { id?: string; email?: string } }) =>
          where.id === target.id ? { ...target, email: target.email ?? 't@crm.test', name: 'T' } : where.email === 'taken@crm.test' ? { id: 'someone-else' } : null,
        ),
        count: jest.fn(async () => otherActiveAdmins),
        update,
      },
    } as unknown as PrismaService;
    const service = new UsersService(
      prisma,
      { revokeOnSecurityChange: jest.fn() } as unknown as TrustedDeviceService,
      { revokeAllForUser: jest.fn(async () => 0), forgetUser: jest.fn() } as unknown as SessionService,
    );
    return { service, update };
  }

  const ADMIN = { id: 'admin-1', role: Role.admin, isActive: true };

  it('refuses to demote the only active admin', async () => {
    const { service, update } = harness(ADMIN, 0);
    await expect(service.update(ADMIN.id, { role: Role.employee }, { id: 'admin-2' })).rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses to deactivate the only active admin', async () => {
    const { service } = harness(ADMIN, 0);
    await expect(service.deactivate(ADMIN.id, { id: 'admin-2' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses an admin removing their own admin access, even when others exist', async () => {
    const { service } = harness(ADMIN, 3);
    await expect(service.update(ADMIN.id, { isActive: false }, { id: ADMIN.id })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.deactivate(ADMIN.id, { id: ADMIN.id })).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows demoting an admin when another active admin remains', async () => {
    const { service, update } = harness(ADMIN, 1);
    await service.update(ADMIN.id, { role: Role.team_leader }, { id: 'admin-2' });
    expect(update).toHaveBeenCalled();
  });

  it('answers a duplicate email with 409, not a database error', async () => {
    const { service } = harness({ id: 'u1', role: Role.employee, isActive: true }, 1);
    await expect(service.update('u1', { email: 'taken@crm.test' }, { id: 'admin-2' })).rejects.toBeInstanceOf(ConflictException);
  });
});
