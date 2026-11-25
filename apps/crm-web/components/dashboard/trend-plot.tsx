'use client';

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { TrendDay } from '@/lib/crm';
import { seriesFor, shortDay, type TrendSecond } from './trend-series';

/**
 * The trend chart's plot — the only part that needs recharts, which is about a
 * third of the Dashboard's and the Calling Panel's code. `TrendChart` loads
 * this on demand, so those pages draw their figures first and the lines a
 * moment later, in a box already sized for them.
 */

const INK = 'hsl(var(--foreground))';
const MUTED = 'hsl(var(--muted-foreground))';
const GRID = 'hsl(var(--border))';

type TipEntry = { dataKey?: string | number; value?: number; payload?: TrendDay };

function TrendTooltip({ active, payload, label, second }: { active?: boolean; payload?: TipEntry[]; label?: string | number; second: TrendSecond }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  return (
    <div className="rounded-md border bg-card px-3 py-2 text-[12px] shadow-md">
      <div className="mb-1 text-[11px] text-muted-foreground">{typeof label === 'string' ? shortDay(label) : label}</div>
      {seriesFor(second).map((s) => (
        <div key={s.key} className="flex items-center gap-2">
          <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: s.color }} aria-hidden />
          <span className="font-semibold tabular-nums">{(row?.[s.key] ?? 0).toLocaleString()}</span>
          <span className="text-muted-foreground">{s.label}</span>
        </div>
      ))}
      {/* The answered count rides along under the dashboard's two lines; when
          answered IS the second line, it's already above. */}
      {row && second === 'contacted' && (
        <div className="mt-1 border-t pt-1 text-[11px] text-muted-foreground">
          {row.connected.toLocaleString()} of the calls connected
        </div>
      )}
    </div>
  );
}

export function TrendPlot({
  days,
  second,
  max,
  last,
  offsets,
}: {
  days: TrendDay[];
  second: TrendSecond;
  max: number;
  last: Record<string, number>;
  offsets: Record<string, number>;
}) {
  const lastIndex = days.length - 1;
  return (
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
        <Tooltip content={<TrendTooltip second={second} />} cursor={{ stroke: MUTED, strokeWidth: 1 }} />
        {seriesFor(second).map((s) => (
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
  );
}
