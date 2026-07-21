'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PhoneIncoming, PhoneOutgoing, User as UserIcon } from 'lucide-react';
import { usersApi } from '@/lib/users';
import { DateFilter, FilterSelect } from '@/components/filter-controls';
import { EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';
import { usePersistedState } from '@/lib/use-persisted-state';

/**
 * Funnel colours — one source of truth for the pipeline, the ratio bars and the
 * breakdown headings, so a bucket reads the same everywhere it appears.
 */
export const CAT = {
  cold: { label: 'Cold', color: '#6366f1', tint: '#eef0fe' },
  warm: { label: 'Warm', color: '#f59e0b', tint: '#fef6e7' },
  hot: { label: 'Hot', color: '#ef4444', tint: '#fdeeee' },
  connected: { label: 'Connected', color: '#2f6f63', tint: '#e3f1ee' },
  closed_positive: { label: 'Closed — Won', color: '#3f7a32', tint: '#e8f2e4' },
  closed_negative: { label: 'Closed — Lost', color: '#a8431f', tint: '#fbeeec' },
} as const;

/**
 * Date range + employee filter shared by the Calls Made and Analytics tabs.
 *
 * Both are persisted, and only one tab is mounted at a time, so the selection
 * carries across when you switch — the two tabs are two readings of the same
 * slice of calls, and it would be a trap if they silently disagreed.
 */
export function useCallFilters(isManager: boolean) {
  const [dateFilter, setDateFilter] = usePersistedState<DateFilterValue>('calls-made:date-filter', EMPTY_DATE_FILTER);
  const [userId, setUserId] = usePersistedState<string>('calls-made:user', '');

  // Only managers may list users, and only they see the employee filter.
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: usersApi.list, enabled: isManager, retry: false });

  const userOpts = useMemo(
    () => [{ label: 'All Employees', value: '' }, ...users.filter((u) => u.role !== 'admin').map((u) => ({ label: u.name, value: u.id }))],
    [users],
  );

  const params = useMemo(
    () => ({
      from: dateFilter.from || undefined,
      to: dateFilter.to || undefined,
      ...(isManager && userId ? { userId } : {}),
    }),
    [dateFilter.from, dateFilter.to, isManager, userId],
  );

  return { dateFilter, setDateFilter, userId, setUserId, users, userOpts, params, isManager };
}

export type CallFilters = ReturnType<typeof useCallFilters>;

/** The filter row both tabs render, so they look and behave identically. */
export function CallFilterBar({ filters, children }: { filters: CallFilters; children?: React.ReactNode }) {
  const { dateFilter, setDateFilter, userId, setUserId, userOpts, isManager } = filters;
  return (
    <div className="mb-[18px] flex flex-wrap items-center gap-2.5">
      <DateFilter value={dateFilter} onChange={setDateFilter} />
      {isManager && <FilterSelect icon={UserIcon} value={userId} onChange={setUserId} options={userOpts} />}
      {children}
    </div>
  );
}

/** Direction chip — the provider only sets this on OpenPhone calls. */
export function DirectionPill({ direction }: { direction: 'inbound' | 'outbound' | null }) {
  if (!direction) return <span className="text-muted-foreground">—</span>;
  const inbound = direction === 'inbound';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[11px] font-semibold ${inbound ? 'bg-[#e3f1ee] text-[#2f6f63]' : 'bg-[#e7eed8] text-[#42512f]'}`}>
      {inbound ? <PhoneIncoming className="h-3 w-3" /> : <PhoneOutgoing className="h-3 w-3" />}
      {inbound ? 'Incoming' : 'Outgoing'}
    </span>
  );
}
