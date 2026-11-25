/**
 * What the trend chart draws, kept apart from the drawing itself so the chart's
 * legend, totals and table can render without the charting library — see
 * `trend-chart.tsx`, which loads the plot (`trend-plot.tsx`) on demand.
 */

/**
 * The second line: leads contacted (the dashboard) or answered calls (the
 * Calling Panel's Analytics tab). The first is always calls made.
 */
export type TrendSecond = 'contacted' | 'connected';
export type SeriesKey = 'calls' | TrendSecond;

export function seriesFor(second: TrendSecond) {
  return [
    { key: 'calls' as SeriesKey, label: 'Calls made', color: 'var(--chart-1)' },
    second === 'connected'
      ? { key: 'connected' as SeriesKey, label: 'Answered', color: 'var(--chart-2)' }
      : { key: 'contacted' as SeriesKey, label: 'Leads contacted', color: 'var(--chart-2)' },
  ];
}

/** "Nov 20" from "2026-11-20", read as a calendar day — no clock, no zone shift. */
export function shortDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
