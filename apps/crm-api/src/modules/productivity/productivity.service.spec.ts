import { describe, expect, it, jest } from '@jest/globals';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ProductivityService } from './productivity.service.js';

/**
 * Today per rep — the Call Summary page and the dashboard's leaderboard. It
 * must count calls the way the dashboard's call cards do, or the leaderboard
 * disagrees with the Connected Calls card beside it.
 */
describe('ProductivityService.dailySummary', () => {
  function harness() {
    const groupBy = jest.fn(async (a: { by: string[]; where: unknown }) =>
      a.by.length === 2
        ? [
            { callerId: 'ann', outcome: 'no_answer', _count: { _all: 3 } },
            { callerId: 'ann', outcome: 'call_back', _count: { _all: 2 } },
            { callerId: 'ann', outcome: 'closed_won', _count: { _all: 1 } },
            { callerId: 'ann', outcome: null, _count: { _all: 1 } },
          ]
        : [{ callerId: 'ann', _count: { _all: 5 } }],
    );
    const prisma = {
      user: { findMany: jest.fn(async () => [{ id: 'ann', name: 'Ann' }, { id: 'bob', name: 'Bob' }]) },
      call: { groupBy },
      // Ann has a daily call target; Bob has no employee target set.
      employee: { findMany: jest.fn(async () => [{ id: 'ann', dailyCallTarget: 40 }]) },
      outcome: {
        // The reached list (category IN …), the won list (one category), the callback list.
        findMany: jest.fn(async (a: { where: { category?: string | { in: string[] } } }) =>
          typeof a.where.category === 'object'
            ? [{ slug: 'call_back' }, { slug: 'closed_won' }]
            : a.where.category
              ? [{ slug: 'closed_won' }]
              : [{ slug: 'call_back' }],
        ),
      },
    } as unknown as PrismaService;
    return { service: new ProductivityService(prisma), groupBy };
  }

  it('counts each rep with the call cards’ rules, and a rep with no calls as zeros', async () => {
    const h = harness();
    const rows = await h.service.dailySummary();
    expect(rows).toEqual([
      { id: 'ann', name: 'Ann', callsMade: 7, connected: 5, callbacks: 2, deals: 1, dailyCallTarget: 40 },
      { id: 'bob', name: 'Bob', callsMade: 0, connected: 0, callbacks: 0, deals: 0, dailyCallTarget: 0 },
    ]);
  });

  it('counts calls started today, without missed inbound calls, and connected as answered', async () => {
    const h = harness();
    await h.service.dailySummary();
    const [all, connected] = h.groupBy.mock.calls.map(([a]) => JSON.stringify(a.where));
    expect(all).toContain('startTime');
    expect(all).not.toContain('endTime');
    expect(all).toContain('"leadId":{"not":null}');
    // Connected keeps the missed-inbound exclusion AND the answered rule.
    expect(connected).toContain('"leadId":{"not":null}');
    expect(connected).toContain('"endTime":{"not":null}');
    expect(connected).toContain('"outcome":{"in":["call_back","closed_won"]}');
    expect(connected).toContain('"durationSecs":{"gt":0}');
  });
});
