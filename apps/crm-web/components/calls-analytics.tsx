'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Clock, Download, FileQuestion, Pencil, Phone, PhoneCall, PhoneOff, Timer, type LucideIcon } from 'lucide-react';
import { callsApi, formatDuration, type CallStatusCount, type LeadBook as LeadBookCounts } from '@/lib/crm';
import { CallFilterBar, useCallFilters } from '@/components/calls-shared';
import { CallsAspects } from '@/components/calls-aspects';
import { CallsTrend } from '@/components/calls-trend';
import { CallsTeam } from '@/components/calls-team';
import { IconAction } from '@/components/icon-action';
import { kpiDelta, type KpiDelta } from '@/lib/kpi-delta';
import { previousRange } from '@/lib/previous-range';
import { downloadCsv } from '@/lib/export';
import { EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';
import { businessTodayLocal } from '@/lib/business-day';
import { QUICK_RANGES, activeQuickRange, quickRange, type QuickRange } from '@/lib/quick-ranges';

/**
 * The outcome groups, in funnel order, each with its chart colour.
 *
 * Every colour here is a theme token that steps for dark mode (`--viz-*`,
 * globals.css — the validated chart palette). The page used to tint whole
 * bands and tiles with fixed light pastels, which stayed light on the dark
 * card and left their headings all but unreadable; the colour now rides on a
 * dot, a bar or a segment, and everything else is the card's own surface.
 */
const GROUPS = [
  { key: 'cold', label: 'Cold', drill: 'bucket:cold', color: 'var(--viz-cold)', cats: ['cold'] },
  { key: 'warm', label: 'Warm', drill: 'bucket:warm', color: 'var(--viz-warm)', cats: ['warm'] },
  { key: 'hot', label: 'Hot', drill: 'bucket:hot', color: 'var(--viz-hot)', cats: ['hot'] },
  { key: 'connected', label: 'Connected / Follow-ups', drill: 'bucket:connected', color: 'var(--viz-working)', cats: ['connected'] },
  { key: 'closed', label: 'Closed', drill: 'bucket:closed', color: 'var(--viz-closed)', cats: ['closed_positive', 'closed_negative'] },
] as const;

/** Outcomes an admin hasn't put in a group yet (Admin → Outcomes): neutral, so they don't pass for one. */
const NO_GROUP = { key: 'none', label: 'No group', drill: 'bucket:ungrouped', color: 'hsl(var(--muted-foreground))' } as const;

/** How the empty state names the range when it is one of the quick ones. */
const RANGE_WORDS: Record<QuickRange, string> = { today: 'today', yesterday: 'yesterday', week: 'this week', month: 'this month' };

// ── Building blocks ─────────────────────────────────────────────────────────

/** A titled card — every section of the tab sits in one, so the page reads as one system. */
function Panel({ title, subtitle, action, children, className = '' }: { title: string; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    // min-w-0: a grid cell may not shrink below its content by default, and a
    // chart sizes itself to its cell — so once drawn wide it held the cell open
    // and ran into the next panel (the trend at 1280px).
    <section aria-label={title} className={`flex min-w-0 flex-col rounded-2xl border bg-card p-4 shadow-sm sm:p-5 ${className}`}>
      <header className="mb-3 flex items-start gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-[14px] font-semibold">{title}</h3>
          {subtitle && <p className="mt-0.5 text-[11.5px] text-muted-foreground">{subtitle}</p>}
        </div>
        {action && <div className="ml-auto shrink-0">{action}</div>}
      </header>
      {children}
    </section>
  );
}

const DELTA_TONE: Record<KpiDelta['tone'], string> = {
  better: 'bg-[var(--tone-teal-bg)] text-[var(--tone-teal-fg)]',
  worse: 'bg-[var(--tone-red-bg)] text-[var(--tone-red-fg-2)]',
  same: 'bg-muted text-muted-foreground',
};
const ARROW: Record<KpiDelta['direction'], string> = { up: '▲', down: '▼', flat: '=' };

/** ▲ 12% against the previous period, coloured by better / worse — never by direction alone. */
function DeltaPill({ delta }: { delta: KpiDelta }) {
  return (
    <span title={delta.title} className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-[1px] text-[10.5px] font-semibold leading-tight ${DELTA_TONE[delta.tone]}`}>
      <span aria-hidden>{ARROW[delta.direction]}</span>
      {delta.text}
      <span className="sr-only">, {delta.title}</span>
    </span>
  );
}

/** One figure in the overview band. With `onClick` the whole cell opens the calls behind it. */
function Stat({ icon: Icon, label, value, sub, delta, onClick, alert, className = '' }: {
  icon: LucideIcon; label: string; value: string; sub: ReactNode; delta?: KpiDelta | null; onClick?: () => void; alert?: boolean; className?: string;
}) {
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className={`h-3.5 w-3.5 ${alert ? 'text-[var(--tone-red-fg-2)]' : ''}`} aria-hidden />
        {label}
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={`font-display text-[22px] font-semibold leading-none tracking-tight sm:text-[26px] ${alert ? 'text-[var(--tone-red-fg-2)]' : ''}`}>{value}</span>
        {delta && <DeltaPill delta={delta} />}
      </div>
      <div className="mt-1.5 truncate text-[11.5px] text-muted-foreground">{sub}</div>
    </>
  );
  const cell = `min-w-0 bg-card px-4 py-3.5 text-left sm:px-5 sm:py-4 ${className}`;
  return onClick ? (
    <button type="button" onClick={onClick} className={`${cell} group transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50`}>
      {body}
    </button>
  ) : (
    <div className={cell}>{body}</div>
  );
}

/** A segmented bar: each part's width is its share; 2px of card between parts. Decorative — the numbers are written beside it. */
function SegmentBar({ parts, className = 'h-2.5' }: { parts: { key: string; label: string; value: number; color: string; share: number }[]; className?: string }) {
  return (
    <div aria-hidden className={`flex w-full gap-[2px] overflow-hidden rounded-full bg-muted ${className}`}>
      {parts.filter((p) => p.value > 0).map((p) => (
        <span
          key={p.key}
          title={`${p.label}: ${p.value.toLocaleString()} · ${Math.round(p.share)}%`}
          className="h-full first:rounded-l-full last:rounded-r-full"
          style={{ flexGrow: p.value, flexBasis: 0, background: p.color }}
        />
      ))}
    </div>
  );
}

/** Target dial: completed vs target as a ring, in the brand colour. */
function Dial({ pct }: { pct: number }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const filled = Math.min(pct, 100) / 100;
  return (
    <div className="relative grid h-[92px] w-[92px] shrink-0 place-items-center">
      <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90" aria-hidden>
        <circle cx="40" cy="40" r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth="8" />
        <circle cx="40" cy="40" r={r} fill="none" stroke="hsl(var(--primary))" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${c * filled} ${c}`} />
      </svg>
      <div className="absolute text-center">
        <div className="font-display text-[17px] font-semibold leading-none">{Math.round(pct)}%</div>
        <div className="mt-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">met</div>
      </div>
    </div>
  );
}

/** A labelled line of the lead book: mark, label, count, share. */
function BookPart({ label, value, share, color, hint }: { label: string; value: number; share: number; color: string; hint?: string }) {
  return (
    <div className="flex items-center gap-2 text-[12px]" title={hint}>
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto font-semibold tabular-nums">{value.toLocaleString()}</span>
      <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">{share.toFixed(1)}%</span>
    </div>
  );
}

/**
 * The book in the dashboard's terms: Contacted and Not contacted yet split
 * Assigned exactly as the dashboard's Contacted and Balance cards do, and
 * Closed (won or lost) is its own line under the split.
 */
function LeadBook({ assigned, contacted, balance, closed }: LeadBookCounts) {
  // Against the book itself, not contacted + balance: if those ever failed to
  // add up, the bar should come up short rather than rescale to hide it.
  const pct = (n: number) => (assigned > 0 ? (n / assigned) * 100 : 0);
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="font-display text-[30px] font-semibold leading-none tracking-tight">{assigned.toLocaleString()}</span>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">leads assigned</span>
      </div>
      <SegmentBar
        className="mt-3 h-2.5"
        parts={[
          { key: 'contacted', label: 'Contacted', value: contacted, share: pct(contacted), color: 'var(--viz-closed)' },
          { key: 'balance', label: 'Not contacted yet', value: balance, share: pct(balance), color: 'var(--viz-warm)' },
        ]}
      />
      <div className="mt-3 space-y-1.5">
        <BookPart label="Contacted" value={contacted} share={pct(contacted)} color="var(--viz-closed)" hint="Reached: an answered call, or a status of Contacted, Interested or Closed — the dashboard's Contacted" />
        <BookPart label="Not contacted yet" value={balance} share={pct(balance)} color="var(--viz-warm)" hint="Still owed a first conversation — the dashboard's Balance" />
      </div>
      <div className="mt-2.5 border-t pt-2.5">
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
    <div role="group" aria-label="Quick date range" className="inline-flex flex-wrap rounded-lg border bg-card p-[3px] shadow-sm">
      {QUICK_RANGES.map((r) => (
        <button
          key={r.value}
          type="button"
          aria-pressed={active === r.value}
          onClick={() => onChange(active === r.value ? EMPTY_DATE_FILTER : quickRange(r.value, today))}
          className={`whitespace-nowrap rounded-md px-3 py-[5px] text-[11.5px] font-semibold transition-colors ${
            active === r.value ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

/** One group's statuses with their counts. A status with calls opens them in Calls Made. */
function GroupBlock({ label, color, rows, total, note, onPick }: {
  label: string; color: string; rows: CallStatusCount[]; total: number; note?: string; onPick?: (slug: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
        <h4 className="truncate text-[12px] font-semibold">{label}</h4>
        <span className="ml-auto shrink-0 rounded-full bg-background px-2 py-[1px] text-[11px] font-semibold tabular-nums">{total.toLocaleString()}</span>
      </div>
      {note && <p className="border-b px-3 py-1.5 text-[11px] text-muted-foreground">{note}</p>}
      <div className="px-1.5 py-1">
        {rows.length === 0 ? (
          <p className="py-3 text-center text-[11.5px] text-muted-foreground">No statuses in this group.</p>
        ) : rows.map((r) => {
          const open = onPick && r.count > 0 ? () => onPick(r.slug) : undefined;
          const Tag = open ? 'button' : 'div';
          return (
            <Tag
              key={r.slug}
              {...(open ? { type: 'button' as const, onClick: open, title: `Open these ${r.count.toLocaleString()} calls in Calls Made` } : {})}
              className="flex w-full items-center justify-between gap-3 rounded-md px-1.5 py-1.5 text-left text-[12px] transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              <span className={`truncate ${r.count > 0 ? '' : 'text-muted-foreground'}`}>{r.name}</span>
              <span className={`shrink-0 tabular-nums ${r.count > 0 ? 'font-semibold' : 'text-muted-foreground'}`}>{r.count.toLocaleString()}</span>
            </Tag>
          );
        })}
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

// ── The tab ─────────────────────────────────────────────────────────────────

/**
 * Analytics — how the calls in the range performed.
 *
 * Read top to bottom: the overview band (the range at a glance, each figure
 * against the period before it); the trend beside the outcome mix; the team
 * side by side (managers); the lead book and the call target; every outcome
 * in detail; and an explorer for any other cut. Each number appears once —
 * the page used to show the outcome split four times over (ratios, a tile
 * strip, a ring and a chart) — and every colour is a theme token, so dark mode
 * reads as well as light.
 *
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

  const byStatus = useMemo(() => stats?.byStatus ?? [], [stats?.byStatus]);
  const given = stats?.given ?? 0;
  const share = (n: number) => (given > 0 ? (n / given) * 100 : 0);
  const won = stats?.categories.closedPositive ?? 0;
  const lost = stats?.categories.closedNegative ?? 0;

  // Each group's statuses and total. Outcomes with no group count in the total
  // but in no group, so they get their own line and block when there are any.
  const groups = useMemo(() => {
    const list = GROUPS.map((g) => {
      const rows = byStatus.filter((s) => s.category && (g.cats as readonly string[]).includes(s.category));
      return { ...g, rows, value: rows.reduce((n, r) => n + r.count, 0) };
    });
    const ungrouped = byStatus.filter((s) => !s.category);
    return ungrouped.length
      ? [...list, { ...NO_GROUP, cats: [] as readonly string[], rows: ungrouped, value: ungrouped.reduce((n, r) => n + r.count, 0) }]
      : list;
  }, [byStatus]);
  const group = (key: string) => groups.find((g) => g.key === key)!;
  const parts = groups.map((g) => ({ key: g.key, label: g.label, value: g.value, color: g.color, share: share(g.value) }));

  // Every status with its group and share — the detail, as a file.
  function exportBreakdown() {
    const groupOf = (c: string | null) => groups.find((g) => (c ? (g.cats as readonly string[]).includes(c) : g.key === 'none'))?.label ?? NO_GROUP.label;
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
  // A single day has no trend to draw; its row gives the space to the mix.
  const oneDay = !!dateFilter.from && dateFilter.from === dateFilter.to;

  const leadBook = (
    <Panel title="Lead book" subtitle="Leads held now — not date-filtered">
      <LeadBook assigned={leads?.assigned ?? 0} contacted={leads?.contacted ?? 0} balance={leads?.balance ?? 0} closed={leads?.closed ?? 0} />
    </Panel>
  );

  const targetPanel = (
    <Panel
      title="Call target"
      subtitle={stats?.target ? 'Calls against the daily target for this range' : 'Daily calls, scaled to the range'}
      action={isManager && userId ? (
        <button onClick={() => setEditTarget(true)} className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-[11.5px] font-semibold hover:bg-muted">
          <Pencil className="h-3.5 w-3.5" /> Set target
        </button>
      ) : undefined}
    >
      {stats?.target ? (
        <div className="flex items-center gap-5">
          <Dial pct={stats.target.metPct} />
          <div className="min-w-0 space-y-1.5 text-[12px]">
            <div><b className="font-display text-[17px]">{stats.target.target.toLocaleString()}</b> <span className="text-muted-foreground">target calls</span></div>
            <div><b className="font-display text-[17px]">{stats.target.completed.toLocaleString()}</b> <span className="text-muted-foreground">completed</span></div>
            <div><b className="font-display text-[17px]">{stats.target.remaining.toLocaleString()}</b> <span className="text-muted-foreground">remaining</span></div>
            {stats.target.reason && (
              <p className="mt-1.5 rounded-md bg-[var(--tone-red-bg)] px-2.5 py-1 text-[11px] text-[var(--tone-red-fg-2)]">Not achieving — {stats.target.reason}</p>
            )}
          </div>
        </div>
      ) : (
        <p className="grid flex-1 place-items-center py-6 text-center text-[12px] text-muted-foreground">
          {dateFilter.mode === 'all'
            ? 'Pick a date range — or Today above — to measure against the call target.'
            : isManager
              ? userId ? 'No call target set for this rep yet.' : 'No call target set. Pick a rep, then “Set target”.'
              : 'No call target set for you yet.'}
        </p>
      )}
    </Panel>
  );

  const mixPanel = (
    <Panel
      title="Outcome mix"
      subtitle={`${given.toLocaleString()} of ${(stats?.total ?? 0).toLocaleString()} calls have an outcome`}
    >
      {/* The headline rate: every outcome past Cold. It was a bar labelled
          "Calls made", which it never measured. */}
      <div className="mb-3 flex items-baseline gap-2" title="Someone was reached: every outcome past Cold">
        <span className="font-display text-[30px] font-semibold leading-none tracking-tight">{Math.round(stats?.ratios.callsMade ?? 0)}%</span>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Reached</span>
      </div>
      <SegmentBar parts={parts} />
      <ul className="mt-3 space-y-0.5">
        {parts.map((p) => {
          const g = group(p.key);
          const open = onDrill && p.value > 0 ? () => onDrill(g.drill) : undefined;
          const Tag = open ? 'button' : 'div';
          return (
            <li key={p.key}>
              <Tag
                {...(open ? { type: 'button' as const, onClick: open, title: `Open these ${p.value.toLocaleString()} calls in Calls Made` } : {})}
                className="grid w-full grid-cols-[auto_1fr_auto_auto] items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: p.color }} aria-hidden />
                <span className="min-w-0 truncate">
                  {p.label}
                  {p.key === 'closed' && <span className="text-muted-foreground"> · {won.toLocaleString()} won · {lost.toLocaleString()} lost</span>}
                </span>
                <span className="font-semibold tabular-nums">{p.value.toLocaleString()}</span>
                <span className="w-10 text-right tabular-nums text-muted-foreground">{Math.round(p.share)}%</span>
              </Tag>
            </li>
          );
        })}
      </ul>
    </Panel>
  );

  return (
    <div className="space-y-4">
      <CallFilterBar filters={filters}>
        <QuickRangeChips value={dateFilter} onChange={setDateFilter} />
        <div className="ml-auto">
          <IconAction icon={Download} label="Export breakdown CSV" align="end" onClick={exportBreakdown} disabled={!stats || stats.total === 0} />
        </div>
      </CallFilterBar>

      {empty ? (
        <div className="grid gap-4 md:grid-cols-[minmax(260px,1fr)_2fr]">
          {leadBook}
          <section className="grid place-items-center rounded-2xl border bg-card p-10 text-center shadow-sm" role="status">
            <div>
              <span className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-full bg-muted">
                <PhoneOff className="h-5 w-5 text-muted-foreground" aria-hidden />
              </span>
              <p className="font-display text-[16px] font-semibold">
                {dateFilter.mode === 'all' ? 'No calls yet' : quick ? `No calls ${RANGE_WORDS[quick]}` : 'No calls in this date range'}
              </p>
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                {dateFilter.mode === 'all' ? 'Calls show up here once they are logged in the Calling Panel.' : 'Pick another range above, or look across all dates.'}
              </p>
              {dateFilter.mode !== 'all' && (
                <button type="button" onClick={() => setDateFilter(EMPTY_DATE_FILTER)} className="mt-4 rounded-md border bg-card px-3 py-1.5 text-[12px] font-semibold hover:bg-muted">
                  Show all dates
                </button>
              )}
            </div>
          </section>
        </div>
      ) : (
        <>
          {/* ── Overview: one band, hairline dividers from the 1px gaps. Five
              across from lg, so the last figure never drops to a row of its own. */}
          {/* Every arrangement fills its rows, so the 1px gaps never show an empty
              grey cell: 2 + 2 + 1 full-width on a phone, 3 + 2 from tablet, and 5
              across only from 1280px, where the sidebar leaves room for them. */}
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border bg-border shadow-sm md:grid-cols-6 xl:grid-cols-5" aria-label="Overview">
            <Stat className="md:col-span-2 xl:col-span-1" icon={Phone} label="Calls" value={(stats?.total ?? 0).toLocaleString()} sub={`${(stats?.outgoing ?? 0).toLocaleString()} out · ${(stats?.incoming ?? 0).toLocaleString()} in`} delta={delta(stats?.total, before?.total)} />
            <Stat className="md:col-span-2 xl:col-span-1" icon={PhoneCall} label="Answered" value={`${Math.round(stats?.connectedPct ?? 0)}%`} sub={`${(stats?.connected ?? 0).toLocaleString()} of ${(stats?.total ?? 0).toLocaleString()} calls`} delta={delta(stats?.connectedPct, before?.connectedPct, { kind: 'pts' })} />
            <Stat className="md:col-span-2 xl:col-span-1" icon={Clock} label="Talk time" value={formatDuration(stats?.totalDurationSecs ?? 0)} sub="Time on the phone" delta={delta(stats?.totalDurationSecs, before?.totalDurationSecs, { format: formatDuration })} />
            {/* No ▲/▼: a longer average call is not better or worse in itself. */}
            <Stat className="md:col-span-3 xl:col-span-1" icon={Timer} label="Avg call" value={formatDuration(stats?.avgDurationSecs ?? 0)} sub="Per call" />
            <Stat
              className="col-span-2 md:col-span-3 xl:col-span-1"
              icon={FileQuestion}
              label="No outcome"
              value={(stats?.noOutcome ?? 0).toLocaleString()}
              alert={(stats?.noOutcome ?? 0) > 0}
              sub={(stats?.noOutcome ?? 0) > 0 ? (
                <span className="inline-flex items-center gap-1 font-medium text-foreground group-hover:underline">
                  Calls with no outcome {onDrill && <ArrowRight className="h-3 w-3" aria-hidden />}
                </span>
              ) : 'Every call has an outcome'}
              delta={delta(stats?.noOutcome, before?.noOutcome, { upIsGood: false })}
              onClick={onDrill && (stats?.noOutcome ?? 0) > 0 ? () => onDrill('none') : undefined}
            />
          </div>

          {/* ── Trend beside the mix; on a single day, the mix beside the book and target. */}
          {oneDay ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <div className="flex min-w-0 md:col-span-2 xl:col-span-1 [&>section]:w-full">{mixPanel}</div>
              {leadBook}
              {targetPanel}
            </div>
          ) : (
            <>
              <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <CallsTrend filters={filters} />
                {mixPanel}
              </div>
            </>
          )}

          {isManager && <CallsTeam filters={filters} />}

          {!oneDay && (
            <div className="grid gap-4 md:grid-cols-2">
              {leadBook}
              {targetPanel}
            </div>
          )}

          {/* ── Every outcome, by group; a status with calls opens them. */}
          <Panel title="Outcomes in detail" subtitle="Every status, by group. Click one to open its calls in Calls Made.">
            {/* Balanced columns: each block drops into the shortest column, so
                there's no hole at any width — one column on a phone, two from
                tablet, three from 1280px. */}
            <div className="-mb-3 columns-1 gap-3 md:columns-2 xl:columns-3 [&>*]:mb-3 [&>*]:break-inside-avoid">
              {[...GROUPS.map((g) => g.key), ...(groups.some((g) => g.key === 'none') ? ['none'] : [])].map((key) => {
                const g = group(key);
                return (
                  <GroupBlock
                    key={key}
                    label={g.label}
                    color={g.color}
                    rows={g.rows}
                    total={g.value}
                    note={key === 'none' ? 'Give these a group in Admin → Outcomes so they count in one.' : undefined}
                    onPick={onDrill}
                  />
                );
              })}
            </div>
          </Panel>

          {/* ── Any other cut of the same calls: by hour, weekday, rep, direction… */}
          <CallsAspects filters={filters} />
        </>
      )}

      {editTarget && userId && <TargetEditor userId={userId} onDone={() => setEditTarget(false)} />}
    </div>
  );
}
