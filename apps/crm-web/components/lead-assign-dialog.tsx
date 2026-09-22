'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Check, Users, SlidersHorizontal, AlertTriangle, MapPin, Building2, Clock, Globe, ArrowRight } from 'lucide-react';
import { assignmentsApi, sameDayConflicts, type SameDayConflict } from '@/lib/crm';
import { leadsApi, isAssignedToday, type Lead } from '@/lib/leads';
import { MultiSelect } from '@/components/multi-select';
import { Avatar } from '@/components/page-head';
import { ReassignConfirm } from '@/components/reassign-confirm';
import { pushToast } from '@/lib/toast';
import { UNSET_TIMEZONE_LABEL } from '@/lib/timezone';

const distinct = (vals: (string | null | undefined)[]) =>
  [...new Set(vals.map((v) => (v ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

/**
 * "Some of these belong to someone — leave them, or move them?"
 *
 * A lead has one owner, and until now this dialog answered that question for the
 * manager by dropping every owned lead from the pool. There was no way to hand a
 * lead to someone else from here at all; the only route was the lead's own page,
 * one lead at a time. This is that option, made explicit rather than implied.
 *
 * It answers OWNERSHIP and nothing else — may a lead leave the employee holding
 * it. Whether it may move AGAIN TODAY is a separate question that belongs to the
 * server: it refuses the write and names the leads, and that refusal becomes the
 * confirmation popup. Choosing to transfer here must never pre-answer that one,
 * or the daily rule would evaporate the moment a manager decided to move
 * anything. The line about today's leads is a forewarning, not the confirmation.
 */
function OwnedLeadsChoice({
  owned,
  remaining,
  transfer,
  onTransfer,
  askCount,
  employee,
}: {
  /** Leads in play that already belong to another employee. */
  owned: Lead[];
  /** How many would still be assignable if these were left alone. */
  remaining: number;
  transfer: boolean;
  onTransfer: (v: boolean) => void;
  /** Of the leads that will actually be sent, how many already moved today. */
  askCount: number;
  /** Who they'd go to, when it's a single named employee. */
  employee?: string;
}) {
  const one = owned.length === 1;
  return (
    <div className="mb-3 rounded-xl bg-[var(--tone-amber-bg)] px-3 py-2.5 text-[11.5px] text-[var(--tone-amber-fg-strong)]">
      <p className="font-medium">
        <AlertTriangle className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
        {one
          ? `This lead already belongs to ${owned[0].assignedTo?.name ?? 'another employee'}.`
          : `${owned.length} of these leads already belong to other employees.`}
      </p>

      {/* Which ones, and whose — "which leads am I about to move" is the first
          thing asked, and a count can't answer it. */}
      <ul className="mt-1.5 max-h-24 overflow-y-auto pl-5 font-mono text-[10.5px] leading-relaxed">
        {owned.slice(0, 12).map((l) => (
          <li key={l.id}>
            {l.leadId} — {l.assignedTo?.name}
          </li>
        ))}
        {owned.length > 12 && <li>+{owned.length - 12} more…</li>}
      </ul>

      {/* Leaving them alone stays the default and is listed first: a transfer
          takes work off someone mid-day, so it should be chosen, not landed on. */}
      <div className="mt-2 space-y-1.5">
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            checked={!transfer}
            onChange={() => onTransfer(false)}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--tone-amber-fg-strong)]"
          />
          <span>
            Leave {one ? 'it' : 'them'} with {one ? 'its' : 'their'} current owner
            {remaining > 0 ? ` and assign the other ${remaining}` : ''}.
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 font-medium">
          <input
            type="radio"
            checked={transfer}
            onChange={() => onTransfer(true)}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--tone-amber-fg-strong)]"
          />
          <span>Reassign {one ? 'it' : 'them'} to {employee ?? 'the employees selected below'}.</span>
        </label>
      </div>

      {transfer && askCount > 0 && (
        <p className="mt-2 border-t border-[#e8d9b4] pt-2">
          {askCount === 1 ? 'One of them was' : `${askCount} of them were`} already assigned today — you&apos;ll be
          asked to confirm before {askCount === 1 ? 'it moves' : 'they move'} again.
        </p>
      )}
    </div>
  );
}

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
  allowTransfer = true,
}: {
  leads: Lead[];
  onClose: () => void;
  /** Called after a successful assignment (e.g. to clear the table selection). */
  onAssigned?: () => void;
  /**
   * Whether an already-owned lead may be moved to someone else. Lead
   * Management (the default) hands out this choice — that's what Reassign
   * means there. Lead Library sets this `false`: Library's Assign is
   * first-assignment only, so an owned lead is simply excluded from what
   * gets sent rather than offered as a transfer.
   */
  allowTransfer?: boolean;
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

  /**
   * Whether leads that already belong to someone may be moved.
   *
   * Off by default and in both modes: this dialog hands out unowned work, and a
   * transfer takes it off a person who may already be working it. It is the
   * "may this leave its current owner" answer, sent as `allowReassign`. The
   * separate "may it move again today" answer comes from the confirmation popup,
   * and is sent as `confirmSameDayReassign` — a lead can need both.
   */
  const [transferOwned, setTransferOwnedRaw] = useState(false);
  const setTransferOwned = (v: boolean) => setTransferOwnedRaw(allowTransfer ? v : false);

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
  // The range deliberately covers leads that already belong to someone. Moving
  // them is a transfer, which must never happen unnoticed — so they are named and
  // the manager chooses between leaving them and reassigning them.
  const rangeOwned = useMemo(() => rangeLeads.filter((l) => !!l.assignedTo), [rangeLeads]);
  // What the request will actually carry. Leads assigned earlier today stay in
  // either way: the server decides whether they may move again, and asks.
  const rangeAssignable = useMemo(
    () => rangeLeads.filter((l) => transferOwned || !l.assignedTo),
    [rangeLeads, transferOwned],
  );
  const rangeFree = rangeAssignable.length;
  // Of the leads being sent, the ones that will raise the confirmation. Derived
  // from what is being sent rather than from the whole window — forewarning about
  // a lead that isn't going anywhere is how a prompt stops being believed.
  const rangeWillAsk = useMemo(() => rangeAssignable.filter(isAssignedToday), [rangeAssignable]);
  // Leaving owned leads behind is still a conscious choice, not a silent skip.
  const rangeNeedsAck = rangeOwned.length > 0 && !transferOwned && !ackReassign;

  // Leads ticked in the table that already belong to someone. The table lets every
  // row be ticked (the checkbox serves delete too), so this is where the selection
  // is read for ownership — and it re-reads it rather than trusting that nothing
  // changed hands since the rows were fetched.
  const selectedOwned = useMemo(() => leads.filter((l) => !!l.assignedTo), [leads]);

  // Multi-select, searchable location filters (cascade: state → city).
  const [tzSel, setTzSel] = useState<string[]>([]);
  const [stateSel, setStateSel] = useState<string[]>([]);
  const [citySel, setCitySel] = useState<string[]>([]);
  const [countrySel, setCountrySel] = useState<string[]>([]);
  // callerId → number of leads to assign. Presence in the map = employee selected.
  const [counts, setCounts] = useState<Record<string, number>>({});

  // Filter options are data-driven: derived only from the leads in play, so every
  // option maps to real leads and a value vanishes once its last lead is gone.
  const tzOpts = useMemo(() => distinct(leads.map((l) => l.timezone ?? UNSET_TIMEZONE_LABEL)), [leads]);
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
          // A lead that already has an owner is only in the pool when the manager
          // has explicitly chosen to transfer. Unowned work is what this dialog
          // hands out; moving owned work is the deliberate act above.
          //
          // Leads assigned earlier today are NOT filtered out here. The daily
          // restriction is the server's to apply: it refuses and names them, and
          // the manager is asked. Hiding them client-side meant a lead that had
          // been assigned and then unassigned the same day silently vanished
          // from the pool with nothing said.
          (transferOwned || !l.assignedTo) &&
          // A lead with no zone answers to the "Unassigned" filter value, the
          // same name the API groups it under.
          (tzSel.length === 0 || tzSel.includes(l.timezone ?? UNSET_TIMEZONE_LABEL)) &&
          (stateSel.length === 0 || stateSel.includes(l.state)) &&
          (citySel.length === 0 || citySel.includes(l.city)) &&
          (countrySel.length === 0 || countrySel.includes((l.country ?? '').trim())),
      ),
    [leads, tzSel, stateSel, citySel, countrySel, transferOwned],
  );

  // Of the pool, how many will raise the confirmation when it is assigned.
  const poolWillAsk = useMemo(() => pool.filter(isAssignedToday), [pool]);
  // What the pool would hold if the owned leads were left where they are — the
  // number the "leave them" choice needs to state.
  const poolWithoutOwned = useMemo(() => pool.filter((l) => !l.assignedTo).length, [pool]);

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

  /**
   * The daily restriction, handled by asking rather than by pre-filtering.
   *
   * The first attempt goes without confirmation. If the server refuses because
   * some of the leads already moved today it says which ones, and that becomes
   * the prompt; answering "Yes, Reassign" retries the identical request with the
   * confirmation attached. The client never decides for itself what counts as
   * "assigned today" — the server owns that, and it is the only party that can
   * see a handover made from another screen a moment ago.
   */
  const [confirmSameDay, setConfirmSameDay] = useState<{ conflicts: SameDayConflict[]; retry: (confirmed: boolean) => void } | null>(null);
  const onAssignError = (err: unknown, retry: (confirmed: boolean) => void) => {
    const conflicts = sameDayConflicts(err);
    if (conflicts) {
      setConfirmSameDay({ conflicts, retry });
      return true;
    }
    return false; // anything else is a real error; let the toast handle it
  };

  const assign = useMutation({
    mutationFn: (confirmed: boolean) =>
      assignmentsApi.batch({
        allocations,
        allowReassign: transferOwned || undefined,
        confirmSameDayReassign: confirmed || undefined,
      }),
    // Its own error handling, so a request that merely needs confirming raises a
    // question instead of an error toast.
    meta: { suppressErrorToast: true },
    onSuccess: () => {
      setConfirmSameDay(null);
      invalidateAfterAssign();
      pushToast('success', `Assigned ${totalAssigned} lead${totalAssigned === 1 ? '' : 's'} to ${allocations.length} employee${allocations.length === 1 ? '' : 's'}`);
      onAssigned?.();
      onClose();
    },
    onError: (err) => {
      if (!onAssignError(err, (confirmed) => assign.mutate(confirmed))) {
        pushToast('error', (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Assignment failed.');
      }
    },
  });

  const assignRange = useMutation({
    // `skipAssigned` makes the server enforce the ownership rule rather than
    // trusting the client's filtering; `allowReassign` is what lifts it, and only
    // when the manager chose the transfer. Sending both would be contradictory,
    // so exactly one goes with any request.
    mutationFn: (confirmed: boolean) =>
      assignmentsApi.manual({
        leadIds: rangeAssignable.map((l) => l.id),
        callerId: rangeCaller,
        skipAssigned: transferOwned ? undefined : true,
        allowReassign: transferOwned || undefined,
        confirmSameDayReassign: confirmed || undefined,
      }),
    meta: { suppressErrorToast: true },
    onSuccess: () => {
      setConfirmSameDay(null);
      invalidateAfterAssign();
      pushToast('success', `Assigned ${rangeFree} lead${rangeFree === 1 ? '' : 's'} (${fromLead.trim()} → ${toLead.trim()})`);
      onAssigned?.();
      onClose();
    },
    onError: (err) => {
      if (!onAssignError(err, (confirmed) => assignRange.mutate(confirmed))) {
        pushToast('error', (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Assignment failed.');
      }
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
              <h3 className="font-display text-[14px] font-semibold">Distribute lead ownership</h3>
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
                className={`rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors ${
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
                  <span className="mb-2 inline-flex items-center gap-1.5 text-[12px] font-medium">
                    <SlidersHorizontal className="h-3.5 w-3.5" /> Lead range
                  </span>
                  <div className="flex items-center gap-2">
                    <label className="min-w-0 flex-1">
                      <span className="mb-1 block text-[10.5px] uppercase tracking-wide text-muted-foreground">From lead</span>
                      <input
                        value={fromLead}
                        onChange={(e) => { setFromLead(e.target.value); setAckReassign(false); }}
                        placeholder="L-2026-1"
                        className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-[12.5px] outline-none focus:border-primary"
                      />
                    </label>
                    <ArrowRight className="mt-4 h-4 w-4 shrink-0 text-muted-foreground" />
                    <label className="min-w-0 flex-1">
                      <span className="mb-1 block text-[10.5px] uppercase tracking-wide text-muted-foreground">To lead</span>
                      <input
                        value={toLead}
                        onChange={(e) => { setToLead(e.target.value); setAckReassign(false); }}
                        placeholder="L-2026-300"
                        className="w-full rounded-md border bg-background px-2.5 py-1.5 font-mono text-[12.5px] outline-none focus:border-primary"
                      />
                    </label>
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Inclusive, and independent of what&apos;s ticked in the table. Use the lead id exactly as shown in the Lead ID column (e.g. L-2026-42).
                  </p>
                </div>

                {/* What the range actually resolves to — shown before anything is assigned. */}
                {!rangeReady && <p className="py-4 text-center text-[12px] text-muted-foreground">Enter both ends to preview the range.</p>}
                {rangeReady && rangeLoading && <p className="py-4 text-center text-[12px] text-muted-foreground">Finding leads…</p>}
                {rangeReady && !rangeLoading && rangeLeads.length === 0 && (
                  <p className="py-4 text-center text-[12px] text-muted-foreground">No leads fall in that range.</p>
                )}
                {rangeReady && !rangeLoading && rangeLeads.length > 0 && (
                  <div className="mb-4 rounded-xl border p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[12px] font-medium">
                        {rangeLeads.length} lead{rangeLeads.length === 1 ? '' : 's'} in range
                      </span>
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {rangeLeads[0].leadId} → {rangeLeads[rangeLeads.length - 1].leadId}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      <span className="font-semibold tabular-nums text-foreground">{rangeFree}</span> will be assigned ·{' '}
                      <span className="font-semibold tabular-nums text-foreground">{rangeOwned.length}</span> already owned
                      {rangeWillAsk.length > 0 && (
                        <>
                          {' '}· <span className="font-semibold tabular-nums text-foreground">{rangeWillAsk.length}</span> assigned
                          today
                        </>
                      )}
                    </p>
                    {/* Forewarning for the leads being sent that moved today —
                        they will ask for confirmation first. Only while the owned
                        ones are being left alone; once they're being transferred
                        the block below says it, about the same leads. */}
                    {rangeWillAsk.length > 0 && !transferOwned && (
                      <p className="mt-1.5 rounded-lg bg-[var(--tone-amber-bg)] px-2.5 py-2 text-[11.5px] text-[var(--tone-amber-fg-strong)]">
                        <AlertTriangle className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
                        {rangeWillAsk.length === 1 ? 'One lead in this range was' : `${rangeWillAsk.length} leads in this range were`}{' '}
                        already assigned today. You&apos;ll be asked to confirm before {rangeWillAsk.length === 1 ? 'it moves' : 'they move'} again.
                      </p>
                    )}
                    {rangeOwned.length > 0 && allowTransfer && (
                      <div className="mt-2">
                        <OwnedLeadsChoice
                          owned={rangeOwned}
                          remaining={rangeLeads.length - rangeOwned.length}
                          transfer={transferOwned}
                          onTransfer={(v) => { setTransferOwned(v); setAckReassign(false); }}
                          askCount={rangeWillAsk.length}
                          employee={callers.find((c) => c.id === rangeCaller)?.name}
                        />
                        {/* Leaving them behind is still acknowledged explicitly:
                            a range that quietly assigns fewer leads than it names
                            is how a manager ends up thinking leads went missing. */}
                        {!transferOwned && (
                          <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-[var(--tone-red-bg)] px-2.5 py-2 text-[11.5px] font-medium text-[var(--tone-red-fg-2)]">
                            <input
                              type="checkbox"
                              checked={ackReassign}
                              onChange={(e) => setAckReassign(e.target.checked)}
                              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--tone-red-fg-2)]"
                            />
                            <span>
                              Skip {rangeOwned.length} already-assigned lead{rangeOwned.length === 1 ? '' : 's'} and assign the remaining{' '}
                              {rangeFree}.
                            </span>
                          </label>
                        )}
                      </div>
                    )}
                    {rangeOwned.length > 0 && !allowTransfer && (
                      <p className="mt-2 rounded-lg bg-muted/50 px-2.5 py-2 text-[11.5px] text-muted-foreground">
                        {rangeOwned.length} already-assigned lead{rangeOwned.length === 1 ? '' : 's'} in this range excluded — reassign
                        {rangeOwned.length === 1 ? ' it' : ' them'} from Lead Management.
                      </p>
                    )}
                    {rangeFree === 0 && (
                      <p className="mt-2 text-[11.5px] font-medium text-[var(--tone-red-fg-2)]">
                        Every lead in this range is already assigned — nothing left to assign.
                      </p>
                    )}
                  </div>
                )}

                {/* Range goes to exactly one employee. */}
                <div className="mb-2 inline-flex items-center gap-1.5 text-[12px] font-medium">
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
                      <span className="block truncate text-[12.5px] font-medium">{c.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {c.leadCount} current lead{c.leadCount === 1 ? '' : 's'}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            ) : (
              <>
            {/* A lead has one owner, so an already-owned lead in the selection is
                left out of the pool unless the manager chooses to transfer it. */}
            {selectedOwned.length > 0 && allowTransfer && (
              <OwnedLeadsChoice
                owned={selectedOwned}
                remaining={poolWithoutOwned}
                transfer={transferOwned}
                onTransfer={setTransferOwned}
                askCount={poolWillAsk.length}
              />
            )}
            {selectedOwned.length > 0 && !allowTransfer && (
              <p className="mb-3 rounded-xl bg-muted/50 px-3 py-2.5 text-[11.5px] text-muted-foreground">
                {selectedOwned.length} already-assigned lead{selectedOwned.length === 1 ? '' : 's'} selected excluded — reassign
                {selectedOwned.length === 1 ? ' it' : ' them'} from Lead Management.
              </p>
            )}
            {/* Leads in the pool that moved today. Only while the owned ones are
                being left alone — once they're being transferred the block above
                is already saying this, about the same leads. */}
            {!transferOwned && poolWillAsk.length > 0 && (
              <p className="mb-3 rounded-xl bg-[var(--tone-amber-bg)] px-3 py-2.5 text-[11.5px] text-[var(--tone-amber-fg-strong)]">
                <AlertTriangle className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
                {poolWillAsk.length === 1 ? 'One lead in the pool was' : `${poolWillAsk.length} leads in the pool were`} already assigned
                today. You&apos;ll be asked to confirm before {poolWillAsk.length === 1 ? 'it moves' : 'they move'} again.
              </p>
            )}
            {/* Rule-based, multi-select location filters */}
            <div className="mb-4 rounded-xl border bg-muted/30 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-[12px] font-medium">
                  <SlidersHorizontal className="h-3.5 w-3.5" /> Filter the pool
                </span>
                {anyFilter && (
                  <button onClick={clearFilters} className="text-[11px] text-muted-foreground hover:text-foreground">
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
              <p className="mt-2 text-[11px] text-muted-foreground">
                <span className="font-semibold tabular-nums text-foreground">{pool.length}</span> of {leads.length} selected lead{leads.length > 1 ? 's' : ''} match{anyFilter ? ' these filters' : ''}
              </p>
            </div>

            {/* Employee selection + per-employee counts */}
            <div className="mb-2 flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-[12px] font-medium">
                <Users className="h-3.5 w-3.5" /> Employees
              </span>
              {selectedCallers.length > 0 && (
                <button onClick={splitEvenly} className="text-[11px] font-medium text-primary hover:underline">
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
                      <span className="block truncate text-[12.5px] font-medium">{c.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{c.leadCount} current lead{c.leadCount === 1 ? '' : 's'}</span>
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
                    className="w-16 shrink-0 rounded-md border bg-background px-2 py-1.5 text-right text-[12.5px] tabular-nums outline-none focus:border-primary"
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
                <div className="text-[15px] font-semibold tabular-nums">{pool.length}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">In pool</div>
              </div>
              <div className="rounded-lg bg-muted/50 px-2 py-2">
                <div className="text-[15px] font-semibold tabular-nums">{totalAssigned}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Assigning</div>
              </div>
              <div className={`rounded-lg px-2 py-2 ${overAllocated ? 'bg-destructive/10' : 'bg-muted/50'}`}>
                <div className={`text-[15px] font-semibold tabular-nums ${overAllocated ? 'text-destructive' : ''}`}>{Math.abs(remaining)}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{overAllocated ? 'Over by' : 'Unassigned'}</div>
              </div>
            </div>

            {overAllocated && (
              <p className="mt-2 inline-flex items-center gap-1.5 text-[11.5px] font-medium text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" /> Over-allocated by {totalAssigned - pool.length} — reduce the counts to match the pool.
              </p>
            )}
            {!overAllocated && remaining > 0 && totalAssigned > 0 && (
              <p className="mt-2 text-[11.5px] text-muted-foreground">
                {remaining} lead{remaining === 1 ? '' : 's'} will remain unassigned.
              </p>
            )}
            {!overAllocated && totalAssigned > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {selectedCallers.filter((c) => counts[c.id] > 0).map((c) => (
                  <span key={c.id} className="rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium">
                    {c.name} · <span className="tabular-nums">{counts[c.id]}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 border-t px-5 py-3.5">
            <button onClick={onClose} className="rounded-md border bg-card px-3 py-2 text-[12.5px] font-medium hover:bg-muted">
              Cancel
            </button>
            {mode === 'range' ? (
              <button
                onClick={() => assignRange.mutate(false)}
                disabled={!canAssignRange}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-[12.5px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
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
                onClick={() => assign.mutate(false)}
                disabled={!canAssign}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-[12.5px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {assign.isPending ? 'Assigning…' : totalAssigned > 0 ? `Assign ${totalAssigned} lead${totalAssigned === 1 ? '' : 's'}` : 'Assign leads'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* The daily restriction. Raised by the server's refusal, which is also
          where the list of affected leads comes from. Cancel simply drops it and
          leaves every existing assignment exactly as it was. */}
      {confirmSameDay && (
        <ReassignConfirm
          conflicts={confirmSameDay.conflicts}
          employee={mode === 'range' ? callers.find((c) => c.id === rangeCaller)?.name : undefined}
          busy={assign.isPending || assignRange.isPending}
          onConfirm={() => confirmSameDay.retry(true)}
          onCancel={() => setConfirmSameDay(null)}
        />
      )}
    </>
  );
}
