import { describe, expect, it, jest } from '@jest/globals';
import { Role } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivitiesService } from './activities.service';

/**
 * The Activity Tracker feed is open to every role, so the scoping in `list` is
 * now the ONLY thing standing between an employee and the whole floor's
 * activity. It used to sit behind an admin-only route guard, which meant it had
 * never actually run — dead code that looked like protection. It is load-bearing
 * now, so it is tested.
 */
describe('ActivitiesService — the tracker feed is scoped by role', () => {
  function harness() {
    const findMany = jest.fn(async (_args: { where: Record<string, unknown>; take: number }) => []);
    const service = new ActivitiesService({ activity: { findMany } } as unknown as PrismaService);
    return { service, findMany };
  }

  const whereOf = (findMany: { mock: { calls: [{ where: Record<string, unknown> }][] } }) =>
    findMany.mock.calls[0][0].where;

  it('narrows an employee to their own activity', async () => {
    const { service, findMany } = harness();
    await service.list({ id: 'user-1', role: Role.employee });

    expect(whereOf(findMany)).toEqual({ userId: 'user-1' });
  });

  it('leaves a team leader unscoped — the floor is the point of the view', async () => {
    const { service, findMany } = harness();
    await service.list({ id: 'user-9', role: Role.team_leader });

    expect(whereOf(findMany)).toEqual({});
  });

  it('leaves an admin unscoped', async () => {
    const { service, findMany } = harness();
    await service.list({ id: 'user-9', role: Role.admin });

    expect(whereOf(findMany)).toEqual({});
  });

  it('caps how much any one request can pull', async () => {
    const { service, findMany } = harness();
    await service.list({ id: 'user-1', role: Role.employee }, 5000);

    expect(findMany.mock.calls[0][0].take).toBe(200);
  });
});
