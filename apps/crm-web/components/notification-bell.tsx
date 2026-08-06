'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { notificationsApi } from '@/lib/crm';

export function NotificationBell() {
  const [open, setOpen] = useState(false);

  const { data: unread } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: notificationsApi.unreadCount,
    refetchInterval: 30_000, // NTF-004 — keep badge fresh
    retry: false,
  });

  const { data: items = [] } = useQuery({
    queryKey: ['notifications', 'recent'],
    queryFn: notificationsApi.list,
    enabled: open,
    retry: false,
  });

  const count = unread?.count ?? 0;

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Notifications"
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Bell className="h-4 w-4" />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 w-80 rounded-md border bg-card shadow-lg">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-sm font-semibold">Notifications</span>
              <span className="text-xs text-muted-foreground">{count} unread</span>
            </div>
            <div className="max-h-80 overflow-y-auto">
              {items.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">No notifications</p>
              ) : (
                items.slice(0, 8).map((n) => (
                  <div key={n.id} className={`border-b px-3 py-2 last:border-0 ${n.isRead ? 'opacity-60' : ''}`}>
                    <div className="flex items-center gap-2">
                      {!n.isRead && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
                      <p className="text-sm font-medium">{n.title}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">{n.body}</p>
                  </div>
                ))
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
        </>
      )}
    </div>
  );
}
