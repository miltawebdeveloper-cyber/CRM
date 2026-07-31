'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, Filter } from 'lucide-react';
import { notificationsApi } from '@/lib/crm';
import { DateFilter, FilterSelect, SearchInput } from '@/components/filter-controls';
import { inDateBounds, EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';
import { formatDateTime } from '@/lib/display-settings';

const READ_OPTS = [
  { label: 'All', value: '' },
  { label: 'Unread', value: 'unread' },
  { label: 'Read', value: 'read' },
];

export default function NotificationsPage() {
  const qc = useQueryClient();
  const [readState, setReadState] = useState('');
  const [dateRange, setDateRange] = useState<DateFilterValue>(EMPTY_DATE_FILTER);
  const [q, setQ] = useState('');
  const { data: allItems = [], isLoading } = useQuery({
    queryKey: ['notifications'],
    queryFn: notificationsApi.list,
  });

  const markAll = useMutation({
    mutationFn: notificationsApi.markAllRead,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

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
          <DateFilter value={dateRange} onChange={setDateRange} />
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
        {items.map((n) => (
          <div
            key={n.id}
            className={`flex items-start gap-3 rounded-lg border bg-card p-4 shadow-sm ${
              n.isRead ? 'opacity-70' : ''
            }`}
          >
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Bell className="h-4 w-4" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">{n.title}</p>
                {!n.isRead && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
              </div>
              <p className="text-sm text-muted-foreground">{n.body}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatDateTime(n.createdAt)}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
