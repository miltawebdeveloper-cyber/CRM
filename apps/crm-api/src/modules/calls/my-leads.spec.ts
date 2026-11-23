import { describe, expect, it, jest } from '@jest/globals';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CallsService } from './calls.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OutcomesService } from '../outcomes/outcomes.service.js';
import { CommunicationsService } from '../communications/communications.service.js';

/**
 * The calling queue endpoint, and the one thing about it that is easy to get
 * backwards.
 *
 * A completed lead must LEAVE Your Queue — but it must not leave this response.
 * The panel keeps the lead the agent has just written up on screen until they
 * press Next, and it resolves that lead out of the agent's whole book. Drop
 * finished leads here and the card empties the instant Save succeeds, taking the
 * Saved receipt and the Next button with it.
 *
 * So the endpoint returns the book and LABELS it. The panel filters. These tests
 * are about the labelling, and about the label surviving as far as the wire.
 */
describe('CallsService.myLeads — queue status', () => {
  const HOUR = 60 * 60 * 1000;
  const ago = (ms: number) => new Date(Date.now() - ms);
  const ahead = (ms: number) => new Date(Date.now() + ms);

  interface LeadFixture {
    id: string;
    status?: string;
    callbackAt?: Date | null;
    callbackCompletedAt?: Date | null;
    zoomAt?: Date | null;
    /** The active assignment's stamp — the day the call is given for. None = assigned before history was kept. */
    assignedAt?: Date | null;
  }

  /** The rest of the world a queue read needs: the managers' setting and the outcome log. */
  interface World {
    mode?: 'automatic' | 'manual';
    /** Outcomes saved on a lead, as the outcome log holds them. Call Back is a reached outcome. */
    outcomes?: { leadId: string; when: Date; outcome: string }[];
  }

  /**
   * Enough Prisma to run `myLeads`. `calls` and `activity` are what the service
   * turns into `lastCallEndedAt` and `lastWorkedAt`, so they are how a test says
   * "this lead was worked today".
   */
  function harness(
    leads: LeadFixture[],
    worked: { leadId: string; when: Date }[] = [],
    calls: { leadId: string; startTime: Date; endTime: Date | null }[] = [],
    world: World = {},
  ) {
    const prisma = {
      lead: {
        findMany: jest.fn(async () =>
          leads.map((l, i) => ({
            id: l.id,
            importSeq: i + 1,
            status: l.status ?? 'new',
            timezone: 'EST',
            callbackAt: l.callbackAt ?? null,
            callbackCompletedAt: l.callbackCompletedAt ?? null,
            zoomMeetings: l.zoomAt ? [{ id: `z-${l.id}`, scheduledAt: l.zoomAt, status: 'scheduled' }] : [],
            assignments: l.assignedAt ? [{ assignedAt: l.assignedAt }] : [],
          })),
        ),
      },
      call: {
        findMany: jest.fn(async () =>
          calls.map((c) => ({ leadId: c.leadId, startTime: c.startTime, endTime: c.endTime, outcome: null })),
        ),
      },
      activity: {
        // Two reads: today's saves (the receipt card), and the outcome log since
        // the calls were assigned (asks by outcome — "was anyone reached?").
        findMany: jest.fn(async (args: { where?: { newValue?: unknown } }) =>
          args.where?.newValue
            ? (world.outcomes ?? []).map((o) => ({ leadId: o.leadId, createdAt: o.when, newValue: o.outcome }))
            : worked.map((w) => ({ leadId: w.leadId, createdAt: w.when })),
        ),
      },
      appSetting: { findUnique: jest.fn(async () => (world.mode ? { key: 'calling:pending-mode', value: { mode: world.mode } } : null)) },
      outcome: { findMany: jest.fn(async () => [{ slug: 'call_back' }]) },
      // The day each lead was assigned for, by a person.
      assignment: {
        findMany: jest.fn(async () => leads.filter((l) => l.assignedAt).map((l) => ({ leadId: l.id, assignedAt: l.assignedAt }))),
      },
    } as unknown as PrismaService;

    const service = new CallsService(
      prisma,
      {} as NotificationsService,
      {} as OutcomesService,
      {} as CommunicationsService,
    );
    return service.myLeads('caller-1');
  }

  /** The status the endpoint gave each lead, keyed by id. */
  const statuses = async (...args: Parameters<typeof harness>) => {
    const rows = await harness(...args);
    return Object.fromEntries(rows.map((r) => [r.id, r.queueStatus]));
  };

  it('labels an untouched lead a new call', async () => {
    expect(await statuses([{ id: 'a' }])).toEqual({ a: 'new' });
  });

  it('labels a lead with a live call in progress', async () => {
    const s = await statuses([{ id: 'a' }], [], [{ leadId: 'a', startTime: ago(2 * 60 * 1000), endTime: null }]);
    expect(s.a).toBe('in_progress');
  });

  it('labels a lead completed once its call has ended', async () => {
    const s = await statuses([{ id: 'a' }], [], [{ leadId: 'a', startTime: ago(HOUR), endTime: ago(HOUR - 60_000) }]);
    expect(s.a).toBe('completed');
  });

  it('labels a lead completed when it was saved with no call placed', async () => {
    // Lead-processing mode writes no call row, which is how a finished lead used
    // to come back through every check reading "New Call".
    const s = await statuses([{ id: 'a' }], [{ leadId: 'a', when: ago(HOUR) }]);
    expect(s.a).toBe('completed');
  });

  it('still RETURNS the completed lead — the panel needs it on the card', async () => {
    // The trap this whole endpoint design avoids. Filtering here would empty the
    // card the moment Save succeeded.
    const rows = await harness([{ id: 'a' }], [{ leadId: 'a', when: ago(HOUR) }]);
    expect(rows.map((r) => r.id)).toEqual(['a']);
    expect(rows[0].queueStatus).toBe('completed');
  });

  it('keeps a worked lead completed while its callback is still ahead', async () => {
    // Rung this morning, callback agreed for two hours' time: nothing to do
    // right now, so the lead is out of the queue rather than sitting in it.
    const s = await statuses([{ id: 'a', callbackAt: ahead(2 * HOUR) }], [{ leadId: 'a', when: ago(HOUR) }]);
    expect(s.a).toBe('completed');
  });

  it('re-opens a worked lead the moment its callback falls due', async () => {
    // The customer is expecting the phone to ring, so the lead is back on the
    // list — "completed" is per pass, not for the day.
    const s = await statuses([{ id: 'a', callbackAt: ago(5 * 60 * 1000) }], [{ leadId: 'a', when: ago(HOUR) }]);
    expect(s.a).toBe('new');
  });

  it('leaves an answered callback completed', async () => {
    const s = await statuses(
      [{ id: 'a', callbackAt: ago(HOUR), callbackCompletedAt: ago(30 * 60 * 1000) }],
      [{ leadId: 'a', when: ago(30 * 60 * 1000) }],
    );
    expect(s.a).toBe('completed');
  });

  it('re-opens for a Zoom meeting whose time has come', async () => {
    const s = await statuses([{ id: 'a', zoomAt: ago(5 * 60 * 1000) }], [{ leadId: 'a', when: ago(HOUR) }]);
    expect(s.a).toBe('new');
  });

  it('treats closed and rejected leads as completed however they got there', async () => {
    // A manager may have closed the lead from Lead Management, with no call on
    // it at all. Nothing further is owed, so it belongs in nobody's queue.
    const s = await statuses([{ id: 'a', status: 'closed' }, { id: 'b', status: 'rejected' }]);
    expect(s).toEqual({ a: 'completed', b: 'completed' });
  });

  it('labels each lead independently', async () => {
    const s = await statuses(
      [{ id: 'a' }, { id: 'b' }, { id: 'c', status: 'closed' }],
      [{ leadId: 'b', when: ago(HOUR) }],
    );
    expect(s).toEqual({ a: 'new', b: 'completed', c: 'completed' });
  });

  it('sorts finished leads to the bottom of the book it returns', async () => {
    // The panel filters them out, so this decides the order of a list they are
    // not in — but anything reading the raw book still wants the work first.
    const rows = await harness([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [{ leadId: 'a', when: ago(HOUR) }]);
    expect(rows.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('asks the database to exclude only leads closed or rejected before today', async () => {
    // QUEUE_MAX caps the fetch itself, ordered by import sequence. Without this
    // filter a caller's entire closed-lead history — accumulated over months —
    // competes with their genuinely active leads for that cap, and old leads
    // imported early can silently crowd out active ones imported later. A lead
    // closed TODAY must still come through (the receipt card needs it, see the
    // tests above), so the exclusion is scoped to closedAt < start of today,
    // not to status alone.
    const findMany = jest.fn(async (_args: { where: Record<string, unknown> }) => []);
    const prisma = {
      lead: { findMany },
      call: { findMany: jest.fn(async () => []) },
      activity: { findMany: jest.fn(async () => []) },
      appSetting: { findUnique: jest.fn(async () => null) },
      outcome: { findMany: jest.fn(async () => []) },
      assignment: { findMany: jest.fn(async () => []) },
    } as unknown as PrismaService;
    const service = new CallsService(prisma, {} as NotificationsService, {} as OutcomesService, {} as CommunicationsService);

    await service.myLeads('caller-1');

    const where = findMany.mock.calls[0]![0].where;
    expect(where.assignedToId).toBe('caller-1');
    expect(where.NOT).toEqual({
      status: { in: ['closed', 'rejected'] },
      closedAt: { lt: expect.any(Date) },
    });
  });
});

/**
 * Your Queue is the rep's open assignments: today's calls not yet completed.
 * A completed call (the customer reached since it was assigned) leaves for good;
 * a call whose day passed unfinished is pending — on the queue in Automatic,
 * with the managers in Manual; a call given for a later day waits for it.
 */
describe('CallsService.myLeads — open assignments', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const run = (leads: Array<Record<string, unknown>>, world: { mode?: 'automatic' | 'manual'; outcomes?: { leadId: string; when: Date; outcome: string }[] } = {}) => {
    const prisma = {
      lead: {
        findMany: jest.fn(async () =>
          leads.map((l, i) => ({
            importSeq: i + 1, status: 'contacted', timezone: 'EST', callbackAt: null, callbackCompletedAt: null, zoomMeetings: [],
            ...l,
            assignments: l.assignedAt ? [{ assignedAt: l.assignedAt }] : [],
          })),
        ),
      },
      call: { findMany: jest.fn(async () => []) },
      activity: {
        findMany: jest.fn(async (args: { where?: { newValue?: unknown } }) =>
          args.where?.newValue ? (world.outcomes ?? []).map((o) => ({ leadId: o.leadId, createdAt: o.when, newValue: o.outcome })) : [],
        ),
      },
      appSetting: { findUnique: jest.fn(async () => (world.mode ? { value: { mode: world.mode } } : null)) },
      outcome: { findMany: jest.fn(async () => [{ slug: 'call_back' }]) },
      assignment: {
        findMany: jest.fn(async () => leads.filter((l) => l.assignedAt).map((l) => ({ leadId: l.id, assignedAt: l.assignedAt }))),
      },
    } as unknown as PrismaService;
    return new CallsService(prisma, {} as NotificationsService, {} as OutcomesService, {} as CommunicationsService).myLeads('caller-1');
  };
  const ids = async (...args: Parameters<typeof run>) => (await run(...args)).map((r) => r.id);
  const now = () => new Date();
  const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

  it('keeps today’s call, and drops one completed on an earlier day', async () => {
    const got = await ids(
      [
        { id: 'today', assignedAt: now() },
        { id: 'done', assignedAt: daysAgo(3) },
      ],
      { outcomes: [{ leadId: 'done', when: daysAgo(2), outcome: 'call_back' }] },
    );
    expect(got).toEqual(['today']);
  });

  it('keeps a call that rang out — No Answer doesn’t complete it', async () => {
    const got = await ids([{ id: 'rang', assignedAt: daysAgo(2) }], { outcomes: [{ leadId: 'rang', when: daysAgo(2), outcome: 'no_answer' }] });
    expect(got).toEqual(['rang']);
  });

  it('shows a pending call in Automatic and holds it back in Manual', async () => {
    const pending = [{ id: 'p', assignedAt: daysAgo(2) }];
    expect(await ids(pending, { mode: 'automatic' })).toEqual(['p']);
    expect(await ids(pending, { mode: 'manual' })).toEqual([]);
    // Automatic is what a CRM that never chose gets.
    expect(await ids(pending)).toEqual(['p']);
  });

  it('waits for the day a call was given for', async () => {
    expect(await ids([{ id: 'later', assignedAt: new Date(Date.now() + 3 * DAY) }])).toEqual([]);
  });

  it('keeps an appointment on the queue even when the call itself was completed', async () => {
    const got = await ids(
      [{ id: 'cb', assignedAt: daysAgo(2), callbackAt: new Date(Date.now() + DAY) }],
      { outcomes: [{ leadId: 'cb', when: daysAgo(2), outcome: 'call_back' }] },
    );
    expect(got).toEqual(['cb']);
  });

  it('lists assigned calls date-wise: the oldest assignment day first, import order within a day', async () => {
    const rows = await run([
      { id: 'a', assignedAt: now() },
      { id: 'b', assignedAt: daysAgo(2) },
      { id: 'c', assignedAt: now() },
      { id: 'd', assignedAt: daysAgo(1) },
    ]);
    expect(rows.map((r) => r.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(rows.every((r) => typeof r.assignedOn === 'string')).toBe(true);
  });
});
