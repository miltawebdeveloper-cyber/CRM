import { describe, expect, it, jest } from '@jest/globals';
import { QueryClient } from '@tanstack/react-query';
import type { Notification as AppNotification } from '@/lib/crm';
import {
  NOTIFICATION_KEYS,
  badgeText,
  refreshBellAfter,
  restoreNotifications,
  showAsRead,
  snapshotNotifications,
} from './notification-cache';

const note = (id: string, isRead = false): AppNotification => ({
  id,
  title: `Title ${id}`,
  body: 'Body',
  type: 'callback_due',
  isRead,
  createdAt: '2026-11-20T10:00:00Z',
  link: null,
});

function seeded() {
  const qc = new QueryClient();
  qc.setQueryData(NOTIFICATION_KEYS.count, { count: 2 });
  qc.setQueryData(NOTIFICATION_KEYS.unread, [note('a'), note('b')]);
  qc.setQueryData(NOTIFICATION_KEYS.list, [note('a'), note('b'), note('c', true)]);
  return qc;
}

const ids = (list: AppNotification[] | undefined) => (list ?? []).map((n) => n.id);

describe('showAsRead — a click shows everywhere at once', () => {
  it('takes it off the unread list, marks it read on the page and drops the badge by one', () => {
    const qc = seeded();
    showAsRead(qc, ['a']);
    expect(ids(qc.getQueryData(NOTIFICATION_KEYS.unread))).toEqual(['b']);
    const page = qc.getQueryData<AppNotification[]>(NOTIFICATION_KEYS.list)!;
    expect(page.find((n) => n.id === 'a')?.isRead).toBe(true);
    expect(page.find((n) => n.id === 'b')?.isRead).toBe(false);
    expect(qc.getQueryData(NOTIFICATION_KEYS.count)).toEqual({ count: 1 });
  });

  it('leaves the badge alone for one that was already read', () => {
    const qc = seeded();
    showAsRead(qc, ['c']);
    expect(qc.getQueryData(NOTIFICATION_KEYS.count)).toEqual({ count: 2 });
  });

  it('never takes the badge below zero', () => {
    const qc = seeded();
    qc.setQueryData(NOTIFICATION_KEYS.count, { count: 0 });
    showAsRead(qc, ['a', 'b']);
    expect(qc.getQueryData(NOTIFICATION_KEYS.count)).toEqual({ count: 0 });
  });

  it('Mark all read empties the unread list and clears the badge', () => {
    const qc = seeded();
    showAsRead(qc, 'all');
    expect(qc.getQueryData(NOTIFICATION_KEYS.unread)).toEqual([]);
    expect(qc.getQueryData<AppNotification[]>(NOTIFICATION_KEYS.list)!.every((n) => n.isRead)).toBe(true);
    expect(qc.getQueryData(NOTIFICATION_KEYS.count)).toEqual({ count: 0 });
  });

  it('counts a notification only on the Notifications page (the bell never opened)', () => {
    const qc = new QueryClient();
    qc.setQueryData(NOTIFICATION_KEYS.count, { count: 3 });
    qc.setQueryData(NOTIFICATION_KEYS.list, [note('a')]);
    showAsRead(qc, ['a']);
    expect(qc.getQueryData(NOTIFICATION_KEYS.count)).toEqual({ count: 2 });
    // And creates nothing for the list that was never fetched.
    expect(qc.getQueryData(NOTIFICATION_KEYS.unread)).toBeUndefined();
  });

  it('puts everything back from a snapshot when the server refuses', () => {
    const qc = seeded();
    const snap = snapshotNotifications(qc);
    showAsRead(qc, 'all');
    restoreNotifications(qc, snap);
    expect(ids(qc.getQueryData(NOTIFICATION_KEYS.unread))).toEqual(['a', 'b']);
    expect(qc.getQueryData(NOTIFICATION_KEYS.count)).toEqual({ count: 2 });
  });
});

describe('refreshBellAfter — the badge follows your own actions', () => {
  it('re-reads every notification entry after an ordinary action', () => {
    const qc = new QueryClient();
    const spy = jest.spyOn(qc, 'invalidateQueries');
    refreshBellAfter(qc, undefined);
    refreshBellAfter(qc, ['callbacks', 'book']);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toEqual({ queryKey: NOTIFICATION_KEYS.all });
  });

  it('leaves the bell’s own actions to keep the cache themselves', () => {
    const qc = new QueryClient();
    const spy = jest.spyOn(qc, 'invalidateQueries');
    refreshBellAfter(qc, ['notifications', 'read']);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('badgeText', () => {
  it('shows the count, up to 99', () => {
    expect(badgeText(1)).toBe('1');
    expect(badgeText(12)).toBe('12');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(150)).toBe('99+');
  });
});
