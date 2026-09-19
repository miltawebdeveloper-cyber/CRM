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
  ) {
    const prisma = {
      lead: {
        findMany: jest.fn(async () =>
          leads.map((l, i) => ({
            id: l.id,
            importSeq: i + 1,
            status: l.status ?? 'new',
            callbackAt: l.callbackAt ?? null,
            callbackCompletedAt: l.callbackCompletedAt ?? null,
            zoomMeetings: l.zoomAt ? [{ id: `z-${l.id}`, scheduledAt: l.zoomAt, status: 'scheduled' }] : [],
          })),
        ),
      },
      call: {
        findMany: jest.fn(async () =>
          calls.map((c) => ({ leadId: c.leadId, startTime: c.startTime, endTime: c.endTime, outcome: null })),
        ),
      },
      activity: {
        findMany: jest.fn(async () => worked.map((w) => ({ leadId: w.leadId, createdAt: w.when }))),
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
});
