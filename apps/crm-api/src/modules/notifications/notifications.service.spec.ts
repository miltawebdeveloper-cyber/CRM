import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NotificationType } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MailService } from '../mail/mail.service.js';
import { NotificationsService } from './notifications.service.js';

/**
 * The line between "the CRM tells you" and "your inbox tells you".
 *
 * Every callback milestone raises the in-app notification. Only a missed
 * callback also sends mail — and that rule is a property of the event, not a
 * setting, so a stored `callback_reminder: true` from before the change must not
 * bring the old flood of scheduling emails back.
 */
describe('NotificationsService — which callback events email', () => {
  function harness(storedTypes?: Record<string, boolean>) {
    const notificationCreate = jest.fn(async () => ({}));
    const send = jest.fn(async (_msg: { to: string[]; subject: string; html: string; text?: string }) => undefined);

    const prisma = {
      notification: { create: notificationCreate },
      user: { findMany: jest.fn(async () => []) },
      appSetting: {
        findUnique: jest.fn(async () => ({
          key: 'callbacks:email_settings',
          value: { recipients: ['manager@example.com'], ...(storedTypes ? { types: storedTypes } : {}) },
        })),
      },
    } as unknown as PrismaService;

    const service = new NotificationsService(prisma, { send } as unknown as MailService);
    return { service, notificationCreate, send };
  }

  const fire = (service: NotificationsService, type: NotificationType) =>
    service.notifyAndEmail('user-1', type, 'Title', 'Body', { email: 'rep@example.com' });

  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('emails a missed callback', async () => {
    await fire(h.service, NotificationType.callback_missed);
    expect(h.send).toHaveBeenCalledTimes(1);
    // The assigned rep and the configured distribution list both get it.
    expect(h.send.mock.calls[0][0].to).toEqual(
      expect.arrayContaining(['rep@example.com', 'manager@example.com']),
    );
  });

  it('does not email a scheduled or day-before callback', async () => {
    await fire(h.service, NotificationType.callback_reminder);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('does not email a callback merely becoming due', async () => {
    await fire(h.service, NotificationType.callback_due);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('still raises the CRM notification for the events it does not email', async () => {
    await fire(h.service, NotificationType.callback_reminder);
    await fire(h.service, NotificationType.callback_due);
    expect(h.notificationCreate).toHaveBeenCalledTimes(2);
  });

  it('ignores a stored toggle that would re-enable scheduling emails', async () => {
    // A workspace that saved these settings before the change carries
    // `callback_reminder: true`. It must not resurrect the old behaviour.
    const stored = harness({ callback_reminder: true, callback_due: true, callback_missed: true });
    await fire(stored.service, NotificationType.callback_reminder);
    expect(stored.send).not.toHaveBeenCalled();
  });

  it('still lets an admin switch the missed-callback email off', async () => {
    const off = harness({ callback_reminder: true, callback_due: true, callback_missed: false });
    await fire(off.service, NotificationType.callback_missed);
    expect(off.send).not.toHaveBeenCalled();
    // The CRM notification is not the admin's to disable — it still lands.
    expect(off.notificationCreate).toHaveBeenCalledTimes(1);
  });

  it('leaves non-callback emails alone', async () => {
    // Zoom keeps its own reminders. The rule here is about callbacks only, and
    // narrowing it must not quietly silence another module's mail.
    await fire(h.service, NotificationType.zoom_reminder);
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

/**
 * The bell lists what is still unread, asked of the database — not picked out
 * of the newest 100 in the browser, where an older unread one behind a hundred
 * read ones would never show under a badge still counting it.
 */
describe('NotificationsService — listing', () => {
  function harness() {
    const findMany = jest.fn(async (_args: { where: Record<string, unknown>; take?: number }) => []);
    const prisma = { notification: { findMany } } as unknown as PrismaService;
    return { service: new NotificationsService(prisma, {} as MailService), findMany };
  }

  it('lists only unread notifications for the bell', async () => {
    const { service, findMany } = harness();
    await service.list('user-1', { unread: true });
    expect(findMany.mock.calls[0][0].where).toEqual({ userId: 'user-1', isRead: false });
  });

  it('lists read and unread together for the Notifications page', async () => {
    const { service, findMany } = harness();
    await service.list('user-1');
    expect(findMany.mock.calls[0][0].where).toEqual({ userId: 'user-1' });
  });

  it('only ever lists the signed-in person’s own notifications', async () => {
    const { service, findMany } = harness();
    await service.list('user-2', { unread: false });
    expect(findMany.mock.calls[0][0].where).toEqual({ userId: 'user-2' });
    expect(findMany.mock.calls[0][0].take).toBe(100);
  });
});
