'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notificationsApi } from '@/lib/crm';
import {
  NOTIFICATION_KEYS,
  NOTIFICATION_MUTATION_KEY,
  restoreNotifications,
  showAsRead,
  snapshotNotifications,
} from '@/lib/notification-cache';

/**
 * How often the bell checks for new notifications.
 *
 * Notifications raised by somebody else's work (a teammate's callback, an
 * import, a target alert) can only reach this screen by asking, so this is how
 * late one of those can be. Ones raised by your own actions don't wait for it:
 * every successful action re-reads the bell straight away (app/providers).
 */
export const UNREAD_POLL_MS = 15_000;

/** The badge's number. */
export function useUnreadCount() {
  return useQuery({
    queryKey: NOTIFICATION_KEYS.count,
    queryFn: notificationsApi.unreadCount,
    refetchInterval: UNREAD_POLL_MS,
    // Never trusted from cache: back on the tab after a while, the badge
    // catches up at once instead of at the next tick.
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

/** The bell's list — unread only. Fetched while the bell is open, and kept fresh while it stays open. */
export function useUnreadNotifications(enabled: boolean) {
  return useQuery({
    queryKey: NOTIFICATION_KEYS.unread,
    queryFn: notificationsApi.listUnread,
    enabled,
    staleTime: 0,
    refetchInterval: enabled ? UNREAD_POLL_MS : false,
    retry: false,
  });
}

/** The Notifications page — read and unread. */
export function useNotificationList() {
  return useQuery({ queryKey: NOTIFICATION_KEYS.list, queryFn: notificationsApi.list });
}

/**
 * A "mark as read" that shows at once: the item leaves the unread list and the
 * badge drops on the click (`showAsRead`), not when the server answers. If the
 * server refuses, everything goes back as it was and the shared error toast
 * says so.
 *
 * The server's own figures are fetched once the LAST of a quick run of clicks
 * has settled. Refetching after each one would bring a notification clicked a
 * moment later back for a moment, because its own request hasn't landed yet.
 */
function useMarkRead<V>(name: string, send: (v: V) => Promise<unknown>, ids: (v: V) => readonly string[] | 'all', errorMessage: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...NOTIFICATION_MUTATION_KEY, name],
    mutationFn: send,
    onMutate: async (v: V) => {
      // A poll already on its way would land after this and put the old figures back.
      await qc.cancelQueries({ queryKey: NOTIFICATION_KEYS.all });
      const snapshot = snapshotNotifications(qc);
      showAsRead(qc, ids(v));
      return { snapshot };
    },
    onError: (_err, _v, ctx) => {
      if (ctx) restoreNotifications(qc, ctx.snapshot);
    },
    onSettled: () => {
      // Still counts this one: it is pending until its callbacks finish.
      if (qc.isMutating({ mutationKey: NOTIFICATION_MUTATION_KEY }) === 1) {
        return qc.invalidateQueries({ queryKey: NOTIFICATION_KEYS.all });
      }
    },
    meta: { errorMessage },
  });
}

export function useMarkNotificationRead() {
  return useMarkRead('read', (id: string) => notificationsApi.markRead(id), (id) => [id], 'Couldn’t mark that notification as read.');
}

export function useMarkAllNotificationsRead() {
  return useMarkRead<void>('read-all', () => notificationsApi.markAllRead(), () => 'all', 'Couldn’t mark your notifications as read.');
}
