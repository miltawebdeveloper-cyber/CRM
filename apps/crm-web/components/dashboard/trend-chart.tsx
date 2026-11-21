'use client';

import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { TrendDay } from '@/lib/crm';

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
const SERIES = [
  { key: 'calls', label: 'Calls made', color: 'var(--chart-1)' },
  { key: 'contacted', label: 'Leads contacted', color: 'var(--chart-2)' },
] as const;

const INK = 'hsl(var(--foreground))';
const MUTED = 'hsl(var(--muted-foreground))';
const GRID = 'hsl(var(--border))';

/** "Nov 20" from "2026-11-20", read as a calendar day — no clock, no zone shift. */
export function shortDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Where each line's end label sits. When the two latest values are close, the
 * labels would land on each other; the larger one is lifted and the smaller
 * dropped so both stay readable and each stays beside its own line.
 */
export function endLabelOffsets(last: Record<string, number>, max: number, plotHeight = 170): Record<string, number> {
  const [a, b] = SERIES.map((s) => last[s.key] ?? 0);
  const gapPx = max > 0 ? (Math.abs(a - b) / max) * plotHeight : 0;
  if (gapPx >= 12) return { calls: 4, contacted: 4 };
  return a >= b ? { calls: -3, contacted: 11 } : { calls: 11, contacted: -3 };
}

type TipEntry = { dataKey?: string | number; value?: number; payload?: TrendDay };

function TrendTooltip({ active, payload, label }: { active?: boolean; payload?: TipEntry[]; label?: string | number }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  return (
    <div className="rounded-md border bg-card px-3 py-2 text-[12px] shadow-md">
      <div className="mb-1 text-[11px] text-muted-foreground">{typeof label === 'string' ? shortDay(label) : label}</div>
      {SERIES.map((s) => (
        <div key={s.key} className="flex items-center gap-2">
          <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: s.color }} aria-hidden />
          <span className="font-semibold tabular-nums">{(row?.[s.key] ?? 0).toLocaleString()}</span>
          <span className="text-muted-foreground">{s.label}</span>
        </div>
      ))}
      {row && (
        <div className="mt-1 border-t pt-1 text-[11px] text-muted-foreground">
          {row.connected.toLocaleString()} of the calls connected
        </div>
      )}
    </div>
  );
}

export function TrendChart({ days, dimmed = false }: { days: TrendDay[]; dimmed?: boolean }) {
  const [asTable, setAsTable] = useState(false);
  const { max, last, offsets, totals } = useMemo(() => {
    const max = Math.max(0, ...days.flatMap((d) => [d.calls, d.contacted]));
    const lastDay = days[days.length - 1];
    const last = { calls: lastDay?.calls ?? 0, contacted: lastDay?.contacted ?? 0 };
    const totals = days.reduce((t, d) => ({ calls: t.calls + d.calls, connected: t.connected + d.connected, contacted: t.contacted + d.contacted }), { calls: 0, connected: 0, contacted: 0 });
    return { max, last, offsets: endLabelOffsets(last, max), totals };
  }, [days]);
  const lastIndex = days.length - 1;
  const range = days.length ? `${shortDay(days[0].day)} – ${shortDay(days[lastIndex].day)}` : '';

  return (
    <div className={`rounded-xl border bg-card px-4 py-3 shadow-sm transition-opacity ${dimmed ? 'opacity-60' : ''}`}>
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
            <caption className="sr-only">Calls made, connected calls and leads contacted per day, {range}</caption>
            <thead>
              <tr className="border-b text-left text-[11px] text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Day</th>
                <th className="py-1.5 pr-3 text-right font-medium">Calls made</th>
                <th className="py-1.5 pr-3 text-right font-medium">Connected</th>
                <th className="py-1.5 text-right font-medium">Leads contacted</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day} className="border-b last:border-0">
                  <td className="py-1.5 pr-3">{shortDay(d.day)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{d.calls.toLocaleString()}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{d.connected.toLocaleString()}</td>
                  <td className="py-1.5 text-right tabular-nums">{d.contacted.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          role="img"
          aria-label={`Calls made and leads contacted per day, ${range}: ${totals.calls} calls, ${totals.contacted} leads contacted. Use Show table for the figures.`}
          className="h-[230px]"
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={days} margin={{ top: 8, right: 34, bottom: 0, left: -12 }}>
              <CartesianGrid vertical={false} stroke={GRID} strokeWidth={1} />
              <XAxis
                dataKey="day"
                tickFormatter={shortDay}
                tick={{ fill: MUTED, fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: GRID }}
                minTickGap={24}
                interval="preserveStartEnd"
              />
              <YAxis
                allowDecimals={false}
                tick={{ fill: MUTED, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={44}
                domain={[0, max > 0 ? 'auto' : 4]}
              />
              <Tooltip content={<TrendTooltip />} cursor={{ stroke: MUTED, strokeWidth: 1 }} />
              {SERIES.map((s) => (
                <Line
                  key={s.key}
                  type="linear"
                  dataKey={s.key}
                  name={s.label}
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--card))' }}
                  isAnimationActive={false}
                  label={({ x, y, index }: { x?: number | string; y?: number | string; index?: number }) =>
                    // The latest value at the line's end — the one figure worth labelling.
                    index === lastIndex ? (
                      <text key={`${s.key}-end`} x={Number(x) + 6} y={Number(y)} dy={offsets[s.key]} fontSize={11} fontWeight={600} fill={INK}>
                        {last[s.key].toLocaleString()}
                      </text>
                    ) : (
                      <g key={`${s.key}-${index}`} />
                    )
                  }
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
