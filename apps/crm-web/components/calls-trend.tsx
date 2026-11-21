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

  return (
    <section className="flex h-full min-w-0 flex-col rounded-2xl border bg-card p-4 shadow-sm sm:p-5" aria-label="Calls per day">
      <header className="mb-3">
        <h3 className="font-display text-[14px] font-semibold">Calls per day</h3>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          Calls made and answered, day by day
          {clipped && <> · the last {TREND_MAX_DAYS} days</>}
          {data?.truncated && <span className="text-[var(--tone-red-fg-2)]"> · from the first {data.scanned.toLocaleString()} calls only</span>}
        </p>
      </header>
      {days.length < 2 ? (
        // One day is a number, not a trend — the overview band has it.
        <p className="grid flex-1 place-items-center py-10 text-center text-[12.5px] text-muted-foreground">A trend needs at least two days. Pick a longer range.</p>
      ) : (
        <TrendChart days={days} second="connected" bare />
      )}
    </section>
  );
}
