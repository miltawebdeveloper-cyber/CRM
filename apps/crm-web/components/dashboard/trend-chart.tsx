'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import type { TrendDay } from '@/lib/crm';
import { seriesFor, shortDay, type TrendSecond } from './trend-series';

export { shortDay, type TrendSecond };

/**
 * The plot itself, loaded on demand: recharts is about a third of the code on
 * the pages that show this chart, and nothing else on them needs it. The
 * legend, the totals and the table view render at once; the lines follow in a
 * box already sized for them, so nothing moves when they arrive.
 */
const TrendPlot = dynamic(() => import('./trend-plot').then((m) => m.TrendPlot), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse rounded-md bg-muted/40" />,
});

/**
 * Calls made and leads contacted per day — the dashboard's trend.
 *
 * Two series on one axis (both are counts per day), in the validated chart
 * colours (\`--chart-1\`, \`--chart-2\`, globals.css). Built to the dataviz spec:
 * 2px lines, solid hairline grid, a legend plus each line's latest value at its
 * end, a crosshair tooltip with the value leading and the series behind it, and
 * a table view so no number is reachable only by hovering. Text stays in text
 * colours; only the lines and their keys carry the series colour.
 */

/**
 * Where each line's end label sits. When the two latest values are close, the
 * labels would land on each other; the larger one is lifted and the smaller
 * dropped so both stay readable and each stays beside its own line.
 */
export function endLabelOffsets(
  last: Record<string, number>,
  max: number,
  plotHeight = 170,
  keys: [string, string] = ['calls', 'contacted'],
): Record<string, number> {
  const [ka, kb] = keys;
  const [a, b] = [last[ka] ?? 0, last[kb] ?? 0];
  const gapPx = max > 0 ? (Math.abs(a - b) / max) * plotHeight : 0;
  if (gapPx >= 12) return { [ka]: 4, [kb]: 4 };
  return a >= b ? { [ka]: -3, [kb]: 11 } : { [ka]: 11, [kb]: -3 };
}

/** `bare` drops the chart's own card, for a panel that already has one. */
export function TrendChart({ days, dimmed = false, second = 'contacted', bare = false }: { days: TrendDay[]; dimmed?: boolean; second?: TrendSecond; bare?: boolean }) {
  const [asTable, setAsTable] = useState(false);
  const SERIES = useMemo(() => seriesFor(second), [second]);
  const { max, last, offsets, totals } = useMemo(() => {
    const max = Math.max(0, ...days.flatMap((d) => [d.calls, d[second]]));
    const lastDay = days[days.length - 1];
    const last: Record<string, number> = { calls: lastDay?.calls ?? 0, [second]: lastDay?.[second] ?? 0 };
    const totals = days.reduce((t, d) => ({ calls: t.calls + d.calls, connected: t.connected + d.connected, contacted: t.contacted + d.contacted }), { calls: 0, connected: 0, contacted: 0 });
    return { max, last, offsets: endLabelOffsets(last, max, 170, ['calls', second]), totals };
  }, [days, second]);
  const lastIndex = days.length - 1;
  const range = days.length ? `${shortDay(days[0].day)} – ${shortDay(days[lastIndex].day)}` : '';
  const what = SERIES.map((s) => s.label.toLowerCase()).join(' and ');

  return (
    <div className={`${bare ? '' : 'rounded-xl border bg-card px-4 py-3 shadow-sm'} transition-opacity ${dimmed ? 'opacity-60' : ''}`}>
      {/* Legend — always present for two series; line keys, text in text colour. */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
          {SERIES.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4 rounded-full" style={{ background: s.color }} aria-hidden />
              <span className="font-medium">{s.label}</span>
              <span className="tabular-nums text-muted-foreground">{totals[s.key].toLocaleString()}</span>
            </span>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setAsTable((v) => !v)}
          className="text-[11.5px] font-semibold text-primary hover:underline"
          aria-pressed={asTable}
        >
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>

      {asTable ? (
        <div className="max-h-[260px] overflow-y-auto">
          <table className="w-full text-[12px]">
            <caption className="sr-only">
              {second === 'connected' ? 'Calls made and answered per day' : 'Calls made, connected calls and leads contacted per day'}, {range}
            </caption>
            <thead>
              <tr className="border-b text-left text-[11px] text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Day</th>
                <th className="py-1.5 pr-3 text-right font-medium">Calls made</th>
                <th className="py-1.5 pr-3 text-right font-medium">{second === 'connected' ? 'Answered' : 'Connected'}</th>
                {second === 'contacted' && <th className="py-1.5 text-right font-medium">Leads contacted</th>}
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day} className="border-b last:border-0">
                  <td className="py-1.5 pr-3">{shortDay(d.day)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{d.calls.toLocaleString()}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{d.connected.toLocaleString()}</td>
                  {second === 'contacted' && <td className="py-1.5 text-right tabular-nums">{d.contacted.toLocaleString()}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          role="img"
          aria-label={`${what[0].toUpperCase()}${what.slice(1)} per day, ${range}: ${totals.calls} calls, ${totals[second]} ${SERIES[1].label.toLowerCase()}. Use Show table for the figures.`}
          className="h-[230px]"
        >
          <TrendPlot days={days} second={second} max={max} last={last} offsets={offsets} />
        </div>
      )}
    </div>
  );
}
