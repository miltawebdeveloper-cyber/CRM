import { Injectable } from '@nestjs/common';
import { NotificationType, Role } from '@crm/database';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MailService } from '../mail/mail.service.js';
import { textToHtml } from '../../common/html.js';

const EMAIL_SETTINGS_KEY = 'callbacks:email_settings';

// Notification types whose emails are admin-toggleable (req 7).
export type ToggleableType = 'callback_reminder' | 'callback_due' | 'callback_missed';

export interface EmailSettings {
  /** Configurable distribution list — emailed in addition to the assigned user. */
  recipients: string[];
  /** Per-type email enable flags (default on). */
  types: Record<ToggleableType, boolean>;
}

const DEFAULT_TYPES: Record<ToggleableType, boolean> = {
  callback_reminder: true,
  callback_due: true,
  callback_missed: true,
};

/**
 * Which callback events reach an inbox, and which stay inside the CRM.
 *
 * ONLY A MISSED CALLBACK IS EMAILED. Booking a callback, the day-before nudge,
 * the "due now" prompt and an automatic roll-over to the next working day are
 * all things the rep is already looking at — they raise the bell, the popup and
 * the Follow-Ups list, and that is the whole of it.
 *
 * Every one of them used to send mail as well. A rep booking twenty callbacks
 * in a sitting generated twenty emails to themselves AND to every address on the
 * distribution list, plus another as each one came due — so the one message that
 * actually needed somebody to act, the missed alert, arrived in a folder nobody
 * read any more. Reserving mail for the exception is what makes it mean
 * something.
 *
 * This is a rule about the events, not a preference, which is why it lives here
 * and not in the admin settings: no toggle can turn "callback scheduled" back
 * into an email. The admin switch below still applies on top, so the missed
 * alert can be turned off, and is the only one of the three that does anything.
 */
const CALLBACK_EMAIL_TYPES: Record<ToggleableType, boolean> = {
  callback_reminder: false, // scheduled · day-before · rolled over — CRM only
  callback_due: false, // the scheduled time arrived — CRM only
  callback_missed: true, // not completed in time — the one that emails
};

/**
 * A notification's link, kept only when it is a path inside the CRM.
 *
 * The links are built here in the API ("/leads/<id>", "/zoom/<id>"), never
 * taken from a user, but the browser follows them on a click, so anything that
 * isn't a plain same-site path — an absolute URL, a protocol-relative `//host`,
 * a backslash or control-character form a browser might read as one — is
 * dropped rather than stored.
 */
export function notificationLink(link: string | null | undefined): string | null {
  if (!link || !link.startsWith('/') || link.startsWith('//')) return null;
  if (/[\\\s\u0000-\u001f\u007f]/.test(link)) return null;
  return link.slice(0, 500);
}

/** Whether this notification type is one of the callback events. */
function isCallbackType(type: string): type is ToggleableType {
  return type in CALLBACK_EMAIL_TYPES;
}

/**
 * Whether a callback event carries an email at all, before the admin toggle.
 * Exported so the admin screen can say which switches are live rather than
 * offering three that look identical and behave differently.
 */
export function callbackTypeSendsEmail(type: ToggleableType): boolean {
  return CALLBACK_EMAIL_TYPES[type];
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  /**
   * The newest 100: read and unread for the Notifications page, or unread only
   * (`unread`) for the bell, which lists what is still waiting to be read.
   *
   * Filtered here rather than in the browser. Picking the unread rows out of the
   * newest 100 would miss an older unread one sitting behind a hundred read
   * ones — and the bell would say "all caught up" under a badge still counting
   * it.
   */
  list(userId: string, opts: { unread?: boolean } = {}) {
    return this.prisma.notification.findMany({
      where: { userId, ...(opts.unread ? { isRead: false } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // NTF-004 — unread badge count
  async unreadCount(userId: string) {
    const count = await this.prisma.notification.count({ where: { userId, isRead: false } });
    return { count };
  }

  markRead(id: string, userId: string) {
    return this.prisma.notification.updateMany({
      where: { id, userId },
      data: { isRead: true },
    });
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true } });
    return { success: true };
  }

  /** Create one notification (used by this module's test endpoint). */
  create(userId: string, type: NotificationType, title: string, body: string) {
    return this.prisma.notification.create({ data: { userId, type, title, body } });
  }

  /**
   * Fan-out a notification to every admin + team leader (NTF-001..003).
   * Used by other modules (imports, target alerts) via the shared service.
   */
  async notifyManagers(type: NotificationType, title: string, body: string, link?: string | null) {
    const managers = await this.prisma.user.findMany({
      where: { role: { in: [Role.admin, Role.team_leader] }, isActive: true },
      select: { id: true },
    });
    if (managers.length === 0) return { created: 0 };
    const to = notificationLink(link);
    await this.prisma.notification.createMany({
      data: managers.map((m) => ({ userId: m.id, type, title, body, link: to })),
    });
    return { created: managers.length };
  }

  /**
   * Admin-configurable email settings (req 7): the recipient distribution list
   * and per-type email toggles, stored in AppSetting `callbacks:email_settings`.
   */
  async getEmailSettings(): Promise<EmailSettings> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: EMAIL_SETTINGS_KEY } });
    const v = (row?.value ?? {}) as Partial<EmailSettings>;
    return {
      recipients: Array.isArray(v.recipients) ? v.recipients.filter((e): e is string => typeof e === 'string') : [],
      types: { ...DEFAULT_TYPES, ...(v.types ?? {}) },
    };
  }

  async updateEmailSettings(input: { recipients: string[]; types?: Partial<Record<ToggleableType, boolean>> }): Promise<EmailSettings> {
    const recipients = Array.from(
      new Set((input.recipients ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean)),
    );
    const types = { ...DEFAULT_TYPES, ...(input.types ?? {}) };
    const value = { recipients, types };
    await this.prisma.appSetting.upsert({
      where: { key: EMAIL_SETTINGS_KEY },
      update: { value },
      create: { key: EMAIL_SETTINGS_KEY, value },
    });
    return value;
  }

  /**
   * Create an in-app notification for one user, and send the matching email if
   * this event is one that carries one.
   *
   * The in-app half always happens — that is the CRM notification every callback
   * raises, and nothing below can suppress it. The email half is the exception:
   * of the callback events only a missed callback sends one (see
   * `CALLBACK_EMAIL_TYPES`), and the admin can switch even that off. `email` is
   * the assigned user's address; the configured distribution list (req 7) is
   * emailed in addition. Email is best-effort and never fails the caller.
   *
   * `link` is the page the notification is about — clicking it in the bell
   * opens that page (see `notificationLink`).
   */
  async notifyAndEmail(
    userId: string | null,
    type: NotificationType,
    title: string,
    body: string,
    opts: { email?: string | null; alsoManagers?: boolean; link?: string | null } = {},
  ) {
    if (userId) {
      await this.prisma.notification.create({ data: { userId, type, title, body, link: notificationLink(opts.link) } });
    }
    if (opts.alsoManagers) {
      await this.notifyManagers(type, title, body, opts.link);
    }

    // A callback event that is CRM-only stops here, having done its real job.
    // Checked before the settings are even read: this is not a preference.
    if (isCallbackType(type) && !CALLBACK_EMAIL_TYPES[type]) return;

    const settings = await this.getEmailSettings();
    // Toggleable callback types respect the admin switch; other types always send.
    if (type in settings.types && !settings.types[type as ToggleableType]) return;

    const recipients = new Set<string>();
    if (opts.email) recipients.add(opts.email);
    for (const r of settings.recipients) recipients.add(r);
    if (recipients.size > 0) {
      await this.mail.send({
        to: Array.from(recipients),
        subject: title,
        // Escaped: the body carries lead names and notes from imports/webhooks.
        html: textToHtml(body),
        text: body,
      });
    }
  }
}
