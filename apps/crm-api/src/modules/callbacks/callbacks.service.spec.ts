import { describe, expect, it, jest } from '@jest/globals';
import { NotificationType } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { CallbacksService } from './callbacks.service.js';

/**
 * What the reminder engine is allowed to put in somebody's inbox.
 *
 * The rule these pin down is a narrow one and easy to regress: every callback
 * milestone raises a CRM notification, and exactly one of them — the missed
 * alert — also sends mail. Booking a callback, the day-before nudge and the
 * "due now" prompt must reach the bell and stop there.
 *
 * The email half of that is enforced in NotificationsService (see the sibling
 * spec); what is tested here is which milestone fires at all, that completing
 * the call means none of them do, and that a missed alert is claimed once even
 * if the scan runs twice over the same lead.
 */
describe('CallbacksService — reminder engine', () => {
  type LeadRow = {
    id: string;
    leadId: string;
    businessName: string;
    contactName: string | null;
    phone: string;
    timezone: string | null;
    callbackAt: Date;
    callbackReminderDayBeforeAt: Date | null;
    callbackReminderDueAt: Date | null;
    callbackReminderMissedAt: Date | null;
    assignedToId: string | null;
    assignedTo: { email: string | null; name: string } | null;
  };

  /**
   * `claims` is how many times the atomic missed-claim is allowed to succeed —
   * one per lead in real life. Setting it to 0 stands in for another run having
   * got there first.
   */
  function harness(leads: LeadRow[], { claims = leads.length } = {}) {
    let left = claims;
    const updateMany = jest.fn(
      async (_args: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({
        count: left-- > 0 ? 1 : 0,
      }),
    );
    const update = jest.fn(async () => ({}));
    const notifyAndEmail = jest.fn(
      async (
        _userId: string | null,
        _type: NotificationType,
        _title: string,
        _body: string,
        _opts?: { email?: string | null; alsoManagers?: boolean },
      ) => undefined,
    );

    const prisma = {
      lead: { findMany: jest.fn(async () => leads), updateMany, update },
    } as unknown as PrismaService;

    const service = new CallbacksService(prisma, { notifyAndEmail } as unknown as NotificationsService);
    return { service, notifyAndEmail, updateMany, update };
  }

  const lead = (callbackAt: Date, over: Partial<LeadRow> = {}): LeadRow => ({
    id: 'lead-1',
    leadId: 'L-2026-1',
    businessName: 'Acme Books',
    contactName: 'Dana Reed',
    phone: '+1 555 0100',
    timezone: 'EST',
    callbackAt,
    callbackReminderDayBeforeAt: null,
    callbackReminderDueAt: null,
    callbackReminderMissedAt: null,
    assignedToId: 'user-1',
    assignedTo: { email: 'rep@example.com', name: 'Rep' },
    ...over,
  });

  /** The instant `wall` reads as in New York. August, so daylight time: −04:00. */
  const est = (wall: string) => new Date(`${wall}-04:00`);

  /** The single type the engine fired on this run. */
  const firedType = (notifyAndEmail: { mock: { calls: unknown[][] } }) =>
    notifyAndEmail.mock.calls[0]?.[1] as NotificationType | undefined;

  it('raises the day-before milestone, and it is not the missed one', async () => {
    // Booked for tomorrow 10:00; it is 24h out.
    const { service, notifyAndEmail } = harness([lead(est('2026-08-13T10:00'))]);
    await service.runReminders(est('2026-08-12T10:00'));

    expect(notifyAndEmail).toHaveBeenCalledTimes(1);
    expect(firedType(notifyAndEmail)).toBe(NotificationType.callback_reminder);
  });

  it('raises the due milestone at the scheduled time, and it is not the missed one', async () => {
    // Due at 10:00; it is 10:05 — inside the hour's grace.
    const { service, notifyAndEmail } = harness([lead(est('2026-08-12T10:00'))]);
    await service.runReminders(est('2026-08-12T10:05'));

    expect(notifyAndEmail).toHaveBeenCalledTimes(1);
    expect(firedType(notifyAndEmail)).toBe(NotificationType.callback_due);
  });

  it('fires the missed alert once the hour of grace has run out', async () => {
    // Due at 10:00, still open at 11:30.
    const { service, notifyAndEmail } = harness([lead(est('2026-08-12T10:00'))]);
    const { fired } = await service.runReminders(est('2026-08-12T11:30'));

    expect(fired).toBe(1);
    expect(firedType(notifyAndEmail)).toBe(NotificationType.callback_missed);
  });

  it('says Missed Callback, and carries the lead, agent, schedule and zone', async () => {
    const { service, notifyAndEmail } = harness([lead(est('2026-08-12T10:00'))]);
    await service.runReminders(est('2026-08-12T11:30'));

    const [, , title, body] = notifyAndEmail.mock.calls[0];
    expect(title).toBe('Missed Callback');
    expect(body).toContain('Callback Status: Missed');
    expect(body).toContain('L-2026-1');
    expect(body).toContain('Acme Books');
    expect(body).toContain('Dana Reed');
    expect(body).toContain('+1 555 0100');
    expect(body).toContain('Assigned Agent: Rep');
    // The schedule, on the customer's clock, and the zone named in full.
    expect(body).toContain('Scheduled Callback: Aug 12');
    expect(body).toContain('10:00 AM');
    expect(body).toContain('Lead Time Zone: EST (Eastern Standard Time)');
  });

  it('never fires for a callback already marked missed', async () => {
    // Same overdue appointment, but the stamp is on it from an earlier scan.
    const { service, notifyAndEmail } = harness([
      lead(est('2026-08-12T10:00'), { callbackReminderMissedAt: est('2026-08-12T11:00') }),
    ]);
    const { fired } = await service.runReminders(est('2026-08-12T13:00'));

    expect(fired).toBe(0);
    expect(notifyAndEmail).not.toHaveBeenCalled();
  });

  it('sends nothing when another run claimed the same missed callback first', async () => {
    // The row was read as unclaimed, but the conditional update matched nothing:
    // an overlapping scan won it in between. This one must stay silent.
    const { service, notifyAndEmail, updateMany } = harness([lead(est('2026-08-12T10:00'))], { claims: 0 });
    const { fired } = await service.runReminders(est('2026-08-12T11:30'));

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(fired).toBe(0);
    expect(notifyAndEmail).not.toHaveBeenCalled();
  });

  it('claims the alert before sending it, guarded on the stamp still being empty', async () => {
    const { service, updateMany } = harness([lead(est('2026-08-12T10:00'))]);
    await service.runReminders(est('2026-08-12T11:30'));

    const args = updateMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ id: 'lead-1', callbackReminderMissedAt: null });
    expect(args.data.callbackReminderMissedAt).toBeInstanceOf(Date);
  });

  it('has nothing to say about a completed callback', async () => {
    // Completing the call takes the lead out of the scan entirely — the query
    // filters on callbackCompletedAt being null, so an empty set is the shape a
    // completed callback arrives in.
    const { service, notifyAndEmail } = harness([]);
    const { fired } = await service.runReminders(est('2026-08-12T11:30'));

    expect(fired).toBe(0);
    expect(notifyAndEmail).not.toHaveBeenCalled();
  });
});
