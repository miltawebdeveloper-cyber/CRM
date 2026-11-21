'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { callsApi, formatDuration, type TeamCallsRow } from '@/lib/crm';
import type { CallFilters } from '@/components/calls-shared';
import { IconAction } from '@/components/icon-action';
import { downloadCsv } from '@/lib/export';
import { usePersistedState } from '@/lib/use-persisted-state';
import { useMediaQuery } from '@/lib/use-media-query';

type SortKey = 'name' | 'calls' | 'answered' | 'warmHot' | 'won' | 'talk' | 'target' | 'noOutcome';
type Sort = { key: SortKey; dir: 'asc' | 'desc' };

/** The rates a row reads as — each against its own base, so reps of different volume compare fairly. */
export function teamRates(r: Pick<TeamCallsRow, 'calls' | 'answered' | 'given' | 'warm' | 'hot' | 'target'>) {
  return {
    /** Answered, of all calls. */
    answeredPct: r.calls > 0 ? (r.answered / r.calls) * 100 : 0,
    /** Warm or hot, of the calls with an outcome — the same base as the conversion ratios. */
    warmHotPct: r.given > 0 ? ((r.warm + r.hot) / r.given) * 100 : 0,
    /** Calls against the range's target; null with no target. */
    targetPct: r.target ? (r.calls / r.target) * 100 : null,
  };
}

const sortValue = (r: TeamCallsRow, key: SortKey): number | string => {
  const rates = teamRates(r);
  switch (key) {
    case 'name': return r.name.toLowerCase();
    case 'calls': return r.calls;
    case 'answered': return rates.answeredPct;
    case 'warmHot': return rates.warmHotPct;
    case 'won': return r.won;
    case 'talk': return r.talkSecs;
    // No target sorts below every target, whichever way.
    case 'target': return rates.targetPct ?? -1;
    case 'noOutcome': return r.noOutcome;
  }
};

export function sortTeam(rows: TeamCallsRow[], sort: Sort): TeamCallsRow[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = sortValue(a, sort.key);
    const y = sortValue(b, sort.key);
    if (x === y) return a.name.localeCompare(b.name);
    return (x > y ? 1 : -1) * sign;
  });
}

const pct = (n: number) => `${Math.round(n)}%`;

const COLUMNS: { key: SortKey; label: string; hint: string; numeric: boolean }[] = [
  { key: 'name', label: 'Rep', hint: 'Click a name to read the page for that rep', numeric: false },
  { key: 'calls', label: 'Calls', hint: 'Calls made in the range', numeric: true },
  { key: 'answered', label: 'Answered', hint: 'Share of calls the customer answered', numeric: true },
  { key: 'warmHot', label: 'Warm & hot', hint: 'Warm or hot outcomes, of the calls with an outcome', numeric: true },
  { key: 'won', label: 'Won', hint: 'Calls logged Closed — Won', numeric: true },
  { key: 'talk', label: 'Talk time', hint: 'Time on the phone', numeric: true },
  { key: 'target', label: 'Target', hint: 'Calls against the daily target × days in the range', numeric: true },
  { key: 'noOutcome', label: 'No outcome', hint: 'Calls with no outcome logged', numeric: true },
];

/**
 * Analytics' team comparison (managers): every rep side by side for the
 * range, sortable on any column, a click on a name filtering the rest of the
 * page to that rep (and again, back to the team). The CSV is the table as shown.
 */
export function CallsTeam({ filters }: { filters: CallFilters }) {
  const { params, userId, setUserId, dateFilter } = filters;
  // The whole team whichever rep the page is on — the comparison is the point.
  const teamParams = useMemo(() => {
    const { userId: _one, ...rest } = params as typeof params & { userId?: string };
    return rest;
  }, [params]);
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['calls-made', 'team', teamParams],
    queryFn: () => callsApi.madeTeam(teamParams),
  });
  const [sort, setSort] = usePersistedState<Sort>('calls-team:sort', { key: 'calls', dir: 'desc' });
  const sorted = useMemo(() => sortTeam(rows, sort), [rows, sort]);

  const team = useMemo(() => {
    const t = rows.reduce(
      (a, r) => ({
        calls: a.calls + r.calls, answered: a.answered + r.answered, given: a.given + r.given, warm: a.warm + r.warm,
        hot: a.hot + r.hot, won: a.won + r.won, talkSecs: a.talkSecs + r.talkSecs, noOutcome: a.noOutcome + r.noOutcome,
        target: r.target ? (a.target ?? 0) + r.target : a.target,
        targetCalls: r.target ? a.targetCalls + r.calls : a.targetCalls,
      }),
      { calls: 0, answered: 0, given: 0, warm: 0, hot: 0, won: 0, talkSecs: 0, noOutcome: 0, target: null as number | null, targetCalls: 0 },
    );
    // The team's target % counts only the reps who have a target: a rep with
    // none adds calls but no target, and would push the team over 100%.
    return { ...t, ...teamRates(t), targetPct: t.target ? (t.targetCalls / t.target) * 100 : null };
  }, [rows]);

  // The same column flips direction; a new one starts biggest-first (names A–Z).
  const toggleSort = (key: SortKey) =>
    setSort(sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' });

  function exportCsv() {
    const range = dateFilter.from && dateFilter.to ? `${dateFilter.from}_${dateFilter.to}` : 'all-dates';
    downloadCsv(
      `calls-team-${range}`,
      ['Rep', 'Calls', 'Answered', 'Answered %', 'Calls with an outcome', 'Warm', 'Hot', 'Warm & hot %', 'Won', 'Lost', 'Talk time', 'Target', 'Target %', 'No outcome'],
      sorted.map((r) => {
        const x = teamRates(r);
        return [
          r.name, r.calls, r.answered, Math.round(x.answeredPct), r.given, r.warm, r.hot, Math.round(x.warmHotPct),
          r.won, r.lost, formatDuration(r.talkSecs), r.target ?? '', x.targetPct === null ? '' : Math.round(x.targetPct), r.noOutcome,
        ];
      }),
    );
  }

  const maxCalls = Math.max(1, ...rows.map((r) => r.calls));
  // Eight columns need about 760px. Below 1280px (where the sidebar leaves
  // less than that) each rep is a card instead, so no column is ever cut off.
  const wide = useMediaQuery('(min-width: 1280px)');

  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border bg-card shadow-sm" aria-label="Team comparison">
      <header className="flex items-start gap-3 px-4 pb-3 pt-4 sm:px-5">
        <div className="min-w-0">
          <h3 className="font-display text-[14px] font-semibold">Team comparison</h3>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">Every rep for the range. Click a name to read the page for that rep{wide ? '; sort on any column' : ''}.</p>
        </div>
        <div className="ml-auto">
          <IconAction icon={Download} label="Export team CSV" align="end" onClick={exportCsv} disabled={rows.length === 0} />
        </div>
      </header>

      {isLoading ? (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">No reps to compare.</p>
      ) : !wide ? (
        <TeamCards rows={sorted} team={team} sort={sort} setSort={setSort} userId={userId} setUserId={setUserId} maxCalls={maxCalls} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[12.5px]">
            <thead>
              <tr className="border-y bg-muted/40 text-[10.5px] uppercase tracking-wider text-muted-foreground">
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className={`whitespace-nowrap px-4 py-2 font-semibold ${c.numeric ? 'text-right' : 'text-left'}`}
                  >
                    <button type="button" onClick={() => toggleSort(c.key)} title={c.hint} className="inline-flex items-center gap-1 uppercase hover:text-foreground">
                      {c.label}
                      <span aria-hidden className={sort.key === c.key ? 'text-foreground' : 'opacity-0'}>{sort.dir === 'asc' ? '▲' : '▼'}</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const x = teamRates(r);
                const on = r.id === userId;
                return (
                  <tr key={r.id} className={`border-b transition-colors last:border-0 ${on ? 'bg-primary/[0.06]' : 'hover:bg-muted/40'}`}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <span
                          aria-hidden
                          className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10.5px] font-semibold ${on ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
                        >
                          {initials(r.name)}
                        </span>
                        <button
                          type="button"
                          aria-pressed={on}
                          onClick={() => setUserId(on ? '' : r.id)}
                          className={`truncate text-left font-semibold hover:underline ${on ? 'text-primary' : ''}`}
                        >
                          {r.name}
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      {/* Volume at a glance: a slim bar against the busiest rep. */}
                      <div className="flex items-center justify-end gap-2.5">
                        <span aria-hidden className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-muted sm:block">
                          <span className="block h-full rounded-full" style={{ width: `${(r.calls / maxCalls) * 100}%`, background: 'var(--chart-1)' }} />
                        </span>
                        <span className="w-10 text-right font-semibold tabular-nums">{r.calls.toLocaleString()}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums" title={`${r.answered.toLocaleString()} of ${r.calls.toLocaleString()} calls`}>{pct(x.answeredPct)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums" title={`${(r.warm + r.hot).toLocaleString()} of ${r.given.toLocaleString()} calls with an outcome`}>{pct(x.warmHotPct)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{r.won.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{formatDuration(r.talkSecs)}</td>
                    <td className="px-4 py-2.5 text-right" title={r.target ? `${r.calls.toLocaleString()} of ${r.target.toLocaleString()} target calls` : 'No target set'}>
                      {x.targetPct === null ? <span className="text-muted-foreground">—</span> : <TargetPill pct={x.targetPct} />}
                    </td>
                    <td className={`px-4 py-2.5 text-right tabular-nums ${r.noOutcome > 0 ? 'font-semibold text-[var(--tone-red-fg-2)]' : 'text-muted-foreground'}`}>
                      {r.noOutcome.toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t bg-muted/40 text-[12px] font-semibold">
                <td className="px-4 py-2.5">Team</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{team.calls.toLocaleString()}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{pct(team.answeredPct)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{pct(team.warmHotPct)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{team.won.toLocaleString()}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{formatDuration(team.talkSecs)}</td>
                <td className="px-4 py-2.5 text-right">{team.targetPct === null ? '—' : <TargetPill pct={team.targetPct} />}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{team.noOutcome.toLocaleString()}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

/** "AM" for Arjun Mehta. */
function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
}

/**
 * Target attainment as a pill: on target (100%+), close (75%+), or behind. The
 * percentage is written in it, so the colour is never the only signal.
 */
function TargetPill({ pct: p }: { pct: number }) {
  const tone =
    p >= 100 ? 'bg-[var(--tone-teal-bg)] text-[var(--tone-teal-fg)]'
      : p >= 75 ? 'bg-[var(--tone-amber-bg)] text-[var(--tone-amber-fg)]'
        : 'bg-[var(--tone-red-bg)] text-[var(--tone-red-fg-2)]';
  return <span className={`inline-flex rounded-full px-2 py-[2px] text-[11px] font-semibold tabular-nums ${tone}`}>{pct(p)}</span>;
}

/**
 * The team below 1280px: one card per rep, the same figures as the table's
 * columns, in the same sort. Sorting is a picker plus a direction toggle,
 * since there are no column headings to click.
 */
function TeamCards({ rows, team, sort, setSort, userId, setUserId, maxCalls }: {
  rows: TeamCallsRow[];
  team: { calls: number; answeredPct: number; won: number; talkSecs: number; targetPct: number | null };
  sort: Sort;
  setSort: (s: Sort) => void;
  userId: string;
  setUserId: (id: string) => void;
  maxCalls: number;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 border-y bg-muted/40 px-4 py-2 text-[11.5px] sm:px-5">
        <label htmlFor="team-sort" className="text-muted-foreground">Sort by</label>
        <select
          id="team-sort"
          value={sort.key}
          onChange={(e) => {
            const key = e.target.value as SortKey;
            setSort({ key, dir: key === 'name' ? 'asc' : 'desc' });
          }}
          className="rounded-md border bg-card px-2 py-1 text-[12px] font-medium"
        >
          {COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.key === 'name' ? 'Name' : c.label}</option>)}
        </select>
        <button
          type="button"
          onClick={() => setSort({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
          aria-label={sort.dir === 'asc' ? 'Ascending, switch to descending' : 'Descending, switch to ascending'}
          className="grid h-7 w-7 place-items-center rounded-md border bg-card text-[11px] hover:bg-muted"
        >
          <span aria-hidden>{sort.dir === 'asc' ? '▲' : '▼'}</span>
        </button>
      </div>
      <ul className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
        {rows.map((r) => {
          const x = teamRates(r);
          const on = r.id === userId;
          return (
            <li key={r.id} className={`rounded-xl border p-3.5 ${on ? 'border-primary/50 bg-primary/[0.06]' : ''}`}>
              <div className="flex items-center gap-2.5">
                <span aria-hidden className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${on ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                  {initials(r.name)}
                </span>
                <button type="button" aria-pressed={on} onClick={() => setUserId(on ? '' : r.id)} className={`min-w-0 truncate text-left text-[13px] font-semibold hover:underline ${on ? 'text-primary' : ''}`}>
                  {r.name}
                </button>
                <span className="ml-auto shrink-0 text-right">
                  <span className="font-display text-[18px] font-semibold leading-none tabular-nums">{r.calls.toLocaleString()}</span>
                  <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">calls</span>
                </span>
              </div>
              <span aria-hidden className="mt-2.5 block h-1.5 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full" style={{ width: `${(r.calls / maxCalls) * 100}%`, background: 'var(--chart-1)' }} />
              </span>
              <dl className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2.5 text-[12px]">
                <Metric label="Answered" value={pct(x.answeredPct)} />
                <Metric label="Warm & hot" value={pct(x.warmHotPct)} />
                <Metric label="Won" value={r.won.toLocaleString()} />
                <Metric label="Talk time" value={formatDuration(r.talkSecs)} />
                <Metric label="Target" value={x.targetPct === null ? <span className="text-muted-foreground">—</span> : <TargetPill pct={x.targetPct} />} />
                <Metric
                  label="No outcome"
                  value={<span className={r.noOutcome > 0 ? 'text-[var(--tone-red-fg-2)]' : 'text-muted-foreground'}>{r.noOutcome.toLocaleString()}</span>}
                />
              </dl>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-muted/40 px-4 py-2.5 text-[12px] sm:px-5">
        <b>Team</b>
        <span><b className="tabular-nums">{team.calls.toLocaleString()}</b> <span className="text-muted-foreground">calls</span></span>
        <span><b className="tabular-nums">{pct(team.answeredPct)}</b> <span className="text-muted-foreground">answered</span></span>
        <span><b className="tabular-nums">{team.won.toLocaleString()}</b> <span className="text-muted-foreground">won</span></span>
        <span><b className="tabular-nums">{formatDuration(team.talkSecs)}</b> <span className="text-muted-foreground">talk</span></span>
        {team.targetPct !== null && (
          <span className="inline-flex items-center gap-1.5"><TargetPill pct={team.targetPct} /> <span className="text-muted-foreground">of target</span></span>
        )}
      </div>
    </div>
  );
}

/** One figure on a rep's card. */
function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
