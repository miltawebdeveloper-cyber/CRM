'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { Pencil } from 'lucide-react';
import { callsApi, type CallStatusCount } from '@/lib/crm';
import { CAT, CallFilterBar, useCallFilters } from '@/components/calls-shared';
import { CallsAspects } from '@/components/calls-aspects';

/** Target dial: completed vs target as a ring. */
function Dial({ pct }: { pct: number }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const filled = Math.min(pct, 100) / 100;
  return (
    <div className="relative grid h-[86px] w-[86px] shrink-0 place-items-center">
      <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90">
        {/* Themed tokens, not fixed hex: the track was a light grey that stayed
            light on the dark card, and the fill was the old cold-stage indigo —
            which read as a pipeline colour on a card that has nothing to do with
            the pipeline. Target attainment is brand work, so it wears the brand. */}
        <circle cx="40" cy="40" r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth="9" />
        <circle
          cx="40" cy="40" r={r} fill="none" stroke="hsl(var(--primary))" strokeWidth="9" strokeLinecap="round"
          strokeDasharray={`${c * filled} ${c}`}
        />
      </svg>
      <div className="absolute text-center">
        <div className="font-display text-[17px] font-semibold leading-none">{Math.round(pct)}%</div>
        <div className="text-[9px] uppercase tracking-wider text-muted-foreground">met</div>
      </div>
    </div>
  );
}

/** One row of the conversion-ratio bar chart. */
function RatioBar({ label, pct, color }: { label: string; pct: number; color: string }) {
  return (
    <div className="flex items-center gap-3 text-[12.5px]">
      <span className="w-[112px] shrink-0 truncate text-muted-foreground">{label}</span>
      <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full transition-[width]" style={{ width: `${Math.min(pct, 100)}%`, background: color }} />
      </span>
      <span className="w-9 shrink-0 text-right font-semibold tabular-nums">{Math.round(pct)}%</span>
    </div>
  );
}

/** One lead-book count: how many, and of what. */
function Figure({ value, label, color, tint }: { value: number; label: string; color?: string; tint?: string }) {
  return (
    <div
      className="flex-1 rounded-[10px] px-2.5 py-2 text-center"
      style={color ? { background: tint, color } : { background: '#27301d', color: '#fff' }}
    >
      <div className="font-display text-[19px] font-semibold leading-none">{value.toLocaleString()}</div>
      <div className="mt-[3px] text-[9.5px] font-semibold uppercase tracking-wider opacity-80">{label}</div>
    </div>
  );
}

/** A stage of the Cold → Warm → Hot → Closed pipeline. */
function Stage({ label, value, sub, color, tint, dark }: { label: string; value: number; sub: string; color?: string; tint?: string; dark?: boolean }) {
  return (
    <div
      className="min-w-[112px] flex-1 shrink-0 rounded-[9px] px-2.5 py-1.5"
      style={dark ? { background: '#27301d', color: '#fff' } : { background: tint, color }}
    >
      <div className="text-[9px] font-semibold uppercase tracking-wider opacity-80">{label}</div>
      {/* Value and its qualifier share a line — the stage is a glanceable figure,
          and a third row of text was buying height without buying meaning. */}
      <div className="mt-[2px] flex items-baseline gap-1.5">
        <span className="font-display text-[17px] font-semibold leading-none">{value.toLocaleString()}</span>
        <span className="truncate text-[9.5px] leading-none opacity-70" title={sub}>{sub}</span>
      </div>
    </div>
  );
}

/** Ink used where a heading carries no category colour of its own. */
const INK = '#27301d';

/** One stage of the pipeline palette — mark, band, and text on that band. */
type Cat = (typeof CAT)[keyof typeof CAT];

/**
 * A card heading that carries its bucket's colour.
 *
 * The headings used to be a 2px dot and plain text on white, which put five
 * cards of near-identical grey chrome side by side — you had to read every
 * title to find the one you wanted. Filling the band with the bucket's own tint
 * makes the column findable by colour before it's read, and ties each card to
 * the stage of the same colour in the strip above it.
 *
 * The count rides in the heading as a pill, so the card's headline number is
 * legible at a glance rather than only at the foot of a long list of zeroes.
 */
function CardHead({ title, cat, dark, count }: {
  title: string; cat?: Cat; dark?: boolean; count?: number;
}) {
  return (
    <>
      {/* A 2px rail of the stage's full-strength mark above its tinted band.
          The tint alone is pale by necessity — it has to hold dark text — so
          the rail is what carries the colour at full saturation and gives the
          row of cards an edge to scan along. */}
      <div className="h-[2px] w-full" style={{ background: dark ? INK : cat?.color }} />
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={dark ? { background: INK, color: '#fff' } : { background: cat?.tint, color: cat?.ink }}
      >
        <h4 className="truncate text-[11px] font-bold uppercase tracking-[.09em]">{title}</h4>
        {count !== undefined && (
          // Lifted off the band rather than given its own colour: the band is
          // already carrying the identity, and a second colour here would compete.
          <span className={`ml-auto shrink-0 rounded-full px-2 py-[1px] text-[11px] font-bold tabular-nums ${dark ? 'bg-white/15' : 'bg-white/70'}`}>
            {count.toLocaleString()}
          </span>
        )}
      </div>
    </>
  );
}

/** One breakdown column: the statuses in a bucket with their counts. */
function Breakdown({ title, cat, dark, rows, total, totalLabel = 'Total' }: {
  title: string; cat?: Cat; dark?: boolean; rows: CallStatusCount[]; total: number; totalLabel?: string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <CardHead title={title} cat={cat} dark={dark} count={total} />
      <div className="px-3">
        {rows.length === 0 ? (
          <p className="py-3 text-center text-[11.5px] text-muted-foreground">No statuses in this bucket.</p>
        ) : rows.map((r) => (
          // -mx-1.5 px-1.5 so the hover highlight extends into the card's
          // padding instead of stopping short of the text it belongs to.
          <div key={r.slug} className="-mx-1.5 flex items-center justify-between gap-3 rounded-md border-b px-1.5 py-1 text-[12px] transition-colors last:border-0 hover:bg-muted/60">
            <span className="truncate" style={{ color: r.count > 0 ? undefined : '#9aa08e' }}>{r.name}</span>
            <span className={`shrink-0 tabular-nums ${r.count > 0 ? 'font-semibold' : 'text-muted-foreground'}`}>{r.count}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t bg-muted/40 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[.07em]">
        <span>{totalLabel}</span>
        <span className="text-[12.5px] tabular-nums">{total}</span>
      </div>
    </div>
  );
}

/**
 * The ring's slices, in the funnel's own order.
 *
 * Colours are the `--viz-*` tokens (see globals.css), which are the chart steps
 * of the same hues CAT uses everywhere else on this page — CAT's own values are
 * tuned for text and tinted chips and don't separate as chart fills.
 *
 * Connected / Follow-ups comes last and takes the neutral. It isn't a
 * temperature on the Cold → Warm → Hot → Closed funnel, so it reads as the
 * "still being worked" remainder, and sitting last it also keeps Closed from
 * touching Cold where the ring wraps.
 */
const RING = [
  { key: 'cold', label: 'Cold', color: 'var(--viz-cold)' },
  { key: 'warm', label: 'Warm', color: 'var(--viz-warm)' },
  { key: 'hot', label: 'Hot', color: 'var(--viz-hot)' },
  { key: 'closed', label: 'Closed', color: 'var(--viz-closed)' },
  { key: 'working', label: 'Connected / Follow-ups', color: 'var(--viz-working)' },
] as const;

/**
 * Pipeline Mix — the parts-of-whole reading of the funnel above it.
 *
 * The stage strip and the breakdown columns both answer "how many", one bucket
 * at a time. Neither shows the *shape* of the book: whether the range is mostly
 * cold, or mostly closing. A ring answers that at a glance because the slices
 * are the whole, and the middle carries the total they add up to.
 *
 * Every slice is named, counted and given its share in the legend, so identity
 * never rests on colour alone — which is also what makes the one unavoidable
 * red/green pair (Hot vs Closed) safe for colourblind readers.
 */
function PipelineMix({ given, cats }: { given: number; cats?: { cold: number; warm: number; hot: number; connected: number; closedPositive: number; closedNegative: number } }) {
  const slices = useMemo(() => {
    const by: Record<string, number> = {
      cold: cats?.cold ?? 0,
      warm: cats?.warm ?? 0,
      hot: cats?.hot ?? 0,
      // Won and lost are one stage here — the Closed column beside this splits
      // them, and two more slices is where the ring stops being readable.
      closed: (cats?.closedPositive ?? 0) + (cats?.closedNegative ?? 0),
      working: cats?.connected ?? 0,
    };
    return RING.map((r) => ({ ...r, value: by[r.key] }));
  }, [cats]);

  // The ring's own total rather than `given`: the two are the same number by
  // construction (every status sits in exactly one bucket), and if they ever
  // drifted the percentages should still add to 100.
  const total = slices.reduce((s, x) => s + x.value, 0);
  const drawn = slices.filter((s) => s.value > 0);
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);

  return (
    <div className="flex h-full flex-col rounded-xl border bg-card shadow-sm">
      {/* Dark, like Given Leads at the other end of the row: the two cards that
          summarise the whole bookend the four that break it down. */}
      {/* No count pill here — the ring's centre already carries the total, in
          bigger type a few pixels below it. */}
      <CardHead title="Pipeline Mix" dark />

      {total === 0 ? (
        <p className="px-3 py-8 text-center text-[11.5px] text-muted-foreground">
          No outcomes in this range yet, so there&apos;s no mix to show.
        </p>
      ) : (
        <>
          <div className="relative h-[186px] px-2 pt-3">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={drawn}
                  dataKey="value"
                  nameKey="label"
                  innerRadius="62%"
                  outerRadius="94%"
                  // 2px of the card showing between segments, so neighbouring
                  // slices read as separate marks rather than one blended arc.
                  paddingAngle={2}
                  stroke="hsl(var(--card))"
                  strokeWidth={2}
                  isAnimationActive={false}
                >
                  {drawn.map((s) => (
                    <Cell key={s.key} fill={s.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ borderRadius: 10, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))', fontSize: 12 }}
                  labelStyle={{ fontWeight: 600, color: 'hsl(var(--foreground))' }}
                  formatter={(v, name) => {
                    const n = Number(v ?? 0);
                    return [`${n.toLocaleString()} · ${Math.round(pct(n))}%`, String(name ?? '')];
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
            {/* The total the slices add up to, in the hole the ring leaves.
                `pointer-events-none` so it never eats a slice's hover. */}
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="text-center">
                <div className="font-display text-[22px] font-semibold leading-none">{total.toLocaleString()}</div>
                <div className="mt-1 text-[9px] uppercase tracking-wider text-muted-foreground">given leads</div>
              </div>
            </div>
          </div>

          {/* Legend and table in one: every stage, its count and its share —
              including the empty ones, so a zero reads as measured rather than
              missing, exactly as the breakdown columns do. */}
          <div className="px-3 pb-1">
            {slices.map((s) => (
              <div key={s.key} className="-mx-1.5 flex items-center gap-2 rounded-md border-b px-1.5 py-1 text-[12px] transition-colors last:border-0 hover:bg-muted/60">
                {/* A bar rather than a dot: it reads as a piece of the ring, and
                    at 3px it still carries the colour at legend size. */}
                <span className="h-3 w-[3px] shrink-0 rounded-full" style={{ background: s.color }} />
                <span className="truncate" style={{ color: s.value > 0 ? undefined : '#9aa08e' }}>{s.label}</span>
                <span className={`ml-auto shrink-0 tabular-nums ${s.value > 0 ? 'font-semibold' : 'text-muted-foreground'}`}>{s.value}</span>
                <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">{Math.round(pct(s.value))}%</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Manager-only editor for a rep's per-day target and miss reason. */
function TargetEditor({ userId, onDone }: { userId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['call-target', userId], queryFn: () => callsApi.callTarget(userId), retry: false });
  const [target, setTarget] = useState<string>('');
  const [reason, setReason] = useState<string>('');
  const loaded = data !== undefined;
  const save = useMutation({
    mutationFn: () => callsApi.setCallTarget(userId, { dailyCallTarget: Number(target || 0), targetMissReason: reason }),
    meta: { successMessage: 'Target saved' },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['calls-made'] });
      qc.invalidateQueries({ queryKey: ['call-target', userId] });
      onDone();
    },
  });

  // Seed the inputs once the current values arrive.
  if (loaded && target === '' && reason === '' && (data.dailyCallTarget || data.targetMissReason)) {
    setTarget(String(data.dailyCallTarget));
    setReason(data.targetMissReason ?? '');
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label="Set call target">
      <div className="w-[380px] max-w-full rounded-2xl border bg-card p-5 shadow-lg">
        <h3 className="mb-3 font-display text-[15px] font-semibold">Call target</h3>
        <label className="mb-3 block space-y-1 text-sm">
          <span className="font-medium">Calls per working day</span>
          <input
            type="number" min="0" value={target} onChange={(e) => setTarget(e.target.value)}
            placeholder="0 = no target"
            className="w-full rounded-md border bg-background px-3 py-2"
          />
        </label>
        <label className="mb-4 block space-y-1 text-sm">
          <span className="font-medium">Reason for not achieving</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="w-full rounded-md border bg-background px-3 py-2" />
        </label>
        <div className="flex items-center gap-3">
          <button onClick={() => save.mutate()} disabled={save.isPending} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onDone} className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted">Cancel</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Analytics — how the calls in the range performed: target attainment,
 * conversion ratios, the Cold → Warm → Hot → Closed pipeline, and the per-status
 * breakdown behind it. The calls themselves live on the Calls Made tab.
 *
 * Statuses and their buckets come from the configurable outcome list (Admin →
 * Outcomes), so this stays in step with Lead Management.
 */
export function CallsAnalytics({ isManager }: { isManager: boolean }) {
  const filters = useCallFilters(isManager);
  const { params, dateFilter, userId } = filters;
  const [editTarget, setEditTarget] = useState(false);

  const { data: stats } = useQuery({ queryKey: ['calls-made', 'stats', params], queryFn: () => callsApi.madeStats(params) });
  // Keyed on the employee alone — the lead book counts what's held now, so the
  // date range must not send it refetching for an answer that can't change.
  const { data: leads } = useQuery({ queryKey: ['lead-book', userId], queryFn: () => callsApi.leadBook(userId || undefined) });

  const byStatus = useMemo(() => stats?.byStatus ?? [], [stats?.byStatus]);
  const inCat = (c: keyof typeof CAT) => byStatus.filter((s) => s.category === c);
  const given = stats?.given ?? 0;
  const cats = stats?.categories;

  return (
    <div>
      <CallFilterBar filters={filters}>
        {isManager && userId && (
          <button onClick={() => setEditTarget(true)} className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-2 text-[12.5px] font-semibold hover:bg-muted">
            <Pencil className="h-3.5 w-3.5" /> Set target
          </button>
        )}
      </CallFilterBar>

      {/* How the selected rep's calls split across the chosen aspect. Reads one
          employee at a time, off the same filter bar as everything below it. */}
      <CallsAspects filters={filters} />

      {/* Target attainment + conversion ratios */}
      <div className="mb-[18px] grid gap-[18px] lg:grid-cols-[minmax(280px,1fr)_2fr]">
        <div className="rounded-2xl border bg-card p-5 shadow-sm">
          {/* The lead book always has an answer, so the card leads with it rather
              than sitting empty whenever there's no target to measure against.
              These count leads held now — the date range governs calls, not the
              book — so the heading says which employee's book it is. */}
          <h3 className="mb-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Lead Book <span className="normal-case tracking-normal opacity-70">· current, not date-filtered</span>
          </h3>
          <div className="flex items-stretch gap-2">
            <Figure value={leads?.assigned ?? 0} label="Assigned" />
            <Figure value={leads?.completed ?? 0} label="Completed" color={CAT.closed_positive.color} tint={CAT.closed_positive.tint} />
            <Figure value={leads?.balance ?? 0} label="Balance" color={CAT.warm.color} tint={CAT.warm.tint} />
          </div>

          <div className="mt-3 border-t pt-3">
            {stats?.target ? (
              <div className="flex items-center gap-5">
                <Dial pct={stats.target.metPct} />
                <div className="min-w-0 space-y-1 text-[12.5px]">
                  <div><b className="font-display text-[17px]">{stats.target.target.toLocaleString()}</b> <span className="text-muted-foreground">target calls</span></div>
                  <div><b className="font-display text-[17px]">{stats.target.completed.toLocaleString()}</b> <span className="text-muted-foreground">completed</span></div>
                  <div><b className="font-display text-[17px]">{stats.target.remaining.toLocaleString()}</b> <span className="text-muted-foreground">remaining</span></div>
                  {stats.target.reason && (
                    <p className="mt-1.5 rounded-md bg-[#fbeeec] px-2.5 py-1 text-[11.5px] text-[#a8431f]">Not achieving — {stats.target.reason}</p>
                  )}
                </div>
              </div>
            ) : (
              <p className="py-1 text-center text-[12px] text-muted-foreground">
                {dateFilter.mode === 'all'
                  ? 'Pick a date range to measure against the call target.'
                  : isManager
                    ? 'No call target set. Choose an employee, then “Set target”.'
                    : 'No call target set for you yet.'}
              </p>
            )}
          </div>
        </div>

        <div className="rounded-2xl border bg-card p-5 shadow-sm">
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Conversion Ratios</h3>
          <div className="space-y-2">
            <RatioBar label="Calls made" pct={stats?.ratios.callsMade ?? 0} color="#27301d" />
            <RatioBar label="Warm calls" pct={stats?.ratios.warm ?? 0} color={CAT.warm.color} />
            <RatioBar label="Closed negative" pct={stats?.ratios.closedNegative ?? 0} color={CAT.closed_negative.color} />
            <RatioBar label="Hot calls" pct={stats?.ratios.hot ?? 0} color={CAT.hot.color} />
            <RatioBar label="Connected calls" pct={stats?.ratios.connected ?? 0} color={CAT.connected.color} />
            <RatioBar label="Closed positive" pct={stats?.ratios.closedPositive ?? 0} color={CAT.closed_positive.color} />
          </div>
        </div>
      </div>

      {/* Cold → Warm → Hot → Closed. Compact single-line row that sticks to the top
          of the scroll area, so the pipeline stays in view while the per-status
          breakdown below is scrolled. Overflows to a horizontal scroll on narrow
          screens rather than wrapping, keeping it to one line. */}
      <div className="sticky top-0 z-20 mb-[18px] rounded-2xl border bg-card px-3.5 py-2.5 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex flex-1 items-stretch gap-1.5 overflow-x-auto">
            <Stage dark label="Given Leads" value={given} sub={stats?.target ? `of ${stats.target.target.toLocaleString()} target` : 'with an outcome'} />
            <div className="grid shrink-0 place-items-center text-[11px] text-muted-foreground/50">→</div>
            <Stage label="Cold" value={cats?.cold ?? 0} sub={`${Math.round(stats?.coldPct ?? 0)}% of leads`} color={CAT.cold.color} tint={CAT.cold.tint} />
            <div className="grid shrink-0 place-items-center text-[11px] text-muted-foreground/50">→</div>
            <Stage label="Warm" value={cats?.warm ?? 0} sub={`${Math.round(stats?.ratios.warm ?? 0)}% of leads`} color={CAT.warm.color} tint={CAT.warm.tint} />
            <div className="grid shrink-0 place-items-center text-[11px] text-muted-foreground/50">→</div>
            <Stage label="Hot" value={cats?.hot ?? 0} sub={`${Math.round(stats?.ratios.hot ?? 0)}% of leads`} color={CAT.hot.color} tint={CAT.hot.tint} />
            <div className="grid shrink-0 place-items-center text-[11px] text-muted-foreground/50">→</div>
            <Stage dark label="Closed" value={(cats?.closedPositive ?? 0) + (cats?.closedNegative ?? 0)} sub={`${cats?.closedPositive ?? 0} won · ${cats?.closedNegative ?? 0} lost`} />
          </div>
        </div>
      </div>

      {/* Per-status breakdown in three quarters of the row, the ring in the
          last quarter. The four columns were spread across the full width and
          the counts — mostly single digits — left most of each column empty, so
          the section read as a wall of blank card. The ring puts that space to
          work with the one thing the columns can't show: the shape of the book.

          Below xl the ring stacks underneath at full width rather than being
          squeezed into a quarter of a laptop screen. */}
      <div className="grid gap-3 xl:grid-cols-[3fr_1fr]">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Breakdown title="Given Leads" dark rows={byStatus} total={given} />
          <Breakdown title={CAT.cold.label} cat={CAT.cold} rows={inCat('cold')} total={cats?.cold ?? 0} />
          <div className="space-y-3">
            <Breakdown title={CAT.warm.label} cat={CAT.warm} rows={inCat('warm')} total={cats?.warm ?? 0} />
            <Breakdown title={CAT.hot.label} cat={CAT.hot} rows={inCat('hot')} total={cats?.hot ?? 0} />
          </div>
          <div className="space-y-3">
            <Breakdown title="Connected / Follow-ups" cat={CAT.connected} rows={inCat('connected')} total={cats?.connected ?? 0} />
            {/* Green, matching the ring's Closed slice. It was rust, which is the
                Closed-Lost colour — the same bucket wearing two colours across
                two cards in one row. */}
            <Breakdown title="Closed" cat={CAT.closed_positive} rows={[...inCat('closed_positive'), ...inCat('closed_negative')]} total={(cats?.closedPositive ?? 0) + (cats?.closedNegative ?? 0)} />
          </div>
        </div>
        {/* Self-start so the ring keeps its own height instead of stretching to
            match the tallest breakdown column. */}
        <div className="self-start">
          <PipelineMix given={given} cats={cats} />
        </div>
      </div>

      {editTarget && userId && <TargetEditor userId={userId} onDone={() => setEditTarget(false)} />}
    </div>
  );
}
