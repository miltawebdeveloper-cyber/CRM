'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { callsApi, type CallPivot, type CallPivotDim, type TrendDay } from '@/lib/crm';
import type { CallFilters } from '@/components/calls-shared';
import { TrendChart } from '@/components/dashboard/trend-chart';

/** Longest span drawn — beyond it a day's point is too thin to read. */
export const TREND_MAX_DAYS = 92;

const DAY = 86_400_000;
const toUtc = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Calls and answered calls per business day, out of a pivot by date.
 *
 * Every day in the span is present, zeroes included — a gap in a line reads as
 * missing data. The span is the selected range, or with "all dates" the first
 * to the last day that has calls; either way at most the last
 * TREND_MAX_DAYS days (`clipped` says so).
 */
export function trendDays(pivot: CallPivot | undefined, from?: string, to?: string): { days: TrendDay[]; clipped: boolean } {
  const per = new Map<string, { calls: number; connected: number }>();
  for (const cell of pivot?.cells ?? []) {
    const key = pivot?.cols[cell.c]?.key;
    if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    const at = per.get(key) ?? { calls: 0, connected: 0 };
    per.set(key, { calls: at.calls + cell.calls, connected: at.connected + cell.connected });
  }
  const present = [...per.keys()].sort();
  const end = to || present[present.length - 1];
  let start = from || present[0];
  if (!start || !end || start > end) return { days: [], clipped: false };

  let clipped = false;
  const span = Math.round((toUtc(end) - toUtc(start)) / DAY) + 1;
  if (span > TREND_MAX_DAYS) {
    start = fromUtc(toUtc(end) - (TREND_MAX_DAYS - 1) * DAY);
    clipped = true;
  }
  const days: TrendDay[] = [];
  for (let t = toUtc(start); t <= toUtc(end); t += DAY) {
    const day = fromUtc(t);
    const v = per.get(day);
    days.push({ day, calls: v?.calls ?? 0, connected: v?.connected ?? 0, contacted: 0 });
  }
  return { days, clipped };
}

/**
 * Analytics' daily trend: calls made and answered per day over the range, for
 * the rep or team the page is filtered to. Read from the same pivot the
 * breakdown chart uses (by date), so the two can't count a day differently —
 * and it shares that chart's cache when it is set to Date.
 */
export function CallsTrend({ filters }: { filters: CallFilters }) {
  const { params, dateFilter } = filters;
  const query = useMemo(() => ({ ...params, rows: 'employee' as CallPivotDim, cols: 'date' as CallPivotDim }), [params]);
  const { data } = useQuery({ queryKey: ['calls-aspects', query], queryFn: () => callsApi.madePivot(query) });
  const { days, clipped } = useMemo(() => trendDays(data, dateFilter.from, dateFilter.to), [data, dateFilter.from, dateFilter.to]);

  if (days.length < 2) return null; // One day is a number, not a trend — the headline row has it.
  return (
    <section className="mb-[18px]" aria-label="Calls per day">
      <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-widest text-muted-foreground">
        Calls per day
        {clipped && <span className="normal-case tracking-normal opacity-70"> · the last {TREND_MAX_DAYS} days</span>}
        {data?.truncated && (
          <span className="normal-case tracking-normal text-[var(--tone-red-fg-2)]"> · from the first {data.scanned.toLocaleString()} calls only</span>
        )}
      </h3>
      <TrendChart days={days} second="connected" />
    </section>
  );
}
