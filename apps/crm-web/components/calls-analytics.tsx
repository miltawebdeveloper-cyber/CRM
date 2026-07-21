'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
        <circle cx="40" cy="40" r={r} fill="none" stroke="#eceef4" strokeWidth="9" />
        <circle
          cx="40" cy="40" r={r} fill="none" stroke="#6366f1" strokeWidth="9" strokeLinecap="round"
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
      className="min-w-[124px] flex-1 rounded-[10px] px-3 py-2"
      style={dark ? { background: '#27301d', color: '#fff' } : { background: tint, color }}
    >
      <div className="text-[9.5px] font-semibold uppercase tracking-wider opacity-80">{label}</div>
      {/* Value and its qualifier share a line — the stage is a glanceable figure,
          and a third row of text was buying height without buying meaning. */}
      <div className="mt-[3px] flex items-baseline gap-1.5">
        <span className="font-display text-[19px] font-semibold leading-none">{value.toLocaleString()}</span>
        <span className="truncate text-[10px] leading-none opacity-70" title={sub}>{sub}</span>
      </div>
    </div>
  );
}

/** One breakdown column: the statuses in a bucket with their counts. */
function Breakdown({ title, color, rows, total, totalLabel = 'Total' }: {
  title: string; color: string; rows: CallStatusCount[]; total: number; totalLabel?: string;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        <h4 className="text-[13px] font-semibold">{title}</h4>
      </div>
      <div className="px-4 py-1.5">
        {rows.length === 0 ? (
          <p className="py-4 text-center text-[12px] text-muted-foreground">No statuses in this bucket.</p>
        ) : rows.map((r) => (
          <div key={r.slug} className="flex items-center justify-between gap-3 border-b py-1.5 text-[12.5px] last:border-0">
            <span className="truncate" style={{ color: r.count > 0 ? undefined : '#9aa08e' }}>{r.name}</span>
            <span className={`shrink-0 tabular-nums ${r.count > 0 ? 'font-semibold' : 'text-muted-foreground'}`}>{r.count}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t px-4 py-2 text-[12.5px] font-semibold">
        <span>{totalLabel}</span>
        <span className="tabular-nums">{total}</span>
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

      {/* Cold → Warm → Hot → Closed */}
      <div className="mb-[18px] rounded-2xl border bg-card p-3.5 shadow-sm">
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Lead Pipeline</h3>
        <div className="flex flex-wrap items-stretch gap-2">
          <Stage dark label="Given Leads" value={given} sub={stats?.target ? `of ${stats.target.target.toLocaleString()} target` : 'with an outcome'} />
          <div className="grid place-items-center text-[11px] text-muted-foreground/50">→</div>
          <Stage label="Cold" value={cats?.cold ?? 0} sub={`${Math.round(stats?.coldPct ?? 0)}% of leads`} color={CAT.cold.color} tint={CAT.cold.tint} />
          <div className="grid place-items-center text-[11px] text-muted-foreground/50">→</div>
          <Stage label="Warm" value={cats?.warm ?? 0} sub={`${Math.round(stats?.ratios.warm ?? 0)}% of leads`} color={CAT.warm.color} tint={CAT.warm.tint} />
          <div className="grid place-items-center text-[11px] text-muted-foreground/50">→</div>
          <Stage label="Hot" value={cats?.hot ?? 0} sub={`${Math.round(stats?.ratios.hot ?? 0)}% of leads`} color={CAT.hot.color} tint={CAT.hot.tint} />
          <div className="grid place-items-center text-[11px] text-muted-foreground/50">→</div>
          <Stage dark label="Closed" value={(cats?.closedPositive ?? 0) + (cats?.closedNegative ?? 0)} sub={`${cats?.closedPositive ?? 0} won · ${cats?.closedNegative ?? 0} lost`} />
        </div>
      </div>

      {/* Per-status breakdown, bucket by bucket */}
      <div className="grid gap-[18px] md:grid-cols-2 xl:grid-cols-4">
        <Breakdown title="Given Leads" color="#27301d" rows={byStatus} total={given} />
        <Breakdown title={CAT.cold.label} color={CAT.cold.color} rows={inCat('cold')} total={cats?.cold ?? 0} />
        <div className="space-y-[18px]">
          <Breakdown title={CAT.warm.label} color={CAT.warm.color} rows={inCat('warm')} total={cats?.warm ?? 0} />
          <Breakdown title={CAT.hot.label} color={CAT.hot.color} rows={inCat('hot')} total={cats?.hot ?? 0} />
        </div>
        <div className="space-y-[18px]">
          <Breakdown title="Connected / Follow-ups" color={CAT.connected.color} rows={inCat('connected')} total={cats?.connected ?? 0} />
          <Breakdown title="Closed" color={CAT.closed_negative.color} rows={[...inCat('closed_positive'), ...inCat('closed_negative')]} total={(cats?.closedPositive ?? 0) + (cats?.closedNegative ?? 0)} />
        </div>
      </div>

      {editTarget && userId && <TargetEditor userId={userId} onDone={() => setEditTarget(false)} />}
    </div>
  );
}
