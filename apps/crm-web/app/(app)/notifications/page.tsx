'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Bell, Filter } from 'lucide-react';
import { safeReturnPath } from '@/lib/return-to';
import { useMarkAllNotificationsRead, useMarkNotificationRead, useNotificationList } from '@/lib/use-notifications';
import { DateFilter, FilterSelect, SearchInput } from '@/components/filter-controls';
import { inDateBounds, EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';
import { formatDateTime } from '@/lib/display-settings';

const READ_OPTS = [
  { label: 'All', value: '' },
  { label: 'Unread', value: 'unread' },
  { label: 'Read', value: 'read' },
];

export default function NotificationsPage() {
  const [readState, setReadState] = useState('');
  const [dateRange, setDateRange] = useState<DateFilterValue>(EMPTY_DATE_FILTER);
  const [q, setQ] = useState('');
  const { data: allItems = [], isLoading } = useNotificationList();

  // Both show at once — here, in the bell's list and on its badge — before the
  // server answers (lib/use-notifications).
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();

  const unread = allItems.filter((n) => !n.isRead).length;

  const term = q.trim().toLowerCase();
  const items = allItems.filter(
    (n) =>
      (!readState || (readState === 'unread' ? !n.isRead : n.isRead)) &&
      inDateBounds(n.createdAt, dateRange) &&
      (!term || n.title.toLowerCase().includes(term) || (n.body ?? '').toLowerCase().includes(term)),
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <p className="text-sm text-muted-foreground">
          {unread} unread · {allItems.length} total
        </p>
        <div className="flex flex-wrap items-center gap-2.5">
          <SearchInput value={q} onChange={setQ} placeholder="Search notifications…" className="min-w-[220px]" />
          <FilterSelect icon={Filter} value={readState} onChange={setReadState} options={READ_OPTS} />
          <DateFilter value={dateRange} onChange={setDateRange} iconOnly />
          {unread > 0 && (
            <button
              onClick={() => markAll.mutate()}
              className="rounded-md border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              Mark all read
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!isLoading && items.length === 0 && (
          <div className="rounded-lg border bg-card p-10 text-center text-sm text-muted-foreground shadow-sm">
            {allItems.length === 0
              ? 'No notifications yet. Import leads or complete calls to generate alerts.'
              : 'No notifications match the current filters.'}
          </div>
        )}
        {items.map((n) => {
          const content = (
            <>
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Bell className="h-4 w-4" />
              </span>
              <span className="block flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-medium">{n.title}</span>
                  {!n.isRead && (
                    <>
                      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
                      <span className="sr-only">Unread</span>
                    </>
                  )}
                </span>
                <span className="block text-sm text-muted-foreground">{n.body}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{formatDateTime(n.createdAt)}</span>
              </span>
            </>
          );
          const card = 'flex w-full items-start gap-3 rounded-lg border bg-card p-4 text-left shadow-sm';
          // One about a record (a callback's lead, a Zoom meeting) opens it —
          // read or not — and marks it read on the way. Only a path inside the
          // CRM is followed (lib/return-to). No prefetch: up to 100 rows.
          const href = safeReturnPath(n.link);
          if (href) {
            return (
              <Link
                key={n.id}
                href={href}
                prefetch={false}
                onClick={() => { if (!n.isRead) markRead.mutate(n.id); }}
                title={n.isRead ? 'Open' : 'Open and mark as read'}
                className={`${card} transition-colors hover:bg-muted/50 ${n.isRead ? 'opacity-70' : ''}`}
              >
                {content}
              </Link>
            );
          }
          // Otherwise an unread one is a button: clicking it marks it read, and
          // under the Unread filter it leaves the list.
          return n.isRead ? (
            <div key={n.id} className={`${card} opacity-70`}>
              {content}
            </div>
          ) : (
            <button
              key={n.id}
              type="button"
              onClick={() => markRead.mutate(n.id)}
              title="Mark as read"
              className={`${card} transition-colors hover:bg-muted/50`}
            >
              {content}
            </button>
          );
        })}
      </div>
    </div>
  );
}
