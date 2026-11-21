'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { callsApi, formatDuration, type TeamCallsRow } from '@/lib/crm';
import type { CallFilters } from '@/components/calls-shared';
import { IconAction } from '@/components/icon-action';
import { downloadCsv } from '@/lib/export';
import { usePersistedState } from '@/lib/use-persisted-state';

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

  return (
    <section className="mb-[18px] overflow-hidden rounded-2xl border bg-card shadow-sm" aria-label="Team comparison">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h3 className="font-display text-[14px] font-semibold">Team comparison</h3>
          <p className="text-[11px] text-muted-foreground">Every rep for the range. Click a name to read the page for that rep.</p>
        </div>
        <div className="ml-auto">
          <IconAction icon={Download} label="Export team CSV" onClick={exportCsv} disabled={rows.length === 0} />
        </div>
      </div>

      {isLoading ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">No reps to compare.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b text-[11px] text-muted-foreground">
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className={`whitespace-nowrap px-3 py-2 font-medium ${c.numeric ? 'text-right' : 'text-left'}`}
                  >
                    <button type="button" onClick={() => toggleSort(c.key)} title={c.hint} className="inline-flex items-center gap-1 hover:text-foreground">
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
                  <tr key={r.id} className={`border-b last:border-0 ${on ? 'bg-primary/5' : 'hover:bg-muted/40'}`}>
                    <td className="px-3 py-1.5">
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => setUserId(on ? '' : r.id)}
                        className={`text-left font-medium hover:underline ${on ? 'text-primary' : ''}`}
                      >
                        {r.name}
                      </button>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.calls.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums" title={`${r.answered.toLocaleString()} of ${r.calls.toLocaleString()} calls`}>{pct(x.answeredPct)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums" title={`${(r.warm + r.hot).toLocaleString()} of ${r.given.toLocaleString()} calls with an outcome`}>{pct(x.warmHotPct)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.won.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatDuration(r.talkSecs)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums" title={r.target ? `${r.calls.toLocaleString()} of ${r.target.toLocaleString()} target calls` : 'No target set'}>
                      {x.targetPct === null ? <span className="text-muted-foreground">—</span> : pct(x.targetPct)}
                    </td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${r.noOutcome > 0 ? 'font-semibold text-[var(--tone-red-fg-2)]' : 'text-muted-foreground'}`}>
                      {r.noOutcome.toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t bg-muted/40 text-[11.5px] font-semibold">
                <td className="px-3 py-1.5">Team</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{team.calls.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{pct(team.answeredPct)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{pct(team.warmHotPct)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{team.won.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{formatDuration(team.talkSecs)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{team.targetPct === null ? '—' : pct(team.targetPct)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{team.noOutcome.toLocaleString()}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
