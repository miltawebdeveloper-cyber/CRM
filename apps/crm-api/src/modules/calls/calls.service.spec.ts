import { describe, expect, it, jest } from '@jest/globals';
import { PrismaService } from '../../prisma/prisma.service';
import { CallsService } from './calls.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OutcomesService } from '../outcomes/outcomes.service';
import { CommunicationsService } from '../communications/communications.service';
import { EndCallDto } from './dto/call.dto';

/**
 * A lead worked WITHOUT a call has no `calls` row behind it — the activity is
 * the line Calls Made shows. So unlike a dialled call, which every later write
 * updates in place, a repeated no-call disposition used to add a second line to
 * the log: another call in the totals, another item in the agent's day.
 *
 * Repeats are ordinary. Saving is two requests (disposition, then note), and a
 * failed note leaves the panel inviting the agent to press Save again.
 */
describe('CallsService — no-call dispositions do not duplicate in Calls Made', () => {
  /**
   * Just enough Prisma for `applyDisposition`. Records which activity write it
   * chose, which is the whole question.
   */
  function harness(existingProcessed: { id: string } | null) {
    // Typed with their argument so the assertions below can read what the
    // service actually asked Prisma for, not just how often it asked.
    const activityCreate = jest.fn((_args: { data: Record<string, unknown> }) => ({ __op: 'create' }));
    const activityUpdate = jest.fn((_args: { where: { id: string }; data: Record<string, unknown> }) => ({ __op: 'update' }));
    const activityFindFirst = jest.fn(async (_args: { where: Record<string, unknown> }) => existingProcessed);

    const prisma = {
      lead: {
        // First call: the pre-transaction read. Second: the post-write read that
        // decides whether a callback notification goes out.
        findUnique: jest.fn(async () => ({ assignedToId: 'user-1', status: 'new', timezone: 'EST', callbackAt: null })),
        update: jest.fn(() => ({ __op: 'lead.update' })),
      },
      activity: { create: activityCreate, update: activityUpdate, findFirst: activityFindFirst },
      // The service passes an array of prepared operations; returning it keeps
      // positional results (`results[0]`) meaningful to the caller.
      $transaction: jest.fn(async (ops: unknown[]) => ops),
    } as unknown as PrismaService;

    const service = new CallsService(
      prisma,
      { notifyAndEmail: jest.fn() } as unknown as NotificationsService,
      { bySlug: jest.fn(async () => ({ slug: 'not-interested', name: 'Not Interested', schedulesCallback: false })) } as unknown as OutcomesService,
      {} as CommunicationsService,
    );

    const apply = (service as unknown as {
      applyDisposition: (leadId: string, dto: EndCallDto, userId: string, action: string) => Promise<unknown>;
    }).applyDisposition.bind(service);

    return { apply, activityCreate, activityUpdate, activityFindFirst };
  }

  const dto = { outcome: 'not-interested', durationSecs: 42 } as EndCallDto;

  it('writes one row the first time a lead is processed', async () => {
    const h = harness(null);
    await h.apply('lead-1', dto, 'user-1', 'lead_processed');

    expect(h.activityCreate).toHaveBeenCalledTimes(1);
    expect(h.activityUpdate).not.toHaveBeenCalled();
  });

  it('updates that row instead of adding a second when the save is repeated', async () => {
    const h = harness({ id: 'activity-1' });
    await h.apply('lead-1', { ...dto, outcome: 'call-back-later', durationSecs: 90 } as EndCallDto, 'user-1', 'lead_processed');

    expect(h.activityCreate).not.toHaveBeenCalled();
    expect(h.activityUpdate).toHaveBeenCalledTimes(1);
    // The surviving row carries the LATEST values, not a half-updated mix: a
    // retry that corrected the outcome must not leave the first one showing.
    const arg = h.activityUpdate.mock.calls[0][0];
    expect(arg.where.id).toBe('activity-1');
    expect(arg.data.newValue).toBe('call-back-later');
    expect(arg.data.callStatus).toBe('call-back-later');
    expect(arg.data.durationSecs).toBe(90);
  });

  it('scopes the repeat check to this lead, this agent, and a recent window', async () => {
    const h = harness(null);
    await h.apply('lead-1', dto, 'user-1', 'lead_processed');

    const where = h.activityFindFirst.mock.calls[0][0].where;
    expect(where.leadId).toBe('lead-1');
    expect(where.userId).toBe('user-1');
    expect(where.action).toBe('lead_processed');
    // A genuine second contact days later is a real row, so the lookup must be
    // time-bounded rather than "has this lead ever been processed".
    expect((where.createdAt as { gte: Date }).gte).toBeInstanceOf(Date);
  });

  it('leaves the dialled-call path alone — it updates one calls row already', async () => {
    const h = harness({ id: 'activity-1' });
    await h.apply('lead-1', dto, 'user-1', 'call_completed');

    // No lookup, no update: a second `call_completed` activity is a log entry,
    // not a second line in Calls Made, and collapsing it would hide a real
    // re-disposition of the same call.
    expect(h.activityFindFirst).not.toHaveBeenCalled();
    expect(h.activityCreate).toHaveBeenCalledTimes(1);
    expect(h.activityUpdate).not.toHaveBeenCalled();
  });
});
