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
/**
 * The pipeline palette — three steps per stage.
 *
 * `color` is the mark: the fill of a bar, a ring slice, a rail. `tint` is the
 * band a heading or chip sits on. `ink` is text on that band — dark enough to
 * read (every pair clears 4.5:1) while still carrying the stage's hue, which a
 * muted grey wouldn't.
 *
 * The marks are chosen as a set rather than picked one at a time: the four
 * temperatures validate together for a chart surface — lightness band, chroma
 * floor, and separation both in normal vision and under colour blindness. The
 * predecessors were stock framework defaults (indigo-500, amber-500, red-500)
 * plus two near-identical dark greens, which failed on separation: Won and Lost
 * were ΔE 2.6 apart under deuteranopia, and the teal read as grey once it was a
 * fill instead of a label.
 *
 * Hot and Closed remain a red/green pair — unavoidable when hot means red and
 * won means green. They clear every hard gate but sit in the warning band for
 * protanopia, so anywhere these become areas rather than labels, identity must
 * carry a second encoding too: a name, a count, a gap.
 */
export const CAT = {
  cold: { label: 'Cold', color: '#3e63dd', tint: '#e4e9fb', ink: '#2a44a8' },
  warm: { label: 'Warm', color: '#dc9200', tint: '#fbf0dc', ink: 'var(--tone-amber-fg-strong)' },
  hot: { label: 'Hot', color: '#e5484d', tint: '#fdeae9', ink: '#a8322f' },
  connected: { label: 'Connected', color: '#0e7c86', tint: '#e0f1f3', ink: '#0a5c63' },
  closed_positive: { label: 'Closed — Won', color: '#0d8a55', tint: '#e0f2e9', ink: '#0a6640' },
  closed_negative: { label: 'Closed — Lost', color: '#b3541e', tint: '#fbeee6', ink: '#8a3d12' },
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
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[10.5px] font-semibold ${inbound ? 'bg-[var(--tone-teal-bg)] text-[var(--tone-teal-fg)]' : 'bg-[#e7eed8] text-[#42512f]'}`}>
      {inbound ? <PhoneIncoming className="h-3 w-3" /> : <PhoneOutgoing className="h-3 w-3" />}
      {inbound ? 'Incoming' : 'Outgoing'}
    </span>
  );
}
