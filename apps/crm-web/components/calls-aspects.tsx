'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Columns3 } from 'lucide-react';
import { callsApi, outcomesApi, formatDuration, type CallPivotAxis, type CallPivotDim } from '@/lib/crm';
import { CAT, type CallFilters } from '@/components/calls-shared';
import { FilterSelect } from '@/components/filter-controls';
import { usePersistedState } from '@/lib/use-persisted-state';

/** What the columns can break down by. Values mirror the API's CallPivotDim. */
const DIMS: readonly { label: string; value: CallPivotDim }[] = [
  { value: 'bucket', label: 'Funnel bucket' },
  { value: 'direction', label: 'Direction' },
  { value: 'status', label: 'Call status' },
  { value: 'leadStatus', label: 'Lead status' },
  { value: 'date', label: 'Date' },
  { value: 'weekday', label: 'Weekday' },
  { value: 'hour', label: 'Hour of day' },
  { value: 'employee', label: 'Employee' },
];

const MEASURES = [
  { value: 'share', label: 'Share %' },
  { value: 'calls', label: 'Calls' },
  { value: 'connect', label: 'Connect %' },
  { value: 'talk', label: 'Talk time' },
  { value: 'avg', label: 'Avg call' },
] as const;
type Measure = (typeof MEASURES)[number]['value'];

/** Bars are one series, so they take one hue. The dimensions that configure their
 *  own colours (outcomes, funnel buckets) keep them, because those colours already
 *  mean something in the pipeline and ratios directly below this chart. */
const BAR_HUE = '#556b34';

/** The API's key for "this call has no value on this axis" (no outcome logged, no
 *  known caller). It is never a bar: a share is measured against the calls that
 *  recorded an outcome — the same denominator the conversion ratios and the funnel
 *  below this chart use, so two panels on one screen can't quote different numbers
 *  for the same bucket. The calls it stands for are disclosed under the title
 *  rather than dropped silently. */
const NO_VALUE = '∅';

interface Agg {
  calls: number;
  connected: number;
  secs: number;
}
const EMPTY: Agg = { calls: 0, connected: 0, secs: 0 };
const add = (a: Agg, b: Agg): Agg => ({ calls: a.calls + b.calls, connected: a.connected + b.connected, secs: a.secs + b.secs });

/** Derive a measure. `total` is the denominator for a share. */
function measureOf(a: Agg, m: Measure, total: number): number {
  if (a.calls === 0) return 0;
  switch (m) {
    case 'share': return total > 0 ? (a.calls / total) * 100 : 0;
    case 'calls': return a.calls;
    case 'connect': return (a.connected / a.calls) * 100;
    case 'talk': return a.secs;
    case 'avg': return a.secs / a.calls;
  }
}

const isPct = (m: Measure) => m === 'share' || m === 'connect';

function fmtMeasure(v: number, m: Measure): string {
  if (isPct(m)) return `${Math.round(v)}%`;
  if (m === 'calls') return v.toLocaleString();
  return formatDuration(Math.round(v));
}

/** dd-mm-yyyy — the format the chart title reads in. */
const fmtDay = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
};

/** Labels the API can't give a good answer for alone: dates arrive as ISO days so
 *  they format in the reader's locale, and funnel buckets take their colour from
 *  CAT, which is the web side's source of truth for the funnel's look. */
function axisMeta(dim: CallPivotDim, a: CallPivotAxis): { label: string; color: string | null } {
  if (dim === 'bucket' && a.key in CAT) {
    const c = CAT[a.key as keyof typeof CAT];
    return { label: c.label, color: c.color };
  }
  if (dim === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(a.label)) return { label: fmtDay(a.label), color: null };
  return { label: a.label, color: a.color };
}

/**
 * Aspects — one employee's calls broken down into columns: how their work in the
 * range splits across the funnel, the outcomes, the clock, or whoever else you
 * ask for.
 *
 * It reads one rep at a time, from the employee filter above it, because that's
 * the question this chart answers — "how is this person calling?" — and a chart
 * per rep would bury it. Pick "All Employees" for the team as a whole.
 *
 * Scope is the API's to enforce: an employee only ever gets their own calls back,
 * whatever the filter says.
 */
export function CallsAspects({ filters }: { filters: CallFilters }) {
  const { params, dateFilter, userId, users, isManager } = filters;
  const [dim, setDim] = usePersistedState<CallPivotDim>('calls-aspects:dim', 'bucket');
  const [measure, setMeasure] = usePersistedState<Measure>('calls-aspects:measure', 'share');

  // rows=employee keeps the response scoped per caller; the columns are the
  // aspect being asked about. The API applies the employee filter, so what comes
  // back is already only the selected rep's calls.
  const query = useMemo(() => ({ ...params, rows: 'employee' as CallPivotDim, cols: dim }), [params, dim]);
  const { data, isLoading } = useQuery({ queryKey: ['calls-aspects', query], queryFn: () => callsApi.madePivot(query) });
  const { data: outcomes = [] } = useQuery({ queryKey: ['outcomes-config'], queryFn: outcomesApi.list });

  // Funnel buckets and configured outcomes are a fixed checklist: every one of
  // them gets a column, zeroes included, because "no hot calls" is an answer and
  // a silently missing bar isn't. The open-ended dimensions (dates, hours) have no
  // checklist to hold them to, so those show only what actually happened.
  const checklist = useMemo<CallPivotAxis[] | null>(() => {
    if (dim === 'bucket') return Object.keys(CAT).map((key) => ({ key, label: key, color: null }));
    if (dim === 'outcome') return outcomes.map((o) => ({ key: o.slug, label: o.name, color: o.color }));
    return null;
  }, [dim, outcomes]);

  // Column totals of an already-scoped response: one rep's row when a rep is
  // selected, the team's when not.
  const { bars, unlogged } = useMemo(() => {
    const cols = data?.cols ?? [];
    const totals = cols.map(() => EMPTY);
    for (const c of data?.cells ?? []) if (totals[c.c]) totals[c.c] = add(totals[c.c], { calls: c.calls, connected: c.connected, secs: c.secs });
    const byKey = new Map(cols.map((c, i) => [c.key, totals[i]]));
    const axis = checklist ?? cols.filter((c) => c.key !== NO_VALUE);
    const shown = axis.map((col) => ({ col, agg: byKey.get(col.key) ?? EMPTY }));
    const denom = shown.reduce((a, x) => add(a, x.agg), EMPTY).calls;
    return {
      bars: shown.map(({ col, agg }) => {
        const meta = axisMeta(dim, col);
        return { label: meta.label, color: meta.color ?? BAR_HUE, value: measureOf(agg, measure, denom), agg };
      }),
      unlogged: byKey.get(NO_VALUE)?.calls ?? 0,
    };
  }, [data, dim, measure, checklist]);

  // The chart names who it's about, the way a printed report would.
  const who = userId ? users.find((u) => u.id === userId)?.name ?? 'Employee' : isManager ? 'All Employees' : 'My Calls';
  const when =
    dateFilter.from && dateFilter.to
      ? dateFilter.from === dateFilter.to
        ? fmtDay(dateFilter.from)
        : `${fmtDay(dateFilter.from)} – ${fmtDay(dateFilter.to)}`
      : 'All dates';

  const hasData = bars.some((b) => b.agg.calls > 0);

  return (
    <div className="mb-[18px] rounded-2xl border bg-card p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <div>
          <h3 className="font-display text-[15px] font-semibold italic">{who} Call {when}</h3>
          <p className="text-[11.5px] text-muted-foreground">
            {isManager && !userId ? 'The whole team — pick an employee above to read one rep.' : 'Calls in the selected range, broken down by aspect.'}
            {unlogged > 0 && (
              <>
                {' '}
                <span className="text-[#a8431f]">
                  {unlogged.toLocaleString()} call{unlogged === 1 ? '' : 's'} with no outcome logged {unlogged === 1 ? 'is' : 'are'} not counted.
                </span>
              </>
            )}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2.5">
          <FilterSelect icon={Columns3} value={dim} onChange={(v) => setDim(v as CallPivotDim)} options={DIMS} />
          <div className="inline-flex rounded-md bg-muted/60 p-[2px]">
            {MEASURES.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setMeasure(m.value)}
                aria-pressed={measure === m.value}
                className={`whitespace-nowrap rounded-[5px] px-2.5 py-[5px] text-[11.5px] font-semibold transition-colors ${
                  measure === m.value ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-background hover:text-foreground'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {isLoading ? (
        <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
      ) : !hasData ? (
        <p className="py-16 text-center text-sm text-muted-foreground">No calls in the selected range.</p>
      ) : (
        /* Responsive plot: height shrinks on small screens, and the chart keeps a
           readable per-bar width by scrolling horizontally rather than squashing
           every bar and axis label together once there are many categories (e.g.
           24 hour buckets on a phone). With few bars the min-width is under 100%,
           so ResponsiveContainer just fills the card as before. */
        <div className="h-[260px] overflow-x-auto sm:h-[300px] lg:h-[340px]">
          <div className="h-full" style={{ minWidth: Math.max(bars.length * 46, 320) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={bars} margin={{ top: 16, right: 12, bottom: 28, left: 8 }} barCategoryGap="22%">
              {/* Recessive grid: horizontal only — the bars carry the comparison. */}
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={{ stroke: 'hsl(var(--border))' }}
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                interval={0}
                label={{ value: 'ASPECTS', position: 'insideBottom', offset: -18, style: { fontSize: 11, fontWeight: 600, fill: 'hsl(var(--muted-foreground))', letterSpacing: '0.08em' } }}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={54}
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                tickFormatter={(v: number) => fmtMeasure(v, measure)}
                domain={isPct(measure) ? [0, (max: number) => Math.min(100, Math.ceil((max + 3) / 5) * 5)] : [0, 'auto']}
                label={{ value: who.toUpperCase(), angle: -90, position: 'insideLeft', style: { fontSize: 11, fontWeight: 600, fill: 'hsl(var(--muted-foreground))', letterSpacing: '0.08em', textAnchor: 'middle' } }}
              />
              <Tooltip
                cursor={{ fill: 'hsl(var(--muted))' }}
                contentStyle={{ borderRadius: 10, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))', fontSize: 12 }}
                labelStyle={{ fontWeight: 600, color: 'hsl(var(--foreground))' }}
                formatter={(v, _name, item) => {
                  // The bar shows one measure; the tooltip adds the call count
                  // behind it, so a tall "100%" bar can't hide a single call.
                  const a = (item?.payload as { agg?: Agg } | undefined)?.agg;
                  const label = fmtMeasure(Number(v), measure);
                  return [a ? `${label} · ${a.calls.toLocaleString()} call${a.calls === 1 ? '' : 's'}` : label, MEASURES.find((m) => m.value === measure)!.label];
                }}
              />
              {/* 4px rounded data-end, anchored to the baseline. */}
              <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={64} isAnimationActive={false}>
                {bars.map((b) => (
                  <Cell key={b.label} fill={b.color} />
                ))}
                {/* Direct labels: the value is the point, so it shouldn't need a hover. */}
                <LabelList
                  dataKey="value"
                  position="top"
                  formatter={(v) => (Number(v) > 0 ? fmtMeasure(Number(v), measure) : '')}
                  style={{ fontSize: 11, fontWeight: 600, fill: 'hsl(var(--foreground))' }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
