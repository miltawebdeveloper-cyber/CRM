import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NotificationType } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from './notifications.service';

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
