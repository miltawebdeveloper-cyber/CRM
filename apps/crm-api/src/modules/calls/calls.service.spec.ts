import { describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
import { Role } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { CallsService } from './calls.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OutcomesService } from '../outcomes/outcomes.service';
import { CommunicationsService } from '../communications/communications.service';
import { EndCallDto, UpdateFollowupDto } from './dto/call.dto';

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
  function harness(
    existingProcessed: { id: string } | null,
    followupState: {
      open?: { id: string } | null;
      last?: { seq: number } | null;
      /** Whether the chosen outcome books another callback. */
      schedulesCallback?: boolean;
    } = {},
  ) {
    // Typed with their argument so the assertions below can read what the
    // service actually asked Prisma for, not just how often it asked.
    const activityCreate = jest.fn((_args: { data: Record<string, unknown> }) => ({ __op: 'create' }));
    const activityUpdate = jest.fn((_args: { where: { id: string }; data: Record<string, unknown> }) => ({ __op: 'update' }));
    const activityFindFirst = jest.fn(async (_args: { where: Record<string, unknown> }) => existingProcessed);

    // The sequence asks two questions of `leadFollowup`: which rung is open
    // (`completedAt: null`) and which number is highest. One stub answers both,
    // keyed off the filter it was given.
    const followupCreate = jest.fn((_args: { data: Record<string, unknown> }) => ({ __op: 'fu.create' }));
    const followupUpdate = jest.fn((_args: { where: { id: string }; data: Record<string, unknown> }) => ({ __op: 'fu.update' }));
    const followupFindFirst = jest.fn(async (args: { where: Record<string, unknown> }) =>
      'completedAt' in args.where ? followupState.open ?? null : followupState.last ?? null,
    );

    const prisma = {
      lead: {
        // First call: the pre-transaction read. Second: the post-write read that
        // decides whether a callback notification goes out.
        findUnique: jest.fn(async () => ({ assignedToId: 'user-1', status: 'new', timezone: 'EST', callbackAt: null })),
        update: jest.fn(() => ({ __op: 'lead.update' })),
      },
      activity: { create: activityCreate, update: activityUpdate, findFirst: activityFindFirst },
      leadFollowup: { create: followupCreate, update: followupUpdate, findFirst: followupFindFirst },
      // The service passes an array of prepared operations; returning it keeps
      // positional results (`results[0]`) meaningful to the caller.
      $transaction: jest.fn(async (ops: unknown[]) => ops),
    } as unknown as PrismaService;

    const service = new CallsService(
      prisma,
      { notifyAndEmail: jest.fn() } as unknown as NotificationsService,
      {
        bySlug: jest.fn(async () => ({
          slug: 'not-interested',
          name: 'Not Interested',
          schedulesCallback: followupState.schedulesCallback ?? false,
        })),
      } as unknown as OutcomesService,
      {} as CommunicationsService,
    );

    const apply = (service as unknown as {
      applyDisposition: (leadId: string, dto: EndCallDto, userId: string, action: string) => Promise<unknown>;
    }).applyDisposition.bind(service);

    return { apply, activityCreate, activityUpdate, activityFindFirst, followupCreate, followupUpdate };
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

  // ── Follow-up sequence ──
  //
  // `Lead.callbackAt` is one column, so booking a second callback used to write
  // over the first and the lead's history read as a single follow-up. These
  // cover the rule that replaced it: one numbered rung per follow-up, closed
  // when worked, never rewritten by the next.
  describe('follow-up sequence', () => {
    // Far enough ahead to stay in the future whenever this runs, in any zone.
    const tomorrow = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();
    const booking = { outcome: 'call-back-later', callbackAt: tomorrow } as EndCallDto;

    /** What `leadFollowup.create` was asked to write. */
    const created = (h: ReturnType<typeof harness>) =>
      h.followupCreate.mock.calls[0][0].data as { seq: number; leadId: string; assignedToId: string | null };

    it('opens Follow-Up 1 the first time a callback is booked', async () => {
      const h = harness(null, { schedulesCallback: true, open: null, last: null });
      await h.apply('lead-1', booking, 'user-1', 'call_completed');

      expect(h.followupCreate).toHaveBeenCalledTimes(1);
      expect(created(h).seq).toBe(1);
      // Nothing was open, so nothing was closed.
      expect(h.followupUpdate).not.toHaveBeenCalled();
    });

    it('closes the open rung and opens the next when a callback is re-booked', async () => {
      const h = harness(null, { schedulesCallback: true, open: { id: 'fu-2' }, last: { seq: 2 } });
      await h.apply('lead-1', booking, 'user-1', 'call_completed');

      // Follow-Up 2 becomes history, carrying what was decided on it...
      expect(h.followupUpdate).toHaveBeenCalledTimes(1);
      const closed = h.followupUpdate.mock.calls[0][0];
      expect(closed.where.id).toBe('fu-2');
      expect(closed.data.outcome).toBe('call-back-later');
      expect(closed.data.completedById).toBe('user-1');
      expect(closed.data.completedAt).toBeInstanceOf(Date);
      // ...and Follow-Up 3 opens. Emphatically not 1 — the sequence continues
      // from where it got to, which is the whole point.
      expect(created(h).seq).toBe(3);
    });

    it('numbers from the highest rung used, not from the open one', async () => {
      // Nothing open (the last follow-up was worked and closed out), but three
      // rungs have been used. The next is 4.
      const h = harness(null, { schedulesCallback: true, open: null, last: { seq: 3 } });
      await h.apply('lead-1', booking, 'user-1', 'call_completed');

      expect(created(h).seq).toBe(4);
      expect(h.followupUpdate).not.toHaveBeenCalled();
    });

    it('closes the open rung without opening one when the outcome ends the lead', async () => {
      const h = harness(null, { schedulesCallback: false, open: { id: 'fu-1' }, last: { seq: 1 } });
      await h.apply('lead-1', dto, 'user-1', 'call_completed');

      expect(h.followupUpdate).toHaveBeenCalledTimes(1);
      expect(h.followupUpdate.mock.calls[0][0].data.completedAt).toBeInstanceOf(Date);
      expect(h.followupCreate).not.toHaveBeenCalled();
    });

    it('does not run past five — the ladder is a layout, not a limit', async () => {
      const h = harness(null, { schedulesCallback: true, open: { id: 'fu-5' }, last: { seq: 5 } });
      await h.apply('lead-1', booking, 'user-1', 'call_completed');

      // A customer asking to be rung again next week must not be refused because
      // the lead has "used up" its follow-ups.
      expect(created(h).seq).toBe(6);
    });

    it('moves the open rung rather than burning one when an outcome is corrected', async () => {
      const h = harness(null, { schedulesCallback: true, open: { id: 'fu-2' }, last: { seq: 2 } });
      await h.apply('lead-1', booking, 'user-1', 'outcome_updated');

      // Fixing a typo must not cost the lead a follow-up.
      expect(h.followupCreate).not.toHaveBeenCalled();
      const moved = h.followupUpdate.mock.calls[0][0];
      expect(moved.where.id).toBe('fu-2');
      expect(moved.data.scheduledAt).toBeInstanceOf(Date);
      // Still open — a correction reschedules, it doesn't complete.
      expect(moved.data.completedAt).toBeUndefined();
    });

    it('does not advance the sequence when a save is merely repeated', async () => {
      // `existingProcessed` set means the no-call save is a repeat. It already
      // advanced the ladder the first time; doing it again would push a lead
      // from Follow-Up 2 to Follow-Up 4 with nobody having called.
      const h = harness({ id: 'activity-1' }, { schedulesCallback: true, open: { id: 'fu-2' }, last: { seq: 2 } });
      await h.apply('lead-1', booking, 'user-1', 'lead_processed');

      expect(h.followupCreate).not.toHaveBeenCalled();
      expect(h.followupUpdate.mock.calls[0][0].where.id).toBe('fu-2');
    });
  });
});

/**
 * Completing and rescheduling a follow-up took a bare id and acted on it. The
 * routes have always been open to any authenticated user, so the only thing
 * standing between an employee and another rep's callback was the Follow-Ups
 * page being hidden from them — and that page is now open to everyone.
 */
describe('CallsService — follow-up mutations are scoped to the caller', () => {
  function harness(leadAssignedTo: string | null) {
    // `assertCanWorkLead` reads the lead through findFirst; everything else here
    // exists only so the happy path can run to completion.
    const prisma = {
      lead: {
        findFirst: jest.fn(async () => ({ id: 'lead-1', assignedToId: leadAssignedTo })),
        findUnique: jest.fn(async () => ({ id: 'lead-1', callbackAt: new Date(), timezone: 'EST' })),
        update: jest.fn(async () => ({ id: 'lead-1' })),
      },
      note: { findUnique: jest.fn(async () => ({ id: 'note-1', leadId: 'lead-1', nextFollowupDate: new Date() })) },
      activity: { create: jest.fn(async () => ({})) },
    } as unknown as PrismaService;

    return new CallsService(
      prisma,
      {} as NotificationsService,
      {} as OutcomesService,
      {} as CommunicationsService,
    );
  }

  const employee = { id: 'user-1', role: 'employee' as Role };
  const manager = { id: 'user-9', role: 'admin' as Role };

  it("refuses an employee completing another rep's callback", async () => {
    const service = harness('someone-else');
    await expect(service.completeFollowup('lead', 'lead-1', employee)).rejects.toThrow(ForbiddenException);
  });

  it("refuses an employee rescheduling another rep's callback", async () => {
    const service = harness('someone-else');
    await expect(
      service.updateFollowup('lead', 'lead-1', {} as UpdateFollowupDto, employee),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses it through the note route too — the lead behind it is what counts', async () => {
    const service = harness('someone-else');
    await expect(service.completeFollowup('note', 'note-1', employee)).rejects.toThrow(ForbiddenException);
  });

  it('allows an employee their own', async () => {
    const service = harness(employee.id);
    await expect(service.completeFollowup('lead', 'lead-1', employee)).resolves.toBeDefined();
  });

  it("allows a manager anyone's — working another rep's leads is the job", async () => {
    const service = harness('someone-else');
    await expect(service.completeFollowup('lead', 'lead-1', manager)).resolves.toBeDefined();
  });
});
