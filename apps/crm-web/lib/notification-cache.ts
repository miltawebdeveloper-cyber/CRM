import type { MutationKey, QueryClient, QueryKey } from '@tanstack/react-query';
import type { Notification as AppNotification } from '@/lib/crm';

/**
 * Where notifications live in the query cache, and how "mark as read" shows on
 * screen before the server has answered.
 *
 * Three entries under one prefix:
 *  • `count`  — the bell's badge;
 *  • `unread` — the bell's list, unread only;
 *  • `list`   — the Notifications page, read and unread.
 * Invalidating `all` refreshes every one of them.
 */
export const NOTIFICATION_KEYS = {
  all: ['notifications'],
  count: ['notifications', 'unread-count'],
  unread: ['notifications', 'unread'],
  list: ['notifications', 'list'],
} as const;

/**
 * The key every notification action runs under. The app-wide "re-read the bell
 * after an action" refresh (app/providers) skips these, since they keep the
 * cache themselves.
 */
export const NOTIFICATION_MUTATION_KEY = ['notifications'] as const;

export type NotificationSnapshot = Array<[QueryKey, unknown]>;

/** Every cached notification entry, to put back if the server refuses a change. */
export function snapshotNotifications(qc: QueryClient): NotificationSnapshot {
  return qc.getQueriesData({ queryKey: NOTIFICATION_KEYS.all });
}

export function restoreNotifications(qc: QueryClient, snapshot: NotificationSnapshot) {
  for (const [key, data] of snapshot) qc.setQueryData(key, data);
}

/**
 * Show notifications as read everywhere at once, before the server confirms:
 * gone from the bell's unread list, marked read on the Notifications page, and
 * off the badge. `'all'` is Mark all read.
 *
 * The badge drops by the number that were actually unread, counted before
 * anything changes — clicking one that is already read, or one the cache has
 * never seen, leaves it alone, and the refetch that follows has the final word.
 */
export function showAsRead(qc: QueryClient, ids: readonly string[] | 'all') {
  const hit = (n: AppNotification) => ids === 'all' || ids.includes(n.id);

  const wasUnread = new Set<string>();
  for (const key of [NOTIFICATION_KEYS.unread, NOTIFICATION_KEYS.list]) {
    for (const n of qc.getQueryData<AppNotification[]>(key) ?? []) if (!n.isRead && hit(n)) wasUnread.add(n.id);
  }

  // An updater that returns undefined leaves an uncached entry uncached.
  qc.setQueryData<AppNotification[]>(NOTIFICATION_KEYS.unread, (old) => old?.filter((n) => !hit(n)));
  qc.setQueryData<AppNotification[]>(NOTIFICATION_KEYS.list, (old) =>
    old?.map((n) => (hit(n) && !n.isRead ? { ...n, isRead: true } : n)),
  );
  qc.setQueryData<{ count: number }>(NOTIFICATION_KEYS.count, (old) =>
    old ? { count: ids === 'all' ? 0 : Math.max(0, old.count - wasUnread.size) } : old,
  );
}

/**
 * Re-read the bell after a successful action — every one but the bell's own.
 *
 * Booking a callback, scheduling a Zoom or finishing an import can raise a
 * notification for the person who did it, and the badge should move with the
 * action, not up to 15 seconds later at the next poll. Cheap: the badge is a
 * count, and only the entries on screen refetch. The bell's own actions keep
 * the cache themselves (lib/use-notifications), and refetching under them would
 * undo what they just showed. Called for every mutation from app/providers.
 */
export function refreshBellAfter(qc: QueryClient, mutationKey: MutationKey | undefined) {
  if (mutationKey?.[0] === NOTIFICATION_MUTATION_KEY[0]) return;
  void qc.invalidateQueries({ queryKey: NOTIFICATION_KEYS.all });
}

/** The badge's text: the count, up to 99. */
export function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count);
}
