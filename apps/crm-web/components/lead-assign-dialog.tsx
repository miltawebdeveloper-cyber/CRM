'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Check, Users, SlidersHorizontal, AlertTriangle, MapPin, Building2, Clock, Globe } from 'lucide-react';
import { assignmentsApi } from '@/lib/crm';
import type { Lead } from '@/lib/leads';
import { MultiSelect } from '@/components/multi-select';
import { Avatar } from '@/components/page-head';

const distinct = (vals: (string | null | undefined)[]) =>
  [...new Set(vals.map((v) => (v ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

/**
 * Employee-wise manual lead-distribution popup (Admin / Team Leader).
 *
 * Opened from the Leads selection bar with one or more leads checked. The manager
 * narrows the pool with multi-select, searchable location filters (timezone /
 * state / city / country). Every filter option is derived purely from the leads
 * in play — so the lists always reflect current data and never show a value with
 * no matching leads — and cities cascade from the selected states. The manager
 * then picks employees, types how many leads each should receive, previews the
 * split, and assigns. All in one popup. Leads are sliced sequentially from the
 * filtered pool so none is ever assigned twice.
 */
export function LeadAssignDialog({
  leads,
  onClose,
  onAssigned,
}: {
  leads: Lead[];
  onClose: () => void;
  /** Called after a successful assignment (e.g. to clear the table selection). */
  onAssigned?: () => void;
}) {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({ queryKey: ['assignments-summary'], queryFn: assignmentsApi.summary });
  const callers = data?.callers ?? [];

  // Multi-select, searchable location filters (cascade: state → city).
  const [tzSel, setTzSel] = useState<string[]>([]);
  const [stateSel, setStateSel] = useState<string[]>([]);
  const [citySel, setCitySel] = useState<string[]>([]);
  const [countrySel, setCountrySel] = useState<string[]>([]);
  // callerId → number of leads to assign. Presence in the map = employee selected.
  const [counts, setCounts] = useState<Record<string, number>>({});

  // Filter options are data-driven: derived only from the leads in play, so every
  // option maps to real leads and a value vanishes once its last lead is gone.
  const tzOpts = useMemo(() => distinct(leads.map((l) => l.timezone)), [leads]);
  const countryOpts = useMemo(() => distinct(leads.map((l) => l.country)), [leads]);
  const stateOpts = useMemo(() => distinct(leads.map((l) => l.state)), [leads]);
  // Cities present in leads belonging to the given states (all cities if none chosen).
  const citiesForStates = (states: string[]) =>
    distinct(leads.filter((l) => states.length === 0 || states.includes((l.state ?? '').trim())).map((l) => l.city));
  const cityOpts = useMemo(() => citiesForStates(stateSel), [leads, stateSel]);

  // Changing states cascades to cities: drop any selected city no longer offered.
  const setStates = (next: string[]) => {
    setStateSel(next);
    const valid = new Set(citiesForStates(next));
    setCitySel((cities) => cities.filter((c) => valid.has(c)));
  };

  // Leads matching every active filter — the pool that gets distributed.
  const pool = useMemo(
    () =>
      leads.filter(
        (l) =>
          (tzSel.length === 0 || tzSel.includes(l.timezone)) &&
          (stateSel.length === 0 || stateSel.includes(l.state)) &&
          (citySel.length === 0 || citySel.includes(l.city)) &&
          (countrySel.length === 0 || countrySel.includes((l.country ?? '').trim())),
      ),
    [leads, tzSel, stateSel, citySel, countrySel],
  );

  const anyFilter = tzSel.length + stateSel.length + citySel.length + countrySel.length > 0;
  const clearFilters = () => { setTzSel([]); setStateSel([]); setCitySel([]); setCountrySel([]); };

  const totalAssigned = Object.values(counts).reduce((a, b) => a + b, 0);
  const remaining = pool.length - totalAssigned;
  const overAllocated = totalAssigned > pool.length;
  const selectedCallers = callers.filter((c) => c.id in counts);

  // Deterministic, disjoint slices of the pool → one leadIds group per employee.
  const allocations = useMemo(() => {
    const out: { callerId: string; leadIds: string[] }[] = [];
    let cursor = 0;
    for (const c of callers) {
      const n = counts[c.id];
      if (!n || n <= 0) continue;
      const leadIds = pool.slice(cursor, cursor + n).map((l) => l.id);
      cursor += n;
      if (leadIds.length) out.push({ callerId: c.id, leadIds });
    }
    return out;
  }, [callers, counts, pool]);

  const toggleCaller = (id: string) =>
    setCounts((c) => {
      const next = { ...c };
      if (id in next) delete next[id];
      else next[id] = 0;
      return next;
    });

  const setCount = (id: string, raw: string) => {
    const n = Math.max(0, Math.floor(Number(raw) || 0));
    setCounts((c) => ({ ...c, [id]: n }));
  };

  // Divide the current pool as evenly as possible across the selected employees.
  const splitEvenly = () => {
    const ids = selectedCallers.map((c) => c.id);
    if (!ids.length) return;
    const base = Math.floor(pool.length / ids.length);
    let extra = pool.length % ids.length;
    setCounts((c) => {
      const next = { ...c };
      for (const id of ids) next[id] = base + (extra-- > 0 ? 1 : 0);
      return next;
    });
  };

  const assign = useMutation({
    mutationFn: () => assignmentsApi.batch({ allocations }),
    meta: { successMessage: `Assigned ${totalAssigned} lead${totalAssigned === 1 ? '' : 's'} to ${allocations.length} employee${allocations.length === 1 ? '' : 's'}` },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['assignments-summary'] });
      qc.invalidateQueries({ queryKey: ['metrics', 'summary'] });
      onAssigned?.();
      onClose();
    },
  });

  const canAssign = totalAssigned > 0 && !overAllocated && !assign.isPending;

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 z-40 bg-black/30" />
      <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" aria-label="Assign leads">
        <div
          onClick={(e) => e.stopPropagation()}
          className="flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl"
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
            <div>
              <h3 className="font-display text-[15px] font-semibold">Distribute lead ownership</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {leads.length} lead{leads.length > 1 ? 's' : ''} selected · filter by location, then assign a count per employee
              </p>
            </div>
            <button onClick={onClose} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {/* Rule-based, multi-select location filters */}
            <div className="mb-4 rounded-xl border bg-muted/30 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium">
                  <SlidersHorizontal className="h-3.5 w-3.5" /> Filter the pool
                </span>
                {anyFilter && (
                  <button onClick={clearFilters} className="text-[11.5px] text-muted-foreground hover:text-foreground">
                    Clear filters
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <MultiSelect icon={Clock} label="All Time Zones" options={tzOpts} selected={tzSel} onChange={setTzSel} placeholder="Search time zones…" />
                <MultiSelect
                  icon={Globe}
                  label={countryOpts.length ? 'All Countries' : 'No country data'}
                  options={countryOpts}
                  selected={countrySel}
                  onChange={setCountrySel}
                  disabled={countryOpts.length === 0}
                  placeholder="Search countries…"
                />
                <MultiSelect icon={MapPin} label="All States" options={stateOpts} selected={stateSel} onChange={setStates} placeholder="Search states…" emptyText="No states in these leads" />
                <MultiSelect icon={Building2} label="All Cities" options={cityOpts} selected={citySel} onChange={setCitySel} placeholder="Search cities…" emptyText="No cities for the selected states" />
              </div>
              <p className="mt-2 text-[11.5px] text-muted-foreground">
                <span className="font-semibold tabular-nums text-foreground">{pool.length}</span> of {leads.length} selected lead{leads.length > 1 ? 's' : ''} match{anyFilter ? ' these filters' : ''}
              </p>
            </div>

            {/* Employee selection + per-employee counts */}
            <div className="mb-2 flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium">
                <Users className="h-3.5 w-3.5" /> Employees
              </span>
              {selectedCallers.length > 0 && (
                <button onClick={splitEvenly} className="text-[11.5px] font-medium text-primary hover:underline">
                  Split evenly
                </button>
              )}
            </div>

            {isLoading && <div className="px-2 py-6 text-center text-sm text-muted-foreground">Loading…</div>}
            {!isLoading && callers.length === 0 && (
              <div className="px-2 py-6 text-center text-sm text-muted-foreground">No active employees.</div>
            )}
            {callers.map((c) => {
              const selected = c.id in counts;
              return (
                <div
                  key={c.id}
                  className={`mb-1.5 flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${selected ? 'border-primary bg-primary/5' : 'border-transparent bg-background hover:border-border'}`}
                >
                  <button onClick={() => toggleCaller(c.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <span className={`grid h-5 w-5 shrink-0 place-items-center rounded border ${selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background'}`}>
                      {selected && <Check className="h-3.5 w-3.5" />}
                    </span>
                    <Avatar name={c.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{c.name}</span>
                      <span className="block truncate text-[11.5px] text-muted-foreground">{c.leadCount} current lead{c.leadCount === 1 ? '' : 's'}</span>
                    </span>
                  </button>
                  <input
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={selected ? counts[c.id] : ''}
                    onChange={(e) => setCount(c.id, e.target.value)}
                    onFocus={() => { if (!selected) toggleCaller(c.id); }}
                    placeholder="0"
                    aria-label={`Leads for ${c.name}`}
                    className="w-16 shrink-0 rounded-md border bg-background px-2 py-1.5 text-right text-[13px] tabular-nums outline-none focus:border-primary"
                  />
                </div>
              );
            })}
          </div>

          {/* Preview + validation */}
          <div className="border-t px-5 py-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-muted/50 px-2 py-2">
                <div className="text-[16px] font-semibold tabular-nums">{pool.length}</div>
                <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">In pool</div>
              </div>
              <div className="rounded-lg bg-muted/50 px-2 py-2">
                <div className="text-[16px] font-semibold tabular-nums">{totalAssigned}</div>
                <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">Assigning</div>
              </div>
              <div className={`rounded-lg px-2 py-2 ${overAllocated ? 'bg-destructive/10' : 'bg-muted/50'}`}>
                <div className={`text-[16px] font-semibold tabular-nums ${overAllocated ? 'text-destructive' : ''}`}>{Math.abs(remaining)}</div>
                <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{overAllocated ? 'Over by' : 'Unassigned'}</div>
              </div>
            </div>

            {overAllocated && (
              <p className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" /> Over-allocated by {totalAssigned - pool.length} — reduce the counts to match the pool.
              </p>
            )}
            {!overAllocated && remaining > 0 && totalAssigned > 0 && (
              <p className="mt-2 text-[12px] text-muted-foreground">
                {remaining} lead{remaining === 1 ? '' : 's'} will remain unassigned.
              </p>
            )}
            {!overAllocated && totalAssigned > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {selectedCallers.filter((c) => counts[c.id] > 0).map((c) => (
                  <span key={c.id} className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium">
                    {c.name} · <span className="tabular-nums">{counts[c.id]}</span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 border-t px-5 py-3.5">
            <button onClick={onClose} className="rounded-md border bg-card px-3 py-2 text-[13px] font-medium hover:bg-muted">
              Cancel
            </button>
            <button
              onClick={() => assign.mutate()}
              disabled={!canAssign}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {assign.isPending ? 'Assigning…' : totalAssigned > 0 ? `Assign ${totalAssigned} lead${totalAssigned === 1 ? '' : 's'}` : 'Assign leads'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
