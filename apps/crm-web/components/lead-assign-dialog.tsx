'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Check, Users, SlidersHorizontal, AlertTriangle, MapPin, Building2, Clock, Globe, ArrowRight } from 'lucide-react';
import { assignmentsApi } from '@/lib/crm';
import { leadsApi, isAssignedToday, SAME_DAY_LOCK_MESSAGE, type Lead } from '@/lib/leads';
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

  // ── Assignment method ──
  // 'selected' distributes the leads ticked in the table across several employees.
  // 'range' ignores the selection entirely and works on a lead-id window, which is
  // how a freshly imported block gets handed to one person without hunting for it
  // in the table.
  const [mode, setMode] = useState<'selected' | 'range'>('selected');

  // ── Lead range ──
  const [fromLead, setFromLead] = useState('');
  const [toLead, setToLead] = useState('');
  const [rangeCaller, setRangeCaller] = useState('');
  const [ackReassign, setAckReassign] = useState(false);
  const rangeReady = fromLead.trim() !== '' && toLead.trim() !== '';
  const { data: rangeLeads = [], isFetching: rangeLoading } = useQuery({
    queryKey: ['lead-range', fromLead.trim(), toLead.trim()],
    queryFn: () => leadsApi.list({ fromLeadId: fromLead.trim(), toLeadId: toLead.trim(), limit: 5000 }),
    enabled: mode === 'range' && rangeReady,
  });
  // The range deliberately covers leads that already belong to someone; moving them
  // is the point of a re-assignment, but it must never happen unnoticed — so the
  // count is surfaced and has to be acknowledged before the button unlocks.
  // Locked-today and owned-by-someone are both "not assignable", but they're
  // counted apart so the dialog can say which rule is holding a lead back.
  const rangeLockedToday = useMemo(() => rangeLeads.filter(isAssignedToday), [rangeLeads]);
  const rangeTaken = useMemo(() => rangeLeads.filter((l) => l.assignedTo && !isAssignedToday(l)), [rangeLeads]);
  const rangeAssignable = useMemo(() => rangeLeads.filter((l) => !l.assignedTo && !isAssignedToday(l)), [rangeLeads]);
  const rangeFree = rangeAssignable.length;
  // Owned leads are never reassigned by a range: the manager must consciously choose
  // to skip them and take the rest, or back out.
  const rangeNeedsAck = rangeTaken.length > 0 && !ackReassign;

  // Leads ticked in the table that already belong to someone. The table locks these
  // out, but a stale selection (someone assigned them meanwhile) can still carry
  // them in — so the popup re-checks rather than trusting the incoming list.
  const selectedTaken = useMemo(() => leads.filter((l) => l.assignedTo || isAssignedToday(l)), [leads]);
  const selectedLockedToday = useMemo(() => leads.filter(isAssignedToday), [leads]);

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
          // Never distribute a lead that already has an owner, or one handed over
          // earlier today (locked to its owner until tomorrow).
          !l.assignedTo &&
          !isAssignedToday(l) &&
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

  /**
   * Everything that describes who owns what, refreshed together. The two caller
   * keys matter as much as the lead list: assigning changes the Calling Panel's
   * queue and its Assigned / Pending cards, and without them the assigner's own
   * panel would keep showing the pre-assignment book until it next polled.
   */
  const invalidateAfterAssign = () => {
    qc.invalidateQueries({ queryKey: ['leads'] });
    qc.invalidateQueries({ queryKey: ['assignments-summary'] });
    qc.invalidateQueries({ queryKey: ['metrics', 'summary'] });
    qc.invalidateQueries({ queryKey: ['lead-range'] });
    qc.invalidateQueries({ queryKey: ['caller-leads'] });
    qc.invalidateQueries({ queryKey: ['caller-dash'] });
  };

  const assign = useMutation({
    mutationFn: () => assignmentsApi.batch({ allocations }),
    meta: { successMessage: `Assigned ${totalAssigned} lead${totalAssigned === 1 ? '' : 's'} to ${allocations.length} employee${allocations.length === 1 ? '' : 's'}` },
    onSuccess: () => {
      invalidateAfterAssign();
      onAssigned?.();
      onClose();
    },
  });

  const assignRange = useMutation({
    // Only the unowned leads in the window are sent; skipAssigned makes the server
    // enforce the same rule rather than trusting the client's filtering.
    mutationFn: () =>
      assignmentsApi.manual({ leadIds: rangeAssignable.map((l) => l.id), callerId: rangeCaller, skipAssigned: true }),
    meta: { successMessage: `Assigned ${rangeFree} lead${rangeFree === 1 ? '' : 's'} (${fromLead.trim()} → ${toLead.trim()})` },
    onSuccess: () => {
      invalidateAfterAssign();
      onAssigned?.();
      onClose();
    },
  });

  const canAssign = totalAssigned > 0 && !overAllocated && !assign.isPending;
  const canAssignRange =
    rangeAssignable.length > 0 && rangeCaller !== '' && !rangeNeedsAck && !rangeLoading && !assignRange.isPending;

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
                {mode === 'range'
                  ? 'Assign every lead in a lead-id range to one employee'
                  : `${leads.length} lead${leads.length > 1 ? 's' : ''} selected · filter by location, then assign a count per employee`}
              </p>
            </div>
            <button onClick={onClose} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Assignment method */}
          <div className="flex gap-1 border-b bg-muted/30 px-4 py-2">
            {([['selected', 'Selected leads'], ['range', 'Lead range']] as const).map(([m, label]) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                className={`rounded-md px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
                  mode === m ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-background hover:text-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {mode === 'range' ? (
              <>
                {/* From → To */}
                <div className="mb-4 rounded-xl border bg-muted/30 p-3">
                  <span className="mb-2 inline-flex items-center gap-1.5 text-[12.5px] font-medium">
                    <SlidersHorizontal className="h-3.5 w-3.5" /> Lead range
                  </span>
                  <div className="flex items-center gap-2">
                    <label className="min-w-0 flex-1">
                      <span className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground">From lead</span>
                      <input
                        value={fromLead}
                        onChange={(e) => { setFromLead(e.target.value); setAckReassign(false); }}
                        placeholder="L-2026-1"
                        className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-[13px] outline-none focus:border-primary"
                      />
                    </label>
                    <ArrowRight className="mt-4 h-4 w-4 shrink-0 text-muted-foreground" />
                    <label className="min-w-0 flex-1">
                      <span className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground">To lead</span>
                      <input
                        value={toLead}
                        onChange={(e) => { setToLead(e.target.value); setAckReassign(false); }}
                        placeholder="L-2026-300"
                        className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-[13px] outline-none focus:border-primary"
                      />
                    </label>
                  </div>
                  <p className="mt-2 text-[11.5px] text-muted-foreground">
                    Inclusive, and independent of what&apos;s ticked in the table. Use the lead id exactly as shown in the Lead ID column (e.g. L-2026-42).
                  </p>
                </div>

                {/* What the range actually resolves to — shown before anything is assigned. */}
                {!rangeReady && <p className="py-4 text-center text-[12.5px] text-muted-foreground">Enter both ends to preview the range.</p>}
                {rangeReady && rangeLoading && <p className="py-4 text-center text-[12.5px] text-muted-foreground">Finding leads…</p>}
                {rangeReady && !rangeLoading && rangeLeads.length === 0 && (
                  <p className="py-4 text-center text-[12.5px] text-muted-foreground">No leads fall in that range.</p>
                )}
                {rangeReady && !rangeLoading && rangeLeads.length > 0 && (
                  <div className="mb-4 rounded-xl border p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[12.5px] font-medium">
                        {rangeLeads.length} lead{rangeLeads.length === 1 ? '' : 's'} in range
                      </span>
                      <span className="truncate font-mono text-[11.5px] text-muted-foreground">
                        {rangeLeads[0].leadId} → {rangeLeads[rangeLeads.length - 1].leadId}
                      </span>
                    </div>
                    <p className="mt-1 text-[11.5px] text-muted-foreground">
                      <span className="font-semibold tabular-nums text-foreground">{rangeFree}</span> can be assigned ·{' '}
                      <span className="font-semibold tabular-nums text-foreground">{rangeTaken.length}</span> already assigned
                      {rangeLockedToday.length > 0 && (
                        <>
                          {' '}· <span className="font-semibold tabular-nums text-foreground">{rangeLockedToday.length}</span> locked
                          today
                        </>
                      )}
                    </p>
                    {rangeLockedToday.length > 0 && (
                      <p className="mt-1.5 rounded-lg bg-[#fbf3e2] px-2.5 py-2 text-[12px] text-[#8a5d0a]">
                        <AlertTriangle className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
                        {SAME_DAY_LOCK_MESSAGE} ({rangeLockedToday.length} in this range.)
                      </p>
                    )}
                    {rangeTaken.length > 0 && (
                      <div className="mt-2 rounded-lg bg-[#fbeeec] px-2.5 py-2 text-[12px] text-[#a8431f]">
                        <p>
                          <AlertTriangle className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
                          Some leads in this range are already assigned to other employees. Duplicate lead assignment is not allowed.
                        </p>
                        {/* The already-owned leads, named — "which ones" is the first
                            thing asked when a range comes back short. */}
                        <ul className="mt-1.5 max-h-24 overflow-y-auto pl-5 font-mono text-[11px] leading-relaxed">
                          {rangeTaken.slice(0, 12).map((l) => (
                            <li key={l.id}>
                              {l.leadId} — {l.assignedTo?.name}
                            </li>
                          ))}
                          {rangeTaken.length > 12 && <li>+{rangeTaken.length - 12} more…</li>}
                        </ul>
                        <label className="mt-2 flex cursor-pointer items-start gap-2 font-medium">
                          <input
                            type="checkbox"
                            checked={ackReassign}
                            onChange={(e) => setAckReassign(e.target.checked)}
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[#a8431f]"
                          />
                          <span>
                            Skip {rangeTaken.length} already-assigned lead{rangeTaken.length === 1 ? '' : 's'} and assign the remaining{' '}
                            {rangeFree}.
                          </span>
                        </label>
                      </div>
                    )}
                    {rangeTaken.length > 0 && rangeFree === 0 && (
                      <p className="mt-2 text-[12px] font-medium text-[#a8431f]">
                        Every lead in this range is already assigned — nothing left to assign.
                      </p>
                    )}
                  </div>
                )}

                {/* Range goes to exactly one employee. */}
                <div className="mb-2 inline-flex items-center gap-1.5 text-[12.5px] font-medium">
                  <Users className="h-3.5 w-3.5" /> Assign all to
                </div>
                {isLoading && <div className="px-2 py-6 text-center text-sm text-muted-foreground">Loading…</div>}
                {!isLoading && callers.length === 0 && (
                  <div className="px-2 py-6 text-center text-sm text-muted-foreground">No active employees.</div>
                )}
                {callers.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setRangeCaller(c.id)}
                    className={`mb-1.5 flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      rangeCaller === c.id ? 'border-primary bg-primary/5' : 'border-transparent bg-background hover:border-border'
                    }`}
                  >
                    <span
                      className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${
                        rangeCaller === c.id ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background'
                      }`}
                    >
                      {rangeCaller === c.id && <Check className="h-3.5 w-3.5" />}
                    </span>
                    <Avatar name={c.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{c.name}</span>
                      <span className="block truncate text-[11.5px] text-muted-foreground">
                        {c.leadCount} current lead{c.leadCount === 1 ? '' : 's'}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            ) : (
              <>
            {/* A lead can only ever have one owner, so any already-owned lead in the
                selection is excluded from the pool rather than quietly taken. */}
            {selectedTaken.length > 0 && (
              <div className="mb-3 rounded-xl bg-[#fbeeec] px-3 py-2.5 text-[12px] text-[#a8431f]">
                <p className="font-medium">
                  <AlertTriangle className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
                  {selectedLockedToday.length === selectedTaken.length
                    ? SAME_DAY_LOCK_MESSAGE
                    : selectedTaken.length === 1
                      ? `This lead is already assigned to ${selectedTaken[0].assignedTo?.name}. A lead can only be assigned to one employee.`
                      : 'Some selected leads are already assigned to other employees. Duplicate lead assignment is not allowed.'}
                </p>
                {selectedLockedToday.length > 0 && selectedLockedToday.length !== selectedTaken.length && (
                  <p className="mt-1">{selectedLockedToday.length} of them were assigned today and are locked until tomorrow.</p>
                )}
                <p className="mt-1">
                  {selectedTaken.length} of {leads.length} excluded — the remaining {pool.length} can be distributed below.
                </p>
              </div>
            )}
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
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
              </>
            )}
          </div>

          {/* Preview + validation — the count split only applies to the selection mode. */}
          {mode === 'selected' && (
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
          )}

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 border-t px-5 py-3.5">
            <button onClick={onClose} className="rounded-md border bg-card px-3 py-2 text-[13px] font-medium hover:bg-muted">
              Cancel
            </button>
            {mode === 'range' ? (
              <button
                onClick={() => assignRange.mutate()}
                disabled={!canAssignRange}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {/* Counts what will actually be assigned, not what the window
                    contains — already-owned and locked-today leads are excluded
                    from the request, so promising the full range then assigning
                    fewer is how a manager ends up thinking leads went missing. */}
                {assignRange.isPending
                  ? 'Assigning…'
                  : rangeFree > 0
                    ? `Assign ${rangeFree} lead${rangeFree === 1 ? '' : 's'}`
                    : 'Assign range'}
              </button>
            ) : (
              <button
                onClick={() => assign.mutate()}
                disabled={!canAssign}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {assign.isPending ? 'Assigning…' : totalAssigned > 0 ? `Assign ${totalAssigned} lead${totalAssigned === 1 ? '' : 's'}` : 'Assign leads'}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
