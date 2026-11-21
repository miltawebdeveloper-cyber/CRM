'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Download, FileQuestion, Pencil, Phone, PhoneCall, PhoneOff, Timer } from 'lucide-react';
import { callsApi, formatDuration, type CallStatusCount, type LeadBook as LeadBookCounts } from '@/lib/crm';
import { CAT, CallFilterBar, useCallFilters } from '@/components/calls-shared';
import { CallsAspects } from '@/components/calls-aspects';
import { CallsTrend } from '@/components/calls-trend';
import { CallsTeam } from '@/components/calls-team';
import { KpiCard, KpiGrid } from '@/components/dashboard/kpi-card';
import { IconAction } from '@/components/icon-action';
import { kpiDelta } from '@/lib/kpi-delta';
import { previousRange } from '@/lib/previous-range';
import { downloadCsv } from '@/lib/export';
import { EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';
import { businessTodayLocal } from '@/lib/business-day';
import { QUICK_RANGES, activeQuickRange, quickRange, type QuickRange } from '@/lib/quick-ranges';

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
        <div className="font-display text-[15.5px] font-semibold leading-none">{Math.round(pct)}%</div>
        <div className="text-[9px] uppercase tracking-wider text-muted-foreground">met</div>
      </div>
    </div>
  );
}

/** One row of the conversion-ratio bar chart. `hint` says what the share counts. */
function RatioBar({ label, pct, color, hint }: { label: string; pct: number; color: string; hint?: string }) {
  return (
    <div className="flex items-center gap-3 text-[12px]" title={hint}>
      <span className="w-[150px] shrink-0 truncate text-muted-foreground">{label}</span>
      <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full transition-[width]" style={{ width: `${Math.min(pct, 100)}%`, background: color }} />
      </span>
      <span className="w-9 shrink-0 text-right font-semibold tabular-nums">{Math.round(pct)}%</span>
    </div>
  );
}

/**
 * The lead book as one bar: how far through it this employee is.
 *
 * It used to be three tiles of equal size — Assigned, Completed, Balance — which
 * drew the three numbers as peers. They aren't: Assigned is the whole, and the
 * other two are the parts it splits into. Reading "449 / 16 / 433" you had to
 * work out for yourself that they were related at all, let alone that 16 of 449
 * is under four per cent.
 *
 * So the total leads, in the size that says it's the total, and the split runs
 * underneath it as one bar. The share is the thing the old layout hid, and it's
 * now the thing you see first.
 */
function BookPart({ label, value, share, color, hint }: { label: string; value: number; share: number; color: string; hint?: string }) {
  return (
    <div className="flex items-center gap-2 text-[11.5px]" title={hint}>
      <span className="h-3 w-[3px] shrink-0 rounded-full" style={{ background: color }} />
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto font-semibold tabular-nums">{value.toLocaleString()}</span>
      <span className="w-11 shrink-0 text-right tabular-nums text-muted-foreground">{share.toFixed(1)}%</span>
    </div>
  );
}

/**
 * The book in the dashboard's terms: Contacted and Balance split Assigned
 * exactly as the dashboard's cards do, so the same rep reads the same numbers
 * on both screens. It showed "Completed" — which meant closed, won or lost —
 * and a Balance of assigned − closed: one word, two different numbers across
 * the two screens. Closed is still here, as its own line under the split.
 */
function LeadBook({ assigned, contacted, balance, closed }: LeadBookCounts) {
  // Against the book itself, not against contacted + balance: if those two
  // ever failed to add up, the bar should come up short rather than quietly
  // rescale itself to hide it.
  const pct = (n: number) => (assigned > 0 ? (n / assigned) * 100 : 0);

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="font-display text-[26px] font-semibold leading-none">{assigned.toLocaleString()}</span>
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">leads assigned</span>
      </div>

      {/* One bar, two segments, 2px of card between them so they read as two
          marks rather than one blended strip. Segments carry no text — at four
          per cent there is no room for any — so the counts and shares sit
          underneath, which is also what keeps this readable without colour. */}
      <div className="mt-2.5 flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full bg-muted">
        <span className="h-full rounded-full transition-[width]" style={{ width: `${pct(contacted)}%`, background: CAT.closed_positive.color }} />
        <span className="h-full rounded-full transition-[width]" style={{ width: `${pct(balance)}%`, background: CAT.warm.color }} />
      </div>

      <div className="mt-2.5 space-y-1">
        <BookPart
          label="Contacted"
          value={contacted}
          share={pct(contacted)}
          color={CAT.closed_positive.color}
          hint="Reached: an answered call, or a status of Contacted, Interested or Closed — the dashboard's Contacted"
        />
        <BookPart label="Not contacted yet" value={balance} share={pct(balance)} color={CAT.warm.color} hint="Still owed a first conversation — the dashboard's Balance" />
      </div>
      <div className="mt-2 border-t pt-2">
        <BookPart label="Closed · won or lost" value={closed} share={pct(closed)} color="hsl(var(--muted-foreground))" />
      </div>
    </div>
  );
}

/**
 * Today · Yesterday · This week · This month, one click each — the same
 * filters the calendar builds (lib/quick-ranges). The one in force shows as on;
 * clicking it again goes back to all dates. The range is shared with Calls Made.
 */
function QuickRangeChips({ value, onChange }: { value: DateFilterValue; onChange: (v: DateFilterValue) => void }) {
  const today = businessTodayLocal();
  const active = activeQuickRange(value, today);
  return (
    <div role="group" aria-label="Quick date range" className="inline-flex flex-wrap rounded-md bg-muted/60 p-[2px]">
      {QUICK_RANGES.map((r) => (
        <button
          key={r.value}
          type="button"
          aria-pressed={active === r.value}
          onClick={() => onChange(active === r.value ? EMPTY_DATE_FILTER : quickRange(r.value, today))}
          className={`whitespace-nowrap rounded-[5px] px-2.5 py-[5px] text-[11px] font-semibold transition-colors ${
            active === r.value ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-background hover:text-foreground'
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

/** The Call Outcome filter each mix tile opens in Calls Made. */
const DRILL_BUCKET: Record<string, string> = {
  cold: 'bucket:cold',
  warm: 'bucket:warm',
  hot: 'bucket:hot',
  working: 'bucket:connected',
  closed: 'bucket:closed',
  none: 'bucket:ungrouped',
};

/** How the empty state names the range when it is one of the quick ones. */
const RANGE_WORDS: Record<QuickRange, string> = { today: 'today', yesterday: 'yesterday', week: 'this week', month: 'this month' };

/**
 * Ink for the summary tiles and the dark card bands: the theme's own foreground
 * on its background, so they invert in dark mode. They were a fixed dark olive
 * (#27301d) that all but vanished into the dark card (#232220) — the "Calls
 * made" ratio bar in that colour could not be seen at all.
 */
const INK = 'hsl(var(--foreground))';
const ON_INK = 'hsl(var(--background))';

/**
 * One outcome group in the mix strip. `mark` is the group's colour in the bar
 * above the tiles (the chart tokens, which step for dark mode), shown as a
 * short rail so each tile says which segment is its own.
 */
function Stage({ label, value, sub, color, tint, dark, mark, onClick }: { label: string; value: number; sub: string; color?: string; tint?: string; dark?: boolean; mark?: string; onClick?: () => void }) {
  // A tile with calls behind it opens them in Calls Made.
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick, title: `Open these ${value.toLocaleString()} calls in Calls Made` } : {})}
      className={`min-w-[112px] flex-1 shrink-0 rounded-[9px] px-2.5 py-1.5 text-left ${onClick ? 'transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50' : ''}`}
      style={dark ? { background: INK, color: ON_INK } : { background: tint, color }}
    >
      <div className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider opacity-80">
        {mark && <span aria-hidden className="h-2.5 w-[3px] shrink-0 rounded-full" style={{ background: mark }} />}
        <span className="truncate">{label}</span>
      </div>
      {/* Value and its qualifier share a line — the stage is a glanceable figure,
          and a third row of text was buying height without buying meaning. */}
      <div className="mt-[2px] flex items-baseline gap-1.5">
        <span className="font-display text-[15.5px] font-semibold leading-none">{value.toLocaleString()}</span>
        <span className="truncate text-[9.5px] leading-none opacity-70" title={sub}>{sub}</span>
      </div>
    </Tag>
  );
}

/** One stage of the pipeline palette — mark, band, and text on that band. */
type Cat = { color: string; tint: string; ink: string };

/** Outcomes an admin hasn't put in a group yet (Admin → Outcomes): neutral, so they don't pass for one. */
const NO_GROUP: Cat & { label: string } = { label: 'No group', color: 'hsl(var(--muted-foreground))', tint: 'hsl(var(--muted))', ink: 'hsl(var(--foreground))' };

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
function CardHead({ title, cat, count }: { title: string; cat: Cat; count?: number }) {
  return (
    <>
      {/* A 2px rail of the stage's full-strength mark above its tinted band.
          The tint alone is pale by necessity — it has to hold dark text — so
          the rail is what carries the colour at full saturation and gives the
          row of cards an edge to scan along. */}
      <div className="h-[2px] w-full" style={{ background: cat.color }} />
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ background: cat.tint, color: cat.ink }}
      >
        <h4 className="truncate text-[10.5px] font-bold uppercase tracking-[.09em]">{title}</h4>
        {count !== undefined && (
          // Lifted off the band rather than given its own colour: the band is
          // already carrying the identity, and a second colour here would compete.
          <span className="ml-auto shrink-0 rounded-full bg-white/70 px-2 py-[1px] text-[10.5px] font-bold tabular-nums">
            {count.toLocaleString()}
          </span>
        )}
      </div>
    </>
  );
}

/** One breakdown column: the statuses in a bucket with their counts. */
function Breakdown({ title, cat, rows, total, totalLabel = 'Total', note, onPick }: {
  title: string; cat: Cat; rows: CallStatusCount[]; total: number; totalLabel?: string; note?: string;
  /** Opens a status's calls in Calls Made. */
  onPick?: (slug: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <CardHead title={title} cat={cat} count={total} />
      {note && <p className="border-b px-3 py-1.5 text-[10.5px] text-muted-foreground">{note}</p>}
      <div className="px-3">
        {rows.length === 0 ? (
          <p className="py-3 text-center text-[11px] text-muted-foreground">No statuses in this bucket.</p>
        ) : rows.map((r) => {
          // A status with calls behind it is a button that opens them; a zero
          // has nothing to open and stays plain text.
          const open = onPick && r.count > 0 ? () => onPick(r.slug) : undefined;
          const Tag = open ? 'button' : 'div';
          return (
            // -mx-1.5 px-1.5 so the hover highlight extends into the card's
            // padding instead of stopping short of the text it belongs to.
            <Tag
              key={r.slug}
              {...(open ? { type: 'button' as const, onClick: open, title: `Open these ${r.count.toLocaleString()} calls in Calls Made` } : {})}
              className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-center justify-between gap-3 rounded-md border-b px-1.5 py-1 text-left text-[11.5px] transition-colors last:border-0 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              {/* A zero is quieter, in the theme's muted ink — the fixed grey it
                  used was too faint on the light card. */}
              <span className={`truncate ${r.count > 0 ? '' : 'text-muted-foreground'}`}>{r.name}</span>
              <span className={`shrink-0 tabular-nums ${r.count > 0 ? 'font-semibold' : 'text-muted-foreground'}`}>{r.count}</span>
            </Tag>
          );
        })}
      </div>
      <div className="flex items-center justify-between border-t bg-muted/40 px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-[.07em]">
        <span>{totalLabel}</span>
        <span className="text-[12px] tabular-nums">{total}</span>
      </div>
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
      // The target also shows as "12 / 40" on the dashboard's Team today and on Call Summary.
      qc.invalidateQueries({ queryKey: ['productivity', 'daily-summary'] });
      qc.invalidateQueries({ queryKey: ['daily-summary'] });
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
        <h3 className="mb-3 font-display text-[14px] font-semibold">Call target</h3>
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
/**
 * `onDrill` opens calls in Calls Made, given a Call Outcome filter: a slug, a
 * `bucket:<group>`, or `none` (see the API's CallStatsQueryDto.outcome).
 */
export function CallsAnalytics({ isManager, onDrill }: { isManager: boolean; onDrill?: (outcome: string) => void }) {
  const filters = useCallFilters(isManager);
  const { params, dateFilter, setDateFilter, userId } = filters;
  const [editTarget, setEditTarget] = useState(false);

  const { data: stats } = useQuery({ queryKey: ['calls-made', 'stats', params], queryFn: () => callsApi.madeStats(params) });
  // Keyed on the employee alone — the lead book counts what's held now, so the
  // date range must not send it refetching for an answer that can't change.
  const { data: leads } = useQuery({ queryKey: ['lead-book', userId], queryFn: () => callsApi.leadBook(userId || undefined) });

  const byStatus = useMemo(() => stats?.byStatus ?? [], [stats?.byStatus]);
  const inCat = (c: keyof typeof CAT) => byStatus.filter((s) => s.category === c);
  const given = stats?.given ?? 0;
  const cats = stats?.categories;
  const share = (n: number) => (given > 0 ? (n / given) * 100 : 0);
  // Outcomes with no group (added in Admin → Outcomes without one) count in
  // the total but in no bucket — shown on their own so the groups still add up.
  const ungroupedRows = byStatus.filter((s) => !s.category);
  const ungrouped = ungroupedRows.reduce((n, s) => n + s.count, 0);

  // The outcome groups, in the breakdown columns' order, each with its colour
  // in the mix bar (the chart tokens, which step for dark mode).
  const won = cats?.closedPositive ?? 0;
  const lost = cats?.closedNegative ?? 0;
  const mix: { key: string; label: string; value: number; cat: Cat; mark: string; sub?: string }[] = [
    { key: 'cold', label: CAT.cold.label, value: cats?.cold ?? 0, cat: CAT.cold, mark: 'var(--viz-cold)' },
    { key: 'warm', label: CAT.warm.label, value: cats?.warm ?? 0, cat: CAT.warm, mark: 'var(--viz-warm)' },
    { key: 'hot', label: CAT.hot.label, value: cats?.hot ?? 0, cat: CAT.hot, mark: 'var(--viz-hot)' },
    { key: 'working', label: 'Connected / Follow-ups', value: cats?.connected ?? 0, cat: CAT.connected, mark: 'var(--viz-working)' },
    { key: 'closed', label: 'Closed', value: won + lost, cat: CAT.closed_positive, mark: 'var(--viz-closed)', sub: `${won.toLocaleString()} won · ${lost.toLocaleString()} lost` },
    ...(ungrouped > 0 ? [{ key: 'none', label: NO_GROUP.label, value: ungrouped, cat: NO_GROUP, mark: NO_GROUP.color }] : []),
  ];

  // The same figures for the period just before, the same length — the ▲/▼.
  // Only with both ends of a range: "all dates" has nothing before it.
  const prev = previousRange(dateFilter.from, dateFilter.to);
  const prevParams = prev ? { ...params, from: prev.from, to: prev.to } : null;
  const { data: before } = useQuery({
    queryKey: ['calls-made', 'stats', prevParams],
    queryFn: () => callsApi.madeStats(prevParams!),
    enabled: !!prevParams,
  });
  const delta = (now: number | undefined, was: number | undefined, opts: { upIsGood?: boolean; kind?: 'pct' | 'pts'; format?: (n: number) => string } = {}) =>
    prev && before && now !== undefined && was !== undefined ? kpiDelta(now, was, { ...opts, days: prev.days }) : null;

  // Every status with its group and share — the breakdown below, as a file.
  function exportBreakdown() {
    const groupOf = (c: string | null) =>
      c === 'closed_positive' ? CAT.closed_positive.label : c === 'closed_negative' ? CAT.closed_negative.label
        : c === 'connected' ? 'Connected / Follow-ups' : c && c in CAT ? CAT[c as keyof typeof CAT].label : NO_GROUP.label;
    const range = dateFilter.from && dateFilter.to ? `${dateFilter.from}_${dateFilter.to}` : 'all-dates';
    const who = userId ? filters.users.find((u) => u.id === userId)?.name.replace(/\s+/g, '-').toLowerCase() : null;
    downloadCsv(
      ['calls-analytics', range, who].filter(Boolean).join('-'),
      ['Group', 'Outcome', 'Calls', 'Share of calls with an outcome %'],
      [
        ...byStatus.map((r) => [groupOf(r.category), r.name, r.count, Math.round(share(r.count) * 10) / 10]),
        ['', 'Calls with an outcome', given, ''],
        ['', 'Calls with no outcome', stats?.noOutcome ?? 0, ''],
        ['', 'All calls', stats?.total ?? 0, ''],
      ],
    );
  }

  // One message for a range with no calls, instead of a page of zeroes.
  const empty = !!stats && stats.total === 0;
  const quick = activeQuickRange(dateFilter, businessTodayLocal());

  /* The lead book always has an answer — it counts leads held now, not calls
     in the range — so it shows whether or not the range has any calls. */
  const leadBookCard = (
    <div className="rounded-2xl border bg-card p-5 shadow-sm">
      {/* The lead book always has an answer, so the card leads with it rather
          than sitting empty whenever there's no target to measure against.
          These count leads held now — the date range governs calls, not the
          book — so the heading says which employee's book it is. */}
      <h3 className="mb-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Lead Book <span className="normal-case tracking-normal opacity-70">· current, not date-filtered</span>
      </h3>
      <LeadBook assigned={leads?.assigned ?? 0} contacted={leads?.contacted ?? 0} balance={leads?.balance ?? 0} closed={leads?.closed ?? 0} />

      <div className="mt-3 border-t pt-3">
        {stats?.target ? (
          <div className="flex items-center gap-5">
            <Dial pct={stats.target.metPct} />
            <div className="min-w-0 space-y-1 text-[12px]">
              <div><b className="font-display text-[15.5px]">{stats.target.target.toLocaleString()}</b> <span className="text-muted-foreground">target calls</span></div>
              <div><b className="font-display text-[15.5px]">{stats.target.completed.toLocaleString()}</b> <span className="text-muted-foreground">completed</span></div>
              <div><b className="font-display text-[15.5px]">{stats.target.remaining.toLocaleString()}</b> <span className="text-muted-foreground">remaining</span></div>
              {stats.target.reason && (
                <p className="mt-1.5 rounded-md bg-[var(--tone-red-bg)] px-2.5 py-1 text-[11px] text-[var(--tone-red-fg-2)]">Not achieving — {stats.target.reason}</p>
              )}
            </div>
          </div>
        ) : (
          <p className="py-1 text-center text-[11.5px] text-muted-foreground">
            {dateFilter.mode === 'all'
              ? 'Pick a date range — or Today above — to measure against the call target.'
              : isManager
                ? 'No call target set. Choose an employee, then “Set target”.'
                : 'No call target set for you yet.'}
          </p>
        )}
      </div>
    </div>
  );

  return (
    <div>
      <CallFilterBar filters={filters}>
        <QuickRangeChips value={dateFilter} onChange={setDateFilter} />
        <IconAction icon={Download} label="Export breakdown CSV" onClick={exportBreakdown} disabled={!stats || stats.total === 0} />
        {isManager && userId && (
          <button onClick={() => setEditTarget(true)} className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-2 text-[12px] font-semibold hover:bg-muted">
            <Pencil className="h-3.5 w-3.5" /> Set target
          </button>
        )}
      </CallFilterBar>

      {empty ? (
        <div className="grid gap-[18px] lg:grid-cols-[minmax(280px,1fr)_2fr]">
          {leadBookCard}
          <div className="grid place-items-center rounded-2xl border bg-card p-8 text-center shadow-sm" role="status">
            <div>
              <PhoneOff className="mx-auto mb-2 h-6 w-6 text-muted-foreground" aria-hidden />
              <p className="font-display text-[15px] font-semibold">
                {dateFilter.mode === 'all' ? 'No calls yet' : quick ? `No calls ${RANGE_WORDS[quick]}` : 'No calls in this date range'}
              </p>
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                {dateFilter.mode === 'all'
                  ? 'Calls show up here once they are logged in the Calling Panel.'
                  : 'Pick another range above, or look across all dates.'}
              </p>
              {dateFilter.mode !== 'all' && (
                <button
                  type="button"
                  onClick={() => setDateFilter(EMPTY_DATE_FILTER)}
                  className="mt-3 rounded-md border bg-card px-3 py-1.5 text-[12px] font-semibold hover:bg-muted"
                >
                  Show all dates
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* The range at a glance, each against the period before it (with a
              closed range). "Calls with no outcome" sit outside every bucket
              below, so the funnel can't show them — here they are counted, and
              a click opens them in Calls Made to be dispositioned. */}
          <KpiGrid>
            <KpiCard icon={Phone} iconBg="var(--tone-blue-bg)" iconColor="var(--tone-blue-fg)" value={(stats?.total ?? 0).toLocaleString()} label="Calls" delta={delta(stats?.total, before?.total)} />
            <KpiCard
              icon={PhoneCall}
              iconBg="var(--tone-teal-bg)"
              iconColor="var(--tone-teal-fg)"
              value={`${Math.round(stats?.connectedPct ?? 0)}%`}
              label={`Answered · ${(stats?.connected ?? 0).toLocaleString()} calls`}
              delta={delta(stats?.connectedPct, before?.connectedPct, { kind: 'pts' })}
            />
            <KpiCard
              icon={Clock}
              iconBg="var(--tone-amber-bg)"
              iconColor="var(--tone-amber-fg)"
              value={formatDuration(stats?.totalDurationSecs ?? 0)}
              label="Talk time"
              delta={delta(stats?.totalDurationSecs, before?.totalDurationSecs, { format: formatDuration })}
            />
            {/* No ▲/▼: a longer average call is not better or worse in itself. */}
            <KpiCard icon={Timer} iconBg="var(--tone-neutral-bg)" iconColor="var(--tone-neutral-fg)" value={formatDuration(stats?.avgDurationSecs ?? 0)} label="Avg call" />
            <KpiCard
              icon={FileQuestion}
              iconBg="var(--tone-red-bg)"
              iconColor="var(--tone-red-fg-2)"
              value={(stats?.noOutcome ?? 0).toLocaleString()}
              label="Calls with no outcome"
              delta={delta(stats?.noOutcome, before?.noOutcome, { upIsGood: false })}
              onClick={onDrill && (stats?.noOutcome ?? 0) > 0 ? () => onDrill('none') : undefined}
            />
          </KpiGrid>

          <CallsTrend filters={filters} />

          {isManager && <CallsTeam filters={filters} />}

          {/* How the selected rep's calls split across the chosen aspect. Reads one
              employee at a time, off the same filter bar as everything below it. */}
          <CallsAspects filters={filters} />

          {/* Target attainment + conversion ratios */}
          <div className="mb-[18px] grid gap-[18px] lg:grid-cols-[minmax(280px,1fr)_2fr]">
            {leadBookCard}

            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              {/* In funnel order, each a share of the calls with an outcome. The
                  first bar was labelled "Calls made", but it is the reach rate —
                  every outcome past Cold — not a count of calls (the API still
                  calls the field `callsMade`). The rest ran in no particular order,
                  Lost between Warm and Hot. */}
              <h3 className="mb-3 text-[10.5px] font-semibold uppercase tracking-widest text-muted-foreground">
                Conversion Ratios <span className="normal-case tracking-normal opacity-70">· share of calls with an outcome</span>
              </h3>
              <div className="space-y-2">
                <RatioBar label="Reached" pct={stats?.ratios.callsMade ?? 0} color="hsl(var(--primary))" hint="Someone was reached: every outcome past Cold" />
                <RatioBar label={CAT.warm.label} pct={stats?.ratios.warm ?? 0} color={CAT.warm.color} />
                <RatioBar label={CAT.hot.label} pct={stats?.ratios.hot ?? 0} color={CAT.hot.color} />
                <RatioBar label="Connected / Follow-ups" pct={stats?.ratios.connected ?? 0} color={CAT.connected.color} />
                <RatioBar label={CAT.closed_positive.label} pct={stats?.ratios.closedPositive ?? 0} color={CAT.closed_positive.color} />
                <RatioBar label={CAT.closed_negative.label} pct={stats?.ratios.closedNegative ?? 0} color={CAT.closed_negative.color} />
              </div>
            </div>
          </div>

          {/* The outcome mix: how the calls with an outcome split across the
              groups — the one place the page shows the shape of the range. Compact,
              and sticky to the top of the scroll area so it stays in view while
              the per-status breakdown below is scrolled; overflows to a horizontal
              scroll on narrow screens rather than wrapping.

              It used to run Given Leads → Cold → Warm → Hot → Closed with arrows,
              which read as leads moving from stage to stage. They are separate
              groups of call outcomes — a call is Cold or Warm, it doesn't pass
              through one to the next — so the arrows went, and one segmented bar
              shows the split instead. Connected / Follow-ups was missing from the
              row entirely, so the groups didn't add up to the total; it's in. And
              "Given Leads" counted calls, not leads: a lead called three times is
              three outcomes. A Pipeline Mix ring repeated these same numbers
              below; this bar and these tiles say all it did, so it went. */}
          <div className="sticky top-0 z-20 mb-[18px] rounded-2xl border bg-card px-3.5 py-2.5 shadow-sm">
            {given > 0 && (
              // Each segment's width is its share; the 2px gaps are card showing
              // through, so neighbouring groups read as separate marks. Decorative
              // for assistive tech — every number is written in the tiles below.
              <div aria-hidden className="mb-2 flex h-2 w-full gap-[2px] overflow-hidden rounded-full">
                {mix.filter((m) => m.value > 0).map((m) => (
                  <span
                    key={m.key}
                    title={`${m.label}: ${m.value.toLocaleString()} · ${Math.round(share(m.value))}%`}
                    className="h-full first:rounded-l-full last:rounded-r-full"
                    style={{ flexGrow: m.value, flexBasis: 0, background: m.mark }}
                  />
                ))}
              </div>
            )}
            <div className="flex items-stretch gap-1.5 overflow-x-auto">
              <Stage dark label="Calls with an outcome" value={given} sub={`of ${(stats?.total ?? 0).toLocaleString()} calls`} />
              {mix.map((m) => (
                <Stage
                  key={m.key}
                  label={m.label}
                  value={m.value}
                  sub={m.sub ?? `${Math.round(share(m.value))}% of calls`}
                  color={m.cat.color}
                  tint={m.cat.tint}
                  mark={m.mark}
                  onClick={onDrill && m.value > 0 ? () => onDrill(DRILL_BUCKET[m.key]) : undefined}
                />
              ))}
            </div>
          </div>

          {/* Per-status breakdown, one column per group. A first column listed
              every status again under "Given Leads" — each already sits in its
              group's column — so it went, and the three columns take the width. */}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <div className="space-y-3">
              <Breakdown title={CAT.cold.label} cat={CAT.cold} rows={inCat('cold')} total={cats?.cold ?? 0} onPick={onDrill} />
              {ungroupedRows.length > 0 && (
                <Breakdown title={NO_GROUP.label} cat={NO_GROUP} rows={ungroupedRows} total={ungrouped} note="Give these a group in Admin → Outcomes so they count in one." onPick={onDrill} />
              )}
            </div>
            <div className="space-y-3">
              <Breakdown title={CAT.warm.label} cat={CAT.warm} rows={inCat('warm')} total={cats?.warm ?? 0} onPick={onDrill} />
              <Breakdown title={CAT.hot.label} cat={CAT.hot} rows={inCat('hot')} total={cats?.hot ?? 0} onPick={onDrill} />
            </div>
            <div className="space-y-3">
              <Breakdown title="Connected / Follow-ups" cat={CAT.connected} rows={inCat('connected')} total={cats?.connected ?? 0} onPick={onDrill} />
              {/* Green, matching the Closed tile above. It was rust, which is the
                  Closed-Lost colour — the same bucket wearing two colours. */}
              <Breakdown title="Closed" cat={CAT.closed_positive} rows={[...inCat('closed_positive'), ...inCat('closed_negative')]} total={won + lost} onPick={onDrill} />
            </div>
          </div>
        </>
      )}

      {editTarget && userId && <TargetEditor userId={userId} onDone={() => setEditTarget(false)} />}
    </div>
  );
}
