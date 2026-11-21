'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell, CheckCheck } from 'lucide-react';
import { formatDateTime } from '@/lib/display-settings';
import { badgeText } from '@/lib/notification-cache';
import { safeReturnPath } from '@/lib/return-to';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useUnreadCount,
  useUnreadNotifications,
} from '@/lib/use-notifications';

/**
 * The bell in the top bar: always there, the unread count on it, and the list
 * of what is still unread.
 *
 * Clicking a notification marks it read. It leaves the list and the badge drops
 * on the click, not when the server answers (lib/use-notifications). Read ones
 * stay on the Notifications page ("View all").
 *
 * One about a record — a callback's lead, a Zoom meeting — is a link: the same
 * click also opens that page and closes the list. Only a path inside the CRM
 * is followed (lib/return-to); older notifications have no link and stay a
 * plain "mark as read".
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Where focus goes once a clicked notification has left the list, so a
  // keyboard user keeps their place: the next one's id, '' for the panel.
  const focusNext = useRef<string | null>(null);

  const { data: unread } = useUnreadCount();
  const { data: items, isPending } = useUnreadNotifications(open);
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();

  const count = unread?.count ?? 0;
  const list = (items ?? []).filter((n) => !n.isRead);

  // Closes on a click anywhere else, or Escape (focus back on the bell).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    const id = focusNext.current;
    if (id === null) return;
    focusNext.current = null;
    const next = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[data-notification-id]') ?? []).find(
      (el) => el.dataset.notificationId === id,
    );
    (next ?? panelRef.current)?.focus();
  }, [list.length]);

  function read(id: string, el: HTMLElement) {
    if (document.activeElement === el) {
      const li = el.closest('li');
      const sibling = (li?.nextElementSibling ?? li?.previousElementSibling)?.querySelector<HTMLElement>('[data-notification-id]');
      focusNext.current = sibling?.dataset.notificationId ?? '';
    }
    markRead.mutate(id);
  }

  /** Read it, and go to the page it's about; the list closes behind you. */
  function openRecord(id: string) {
    markRead.mutate(id);
    setOpen(false);
  }

  return (
    // Positioned from `sm` up only. On a phone the list hangs from the whole bar
    // instead (the header is the nearest positioned box) and spans its width:
    // anchored to the bell it would run off the left edge of the screen.
    <div ref={rootRef} className="shrink-0 sm:relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
        title="Notifications"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative grid h-8 w-8 place-items-center rounded-[8px] text-[var(--brand-deep)] transition-colors hover:bg-muted dark:text-foreground/80"
      >
        <Bell className="h-4 w-4" />
        {count > 0 && (
          <span
            aria-hidden
            data-testid="notification-badge"
            className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white"
          >
            {badgeText(count)}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Unread notifications"
          tabIndex={-1}
          className="absolute inset-x-3 top-full z-40 mt-1 overflow-hidden rounded-md border bg-card shadow-lg outline-none sm:inset-x-auto sm:right-0 sm:mt-2 sm:w-80"
        >
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <p className="text-sm font-semibold">
              Notifications <span className="ml-1 text-xs font-normal text-muted-foreground">{count} unread</span>
            </p>
            {count > 0 && (
              <button
                type="button"
                onClick={() => markAll.mutate()}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-muted"
              >
                <CheckCheck className="h-3.5 w-3.5" /> Mark all read
              </button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {isPending ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">Loading…</p>
            ) : list.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">You’re all caught up.</p>
            ) : (
              <ul>
                {list.map((n) => {
                  const href = safeReturnPath(n.link);
                  const item = 'block w-full px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none';
                  const content = (
                    <>
                      <span className="flex items-center gap-2">
                        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                        <span className="text-sm font-medium">{n.title}</span>
                      </span>
                      <span className="block text-xs text-muted-foreground">{n.body}</span>
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">{formatDateTime(n.createdAt)}</span>
                    </>
                  );
                  return (
                    <li key={n.id} className="border-b last:border-0">
                      {href ? (
                        // No prefetch: a long list must not fire a request per row.
                        <Link href={href} prefetch={false} data-notification-id={n.id} onClick={() => openRecord(n.id)} title="Open and mark as read" className={item}>
                          {content}
                        </Link>
                      ) : (
                        <button type="button" data-notification-id={n.id} onClick={(e) => read(n.id, e.currentTarget)} title="Mark as read" className={item}>
                          {content}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            className="block border-t px-3 py-2 text-center text-sm font-medium text-primary hover:bg-muted"
          >
            View all
          </Link>
        </div>
      )}
    </div>
  );
}
