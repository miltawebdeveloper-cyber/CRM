import { describe, expect, it, jest } from '@jest/globals';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { CallbackRolloverService } from './callback-rollover.service.js';
import { formatInZone } from '../../common/timezone.js';

/**
 * A scheduled call that the day ended without has to move on its own — that is
 * the whole feature. These pin the three things that make it trustworthy:
 * it moves only after the day has ended WHERE THE CUSTOMER IS, it lands on a
 * working day at the same time, and running it twice does nothing the second
 * time.
 */
describe('CallbackRolloverService', () => {
  type LeadRow = {
    id: string;
    leadId: string;
    businessName: string;
    timezone: string | null;
    callbackAt: Date;
    nextFollowUpDate: Date | null;
    assignedToId: string | null;
    assignedTo: { email: string | null; name: string } | null;
  };

  function harness(leads: LeadRow[]) {
    const leadUpdate = jest.fn((_args: { where: { id: string }; data: Record<string, unknown> }) => ({ __op: 'lead.update' }));
    const followupUpdate = jest.fn((_args: { where: { id: string }; data: Record<string, unknown> }) => ({ __op: 'fu.update' }));
    const activityCreate = jest.fn((_args: { data: Record<string, unknown> }) => ({ __op: 'activity.create' }));
    const notifyAndEmail = jest.fn(async () => undefined);

    const prisma = {
      lead: { findMany: jest.fn(async () => leads), update: leadUpdate },
      // One open rung on the sequence, so the follow-up move is exercised too.
      leadFollowup: { findFirst: jest.fn(async () => ({ id: 'fu-1', seq: 2 })), update: followupUpdate },
      activity: { create: activityCreate },
      user: { findFirst: jest.fn(async () => ({ id: 'admin-1' })) },
      $transaction: jest.fn(async (ops: unknown[]) => ops),
    } as unknown as PrismaService;

    const service = new CallbackRolloverService(prisma, { notifyAndEmail } as unknown as NotificationsService);
    return { service, leadUpdate, followupUpdate, activityCreate, notifyAndEmail };
  }

  const lead = (callbackAt: Date, timezone: string | null = 'EST'): LeadRow => ({
    id: 'lead-1',
    leadId: 'L-2026-1',
    businessName: 'Acme Books',
    timezone,
    callbackAt,
    nextFollowUpDate: callbackAt,
    assignedToId: 'user-1',
    assignedTo: { email: 'rep@example.com', name: 'Rep' },
  });

  /**
   * The instant `wall` reads as in New York. Every fixture below is in August,
   * which is daylight time there — hence −04:00, not −05:00. The offset is
   * written out rather than derived so these tests describe a fixed instant and
   * can't drift with whatever the code under test believes about zones.
   */
  const est = (wall: string) => new Date(`${wall}-04:00`);

  it('moves a call left pending overnight to the next day, same time', async () => {
    // Booked Tue 2026-08-11 10:00 EST, still open on Wed morning.
    const { service, leadUpdate, followupUpdate } = harness([lead(est('2026-08-11T10:00'))]);
    const { moved } = await service.rollOverPending(est('2026-08-12T07:00'));

    expect(moved).toBe(1);
    const to = leadUpdate.mock.calls[0][0].data.callbackAt as Date;
    // Wednesday the 12th, still 10:00 on the customer's clock.
    expect(formatInZone(to, 'EST' as never)).toContain('Aug 12');
    expect(formatInZone(to, 'EST' as never)).toContain('10:00');
    // Lead Management's own column moves with it, and so does the open rung.
    expect(leadUpdate.mock.calls[0][0].data.nextFollowUpDate).toEqual(to);
    expect(followupUpdate.mock.calls[0][0].data.scheduledAt).toEqual(to);
  });

  it('skips the weekend — a Friday miss lands on Monday', async () => {
    // Friday 2026-08-14 15:30, swept on Saturday.
    const { service, leadUpdate } = harness([lead(est('2026-08-14T15:30'))]);
    await service.rollOverPending(est('2026-08-15T06:00'));

    const to = leadUpdate.mock.calls[0][0].data.callbackAt as Date;
    expect(formatInZone(to, 'EST' as never)).toContain('Aug 17'); // Monday
    expect(formatInZone(to, 'EST' as never)).toContain('03:30 PM');
  });

  it('leaves today alone — a call is not "not completed at the end of the day" at lunchtime', async () => {
    // Due at 09:00 today; it is 13:00 today. Overdue, but the day is not over.
    const { service, leadUpdate, notifyAndEmail } = harness([lead(est('2026-08-12T09:00'))]);
    const { moved } = await service.rollOverPending(est('2026-08-12T13:00'));

    expect(moved).toBe(0);
    expect(leadUpdate).not.toHaveBeenCalled();
    expect(notifyAndEmail).not.toHaveBeenCalled();
  });

  it('judges the day in the CUSTOMER\'s zone, not the server\'s', async () => {
    // 21:00 Monday in Los Angeles is already Tuesday 00:00 in New York. A
    // server-side "is it a new day?" would move this; the customer's Monday is
    // still running, so the call has not been missed.
    const { service, leadUpdate } = harness([lead(new Date('2026-08-10T09:00-07:00'), 'PST')]);
    const { moved } = await service.rollOverPending(new Date('2026-08-11T04:00Z')); // 21:00 PDT Mon

    expect(moved).toBe(0);
    expect(leadUpdate).not.toHaveBeenCalled();
  });

  it('catches up after an outage without booking into a day that is also over', async () => {
    // Missed last Tuesday; nothing ran until the following Monday.
    const { service, leadUpdate } = harness([lead(est('2026-08-04T11:00'))]);
    await service.rollOverPending(est('2026-08-10T09:00'));

    const to = leadUpdate.mock.calls[0][0].data.callbackAt as Date;
    expect(to.getTime()).toBeGreaterThan(est('2026-08-10T09:00').getTime());
    expect(formatInZone(to, 'EST' as never)).toContain('Aug 10'); // today, 11:00, still ahead
  });

  it('clears the reminder and silence stamps, so the new date reminds afresh', async () => {
    const { service, leadUpdate } = harness([lead(est('2026-08-11T10:00'))]);
    await service.rollOverPending(est('2026-08-12T07:00'));

    expect(leadUpdate.mock.calls[0][0].data).toMatchObject({
      callbackReminderDayBeforeAt: null,
      callbackReminderDueAt: null,
      callbackReminderMissedAt: null,
      callbackSnoozedUntil: null,
      callbackDismissedAt: null,
    });
  });

  it('records the move and tells the agent whose call it was', async () => {
    const { service, activityCreate, notifyAndEmail } = harness([lead(est('2026-08-11T10:00'))]);
    await service.rollOverPending(est('2026-08-12T07:00'));

    const activity = activityCreate.mock.calls[0][0].data;
    expect(activity.action).toBe('callback_rolled_over');
    // The agent keeps the call: it is their pending work that moved.
    expect(activity.userId).toBe('user-1');
    expect(activity.assignedToId).toBe('user-1');
    expect(notifyAndEmail).toHaveBeenCalled();
  });

  it('is idempotent — a second sweep finds the new date still ahead', async () => {
    const row = lead(est('2026-08-11T10:00'));
    const { service, leadUpdate } = harness([row]);
    const now = est('2026-08-12T07:00');
    await service.rollOverPending(now);

    // Feed the moved date back in, as the next hourly sweep would read it.
    row.callbackAt = leadUpdate.mock.calls[0][0].data.callbackAt as Date;
    const second = harness([row]);
    const { moved } = await second.service.rollOverPending(now);
    expect(moved).toBe(0);
  });
});
