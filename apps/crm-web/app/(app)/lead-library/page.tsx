'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Import as ImportIcon, Plus, Clock, MapPin, Building2, Globe, PhoneCall, Tag, UserPlus, User as UserIcon, X, Hourglass, AlertTriangle, CalendarClock, Percent, Target, Zap, Undo2, Loader2, Trash2 } from 'lucide-react';
import { leadsApi, type CreateLeadInput, type DuplicateMatch, type Lead, type LeadListQuery } from '@/lib/leads';
import { LeadActivityDrawer } from '@/components/lead-activity-log';
import { LeadAssignDialog } from '@/components/lead-assign-dialog';
import { AddLeadFields } from '@/components/add-lead-fields';
import { leadColumns } from '@/components/lead-columns';
import { countriesApi } from '@/lib/crm';
import { api } from '@/lib/api';
import { useCanCall } from '@/lib/use-can-call';
import { KpiCard, KpiGrid } from '@/components/dashboard/kpi-card';
import { useLeadTimezones, useTimezoneFilterOptions, countryOfZone, zoneMatchesCountry, UNSET_TIMEZONE_LABEL } from '@/lib/timezone';
import { ClearFiltersButton, DateFilter, FilterSelect, SearchInput, optionsFrom } from '@/components/filter-controls';
import { DataTable, useColumnPrefs } from '@/components/data-table';
import { type SortState } from '@/lib/use-column-prefs';
import { LeadExportButtons } from '@/components/lead-export-buttons';
import { IconAction } from '@/components/icon-action';
import { type DateFilterValue } from '@/lib/date-filters';
import { useLeadListFilters, type Ownership } from '@/lib/lead-list-filters';
import { useSavedViews } from '@/lib/saved-views';
import { SavedViewsMenu } from '@/components/saved-views-menu';
import { LeadOutcomeFilter, LeadQuickFilters } from '@/components/lead-filters';
import { useDebounced } from '@/lib/use-debounced';
import { useInfiniteLeads, useLeadScrollSentinel } from '@/lib/use-infinite-leads';

/**
 * Lead Library — the master lead database.
 *
 * Every lead uploaded or created lands here first, assigned or not. Lead
 * Management (`/leads`) only ever shows the subset that has been assigned —
 * this page is where that assignment first happens, and where the full
 * CRUD/upload/history actions live. Once a lead has been assigned from here,
 * further reassignment happens from Lead Management, not this page: the
 * assign dialog below is opened with `allowTransfer={false}`, so an
 * already-owned lead is excluded from what gets sent rather than offered as
 * a transfer.
 *
 * Deliberately built as its own page composed from the same primitives Lead
 * Management uses (`FilterSelect`, `DataTable`, `useInfiniteLeads`, …) rather
 * than a shared component with a mode flag — same convention Closed Leads
 * already follows for "a second page shaped like the leads grid". The one
 * thing shared outright is the column list (`components/lead-columns`): the
 * two grids show the same lead the same way, and two copies of thirty columns
 * had already drifted apart.
 */


const EMPTY: CreateLeadInput = {
  businessName: '',
  phone: '',
  email: '',
  state: '',
  city: '',
  // Blank, not EST. A lead's zone is what its callbacks are booked on, and a
  // form that pre-filled Eastern made every hand-typed lead claim to be in it —
  // the same false default the import and the schema already dropped. Picking a
  // Country fills in that country's zone; otherwise it stays unset and the
  // lead reads as needing one.
  timezone: '',
  leadId: '',
  leadGenerationId: '',
  leadSource: '',
  contactName: '',
  contactName2: '',
  altPhone: '',
  website: '',
  socialMedia: '',
  country: '',
  industry: '',
  companySize: '',
  foundedYear: '',
  address: '',
  caller: '',
  callStatus: '',
  firstContact: '',
  lastContact: '',
  nextFollowUpDate: '',
  followupCount: undefined,
  meetingDate: '',
  lostReason: '',
};

const DATE_FIELD_OPTS = [
  { label: 'By Created Date', value: 'created' },
  { label: 'By Scheduled Date', value: 'scheduled' },
];

// Both states are meaningful here — Library shows the whole book, assigned
// and unassigned alike, unlike Lead Management which only ever shows
// assigned leads. Contact used to share this dropdown, so "unassigned AND
// never contacted" — the first pool a manager hands out — couldn't be asked
// for; it is the quick-filter chips now.
const OWNERSHIP_OPTS = [
  { label: 'Ownership', value: '' },
  { label: 'Assigned', value: 'assigned' },
  { label: 'Unassigned', value: 'unassigned' },
];

export default function LeadLibraryPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [form, setForm] = useState<CreateLeadInput>(EMPTY);
  const [showForm, setShowForm] = useState(false);
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data, retry: false });
  const canManage = me?.role === 'admin' || me?.role === 'team_leader';

  // The whole filter bar as one value, saved and mirrored into the URL — see
  // the same block in Lead Management and lib/lead-list-filters.
  const { filters, update, clear: clearFilters, replace: replaceFilters, activeCount } = useLeadListFilters('lead-library:filters', { employee: canManage });
  // Named filter sets, per user and per list — see lib/saved-views.
  const savedViews = useSavedViews('lead-library');
  const { q, country, tz, state, city, ownership, contact, followUp, outcomes, dateFilter, dateField, sort } = filters;
  // Managers only; a value saved by a manager isn't sent for an employee.
  const employeeId = canManage ? filters.employeeId : '';
  const setQ = (v: string) => update({ q: v });
  const setEmployeeId = (v: string) => update({ employeeId: v });
  const setDateFilter = (v: DateFilterValue) => update({ dateFilter: v });
  const setDateField = (v: 'created' | 'scheduled') => update({ dateField: v });
  const setSort = (v: SortState) => update({ sort: v });

  const debouncedQ = useDebounced(q, 250);

  // No `assigned` scoping — this is the whole book, which is the point. Lead
  // Management is the assigned-only view.
  const listQuery = useMemo<LeadListQuery>(() => ({
    closed: false,
    q: debouncedQ || undefined,
    timezone: tz || undefined,
    state: state || undefined,
    city: city || undefined,
    country: country || undefined,
    assigned: ownership || undefined,
    contact: contact || undefined,
    followUp: followUp || undefined,
    callStatus: outcomes.length ? outcomes.join(',') : undefined,
    employeeId: employeeId || undefined,
    createdFrom: dateFilter.from || undefined,
    createdTo: dateFilter.to || undefined,
    dateField,
    sortBy: sort.key,
    sortDir: sort.dir,
  }), [debouncedQ, tz, state, city, country, ownership, contact, followUp, outcomes, employeeId, dateFilter.from, dateFilter.to, dateField, sort.key, sort.dir]);

  const leadsQuery = useInfiniteLeads(listQuery);
  const { rows: leads, total, isLoading, isRefreshing, isFetchingNextPage, hasNextPage } = leadsQuery;
  const sentinelRef = useLeadScrollSentinel(leadsQuery);

  const { data: filterOpts } = useQuery({
    queryKey: ['leads', 'filter-options', country, tz, state],
    queryFn: ({ signal }) => leadsApi.filterOptions({ closed: false, country: country || undefined, timezone: tz || undefined, state: state || undefined }, signal),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
  // Who the Employee filter offers: the people who hold leads in this list,
  // from the same filter-options request as the dropdowns beside it — so a
  // team leader gets the list too (the users list is admin-only), and it never
  // offers a name with no leads behind it.
  const employeeOpts = useMemo(
    () => [{ label: 'Employees', value: '' }, ...(filterOpts?.owners ?? []).map((u) => ({ label: u.name, value: u.id }))],
    [filterOpts?.owners],
  );
  // Admin-managed list (Admin → Countries) that backs the create form's
  // Country picker — distinct from `countryOpts` below, which is the live
  // groupBy of what's actually on leads today and backs the filter instead.
  const { data: countryDefs = [] } = useQuery({ queryKey: ['countries-config'], queryFn: countriesApi.list });
  const { dial, callingEnabled } = useCanCall();
  const [activityLead, setActivityLead] = useState<Lead | null>(null);
  const [assignLeads, setAssignLeads] = useState<Lead[] | null>(null);
  const clearTableSelection = useRef<(() => void) | null>(null);

  // States cascade from the selected timezone; cities from timezone + state.
  // Country is independent (see leads.service.ts's filterOptions), not part
  // of that cascade.
  const stateOpts = optionsFrom(filterOpts?.states ?? [], 'States');
  const cityOpts = optionsFrom(filterOpts?.cities ?? [], 'Cities');
  const countryOpts = optionsFrom(filterOpts?.countries ?? [], 'Countries');
  // Relabel the reset entry rather than dropping it — a <select> needs an
  // option matching its current value, or the browser silently shows the
  // first real option instead of "nothing chosen" the moment the blank one
  // is removed.
  const tzFilterOpts = useTimezoneFilterOptions(country || null);
  const leadTzOpts = useLeadTimezones(form.country || null);
  // Picking a country keeps the zone if it belongs there, otherwise swaps in the
  // country's default — so the form can't hold India + EST.
  const pickFormCountry = (c: string) => {
    const keep = form.timezone && zoneMatchesCountry(form.timezone, c || null);
    const fallback = countryDefs.find((d) => d.code === c)?.defaultTimezone ?? '';
    setForm({ ...form, country: c, timezone: keep ? form.timezone : fallback });
  };
  const tzOpts = useMemo(
    () => tzFilterOpts.map((o) => (o.value === '' && !country ? { ...o, label: 'Time Zones' } : o)),
    [tzFilterOpts, country],
  );
  // Country -> Time Zone -> State -> City. A country drops any zone that isn't
  // in it; a zone picked with no country set fills its own country in, so the
  // pair on screen can never be India + EST.
  // One update per pick, so the cascade lands as a single change of filters.
  const pickCountry = (v: string) => {
    const keepZone = !tz || zoneMatchesCountry(tz === UNSET_TIMEZONE_LABEL ? null : tz, v || null);
    update({ country: v, tz: keepZone ? tz : '', state: '', city: '' });
  };
  const pickZone = (v: string) => {
    const owner = countryOfZone(v);
    update({ tz: v, state: '', city: '', ...(owner && !country ? { country: owner } : {}) });
  };

  // The cards count exactly what the table shows — same query, minus paging
  // and sort. See the same block in Lead Management.
  const { sortBy: _sortBy, sortDir: _sortDir, ...summaryQuery } = listQuery;
  const { data: s } = useQuery({
    queryKey: ['leads', 'summary', summaryQuery],
    queryFn: ({ signal }) => leadsApi.summary(summaryQuery, signal),
    retry: false,
    placeholderData: keepPreviousData,
  });

  const refreshAfterRemoval = () => {
    qc.invalidateQueries({ queryKey: ['leads'] });
    qc.invalidateQueries({ queryKey: ['metrics', 'summary'] });
    qc.invalidateQueries({ queryKey: ['assignments-summary'] });
    qc.invalidateQueries({ queryKey: ['caller-leads'] });
    qc.invalidateQueries({ queryKey: ['caller-dash'] });
    qc.invalidateQueries({ queryKey: ['lead-duplicates'] });
  };

  /**
   * Bulk delete ARCHIVES — the same reversible removal the Duplicate Leads purge
   * uses — so the bar below can bring the batch back. It used to be the
   * permanent cascade (calls, notes, history and all) behind a "cannot be
   * undone" prompt, on a grid with drag-select, where sweeping up a few rows
   * too many is the likeliest mistake there is.
   *
   * Archived leads leave every list, queue, count and export exactly as deleted
   * ones did. Permanent removal is still the import's own Undo.
   */
  const [undoable, setUndoable] = useState<{ ids: string[]; count: number } | null>(null);
  const removeLeads = useMutation({
    mutationFn: (rows: Lead[]) => leadsApi.bulkArchive(rows.map((l) => l.id)),
    onSuccess: (res) => {
      setUndoable(res.archived > 0 ? { ids: res.ids, count: res.archived } : null);
      refreshAfterRemoval();
    },
  });
  const restoreLeads = useMutation({
    mutationFn: (ids: string[]) => leadsApi.bulkRestore(ids),
    meta: { successMessage: 'Leads restored' },
    onSuccess: () => {
      setUndoable(null);
      refreshAfterRemoval();
    },
  });

  const [dupBlock, setDupBlock] = useState<{ message: string; duplicates: DuplicateMatch[] } | null>(null);

  const create = useMutation({
    mutationFn: (opts: { allowDuplicate?: boolean } = {}) => {
      const cleaned = Object.fromEntries(
        Object.entries(form).map(([k, v]) => [k, typeof v === 'string' && v.trim() === '' ? undefined : v]),
      ) as CreateLeadInput;
      return leadsApi.create({
        ...cleaned,
        businessName: form.businessName,
        phone: form.phone,
        state: form.state,
        city: form.city,
        ...(opts.allowDuplicate ? { allowDuplicate: true } : {}),
      });
    },
    meta: { successMessage: 'Lead created' },
    onSuccess: (lead) => {
      setDupBlock(null);
      qc.invalidateQueries({ queryKey: ['leads'] });
      router.push(`/leads/${lead.id}`);
    },
    onError: (err) => {
      const res = (err as { response?: { status?: number; data?: { message?: string; duplicates?: DuplicateMatch[] } } }).response;
      if (res?.status === 409 && res.data?.duplicates?.length) {
        setDupBlock({ message: res.data.message ?? 'This lead already exists.', duplicates: res.data.duplicates });
      }
    },
  });

  const closeForm = () => { setForm(EMPTY); setShowForm(false); setDupBlock(null); create.reset(); };

  /**
   * Possible duplicates, checked while the form is being filled in.
   *
   * `POST /leads/check-duplicate` was built for exactly this and nothing called
   * it, so a duplicate only surfaced as the 409 on save — after every other
   * field had been typed. Only a value that could actually match is sent: seven
   * or more digits of a phone, or something shaped like an email. The save
   * still runs its own check; this is the early warning, not the gate.
   */
  const dupProbe = useMemo(() => {
    const phoneish = (v?: string | null) => ((v ?? '').replace(/\D/g, '').length >= 7 ? (v ?? '').trim() : undefined);
    const phone = phoneish(form.phone);
    const altPhone = phoneish(form.altPhone);
    const email = /^\S+@\S+\.\S+$/.test((form.email ?? '').trim()) ? (form.email ?? '').trim() : undefined;
    // A string, not an object, so the debounce below settles: a fresh object
    // every render would restart its timer on every render.
    return phone || altPhone || email ? JSON.stringify({ phone, altPhone, email }) : '';
  }, [form.phone, form.altPhone, form.email]);
  const settledDupProbe = useDebounced(dupProbe, 400);
  const { data: liveDups = [] } = useQuery({
    queryKey: ['lead-dup-check', settledDupProbe],
    queryFn: () => leadsApi.checkDuplicate(JSON.parse(settledDupProbe)),
    enabled: showForm && canManage && settledDupProbe !== '',
    staleTime: 30_000,
    retry: false,
  });
  // Shown only while the value it was checked for is still the one typed.
  const showLiveDups = liveDups.length > 0 && !dupBlock && settledDupProbe === dupProbe;

  // The grid's columns are shared with Lead Management — see components/lead-columns.
  // What differs between the pages is what they let you do with a lead.
  const columns = useMemo(() => leadColumns({
    onCall: callingEnabled ? (l) => { if (!dial(l.phone)) return; router.push(`/calling?leadId=${l.id}&autocall=1`); } : undefined,
    // Lead history is Admin + Team Leader only on the API, so only they get the button.
    onHistory: canManage ? setActivityLead : undefined,
    canEditLostReason: canManage,
  }), [router, dial, callingEnabled, canManage]);

  const prefs = useColumnPrefs('lead-library', columns, 1);


  return (
    <div>

      <KpiGrid>
        <KpiCard icon={Target} iconBg="var(--tone-blue-bg)" iconColor="var(--tone-blue-fg)" value={(s?.totalLeads ?? 0).toLocaleString()} label="Total Leads" />
        <KpiCard icon={Zap} iconBg="var(--brand-surface)" iconColor="var(--brand-on-surface)" value={(s?.assignedLeads ?? 0).toLocaleString()} label="Assigned Leads" />
        <KpiCard icon={PhoneCall} iconBg="var(--tone-teal-bg)" iconColor="var(--tone-teal-fg)" value={(s?.contactedLeads ?? 0).toLocaleString()} label="Contacted" />
        <KpiCard icon={Hourglass} iconBg="var(--tone-amber-bg)" iconColor="var(--tone-amber-fg)" value={(s?.balanceLeads ?? 0).toLocaleString()} label="Balance Leads" />
        <KpiCard icon={Percent} iconBg="var(--brand-surface-2)" iconColor="var(--brand-on-surface)" value={`${s?.progressPct ?? 0}%`} label="Progress" />
      </KpiGrid>

      <LeadQuickFilters
        followUp={followUp}
        contact={contact}
        onChange={update}
        counts={s?.chips}
        // The page's actions ride at the right of this row instead of taking a
        // row of their own above the cards — see LeadQuickFilters.
        trailing={
          <>
            {/* Compact icon actions — each name shows on hover, focus or tap.
                See components/icon-action. */}
            {/* Where deleted leads go — restorable, or removable for good by an admin. */}
            <IconAction icon={Trash2} label="Recently deleted" href="/lead-library/deleted" />
            <IconAction icon={ImportIcon} label="Import CSV" href="/import" />
            {/* The whole filtered list, however long — see lib/use-lead-export. */}
            <LeadExportButtons query={listQuery} fileBase="lead-library" disabled={total === 0} />
            {/* Route/nav are already manager-only; the check here is defense in
                depth, matching every other action on this page. */}
            {canManage && <IconAction icon={Plus} label="Add Lead" variant="primary" onClick={() => setShowForm(true)} />}
          </>
        }
        leading={
          <SavedViewsMenu
            views={savedViews.views}
            current={filters}
            onApply={replaceFilters}
            onSave={(name) => savedViews.save(name, filters)}
            onDelete={savedViews.remove}
          />
        }
      />

      {/* Filter order: Time Zone, Country, State, City, Employee — Country
          sits right after Time Zone, ahead of the State/City cascade. */}
      <div className="mb-[18px] flex flex-wrap items-center gap-2.5 lg:flex-nowrap">
        <SearchInput value={q} onChange={setQ} placeholder="Search business, ID, phone, email…" className="min-w-[260px] flex-[2]" />
        <FilterSelect className="min-w-0 flex-1" icon={Globe} value={country} onChange={pickCountry} options={countryOpts} />
        <FilterSelect className="min-w-0 flex-1" icon={Clock} value={tz} onChange={pickZone} options={tzOpts} />
        <FilterSelect className="min-w-0 flex-1" icon={MapPin} value={state} onChange={(v) => update({ state: v, city: '' })} options={stateOpts} />
        <FilterSelect className="min-w-0 flex-1" icon={Building2} value={city} onChange={(v) => update({ city: v })} options={cityOpts} />
        {canManage && <FilterSelect className="min-w-0 flex-1" icon={UserIcon} value={employeeId} onChange={setEmployeeId} options={employeeOpts} />}
        <FilterSelect className="min-w-0 flex-1" icon={Tag} value={ownership} onChange={(v) => update({ ownership: v as Ownership })} options={OWNERSHIP_OPTS} />
        <LeadOutcomeFilter className="min-w-0 flex-1" value={outcomes} onChange={(v) => update({ outcomes: v })} />
        <FilterSelect className="min-w-0 flex-1" icon={CalendarClock} value={dateField} onChange={(v) => setDateField(v as 'created' | 'scheduled')} options={DATE_FIELD_OPTS} />
        <DateFilter value={dateFilter} onChange={setDateFilter} iconOnly />
        <ClearFiltersButton count={activeCount} onClear={clearFilters} />
      </div>

      {/* Undo for the last bulk delete — a bar rather than a toast, like the
          Duplicate Leads purge: the rows a drag swept up by mistake are
          noticed a moment later, after a four-second toast has gone. */}
      {undoable && (
        <div className="mb-[18px] flex flex-wrap items-center gap-3 rounded-xl border border-[var(--brand-edge)] bg-[var(--brand-surface)] px-4 py-3">
          <Undo2 className="h-4 w-4 shrink-0 text-[var(--brand-on-surface)]" />
          <span className="flex-1 text-[12.5px] text-[var(--brand-on-surface)]">
            <b className="font-semibold">{undoable.count}</b> {undoable.count === 1 ? 'lead' : 'leads'} deleted. Their calls,
            notes and history are kept, so they can still be brought back — here, or later from Recently deleted.
          </span>
          <button
            onClick={() => restoreLeads.mutate(undoable.ids)}
            disabled={restoreLeads.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-[12.5px] font-semibold text-primary-foreground disabled:opacity-60"
          >
            {restoreLeads.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
            {restoreLeads.isPending ? 'Restoring…' : 'Undo'}
          </button>
          <button
            onClick={() => setUndoable(null)}
            className="rounded-md border bg-card px-3 py-2 text-[12.5px] font-medium hover:bg-muted"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Add Lead opens as a popup over the page rather than a panel pushed
          into it. A click on the backdrop does NOT close it: the form runs to
          two dozen fields, and one stray click outside would throw them all
          away. The X, Cancel and Escape close it. */}
      {showForm && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-lead-title"
          tabIndex={-1}
          onKeyDown={(e) => { if (e.key === 'Escape' && !create.isPending) closeForm(); }}
        >
          <form
            onSubmit={(e) => { e.preventDefault(); setDupBlock(null); create.mutate({}); }}
            className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl"
          >
            <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
              <h3 id="add-lead-title" className="font-display text-[14px] font-semibold">Add Lead</h3>
              <button
                type="button"
                onClick={closeForm}
                disabled={create.isPending}
                title="Close"
                aria-label="Close add lead form"
                className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto overscroll-contain p-5 sm:grid-cols-2 lg:grid-cols-3">
              <AddLeadFields
                form={form}
                onChange={(patch) => setForm({ ...form, ...patch })}
                onCountry={pickFormCountry}
                countries={countryDefs}
                zones={leadTzOpts}
              />
              {dupBlock && (
                <div className="col-span-full rounded-lg border border-[var(--tone-amber-line)] bg-[var(--tone-amber-bg)]/60 p-3.5">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--tone-amber-fg-strong)]" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[12.5px] font-semibold text-[#664304]">{dupBlock.message}</div>
                      <ul className="mt-2 space-y-1.5">
                        {dupBlock.duplicates.map((m) => (
                          <li key={m.id} className="text-[12px]">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <span className="font-mono text-[11px] text-primary">{m.leadId}</span>
                              <b>{m.businessName || 'Unnamed lead'}</b>
                              <span className="rounded-full bg-[var(--tone-amber-bg)] px-2 py-0.5 text-[10px] font-semibold text-[var(--tone-amber-fg-strong)]">
                                {m.matchedOn.join(', ')}
                              </span>
                            </span>
                            <span className="block font-mono text-[11px] text-muted-foreground">
                              {[m.phone, m.altPhone, m.email].filter(Boolean).join(' · ')} · {m.assignedTo ?? 'Unassigned'}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => router.push(`/leads/${dupBlock.duplicates[0].id}`)}
                          className="rounded-md border bg-card px-3 py-1.5 text-[12px] font-semibold hover:bg-muted"
                        >
                          Open {dupBlock.duplicates[0].leadId} instead
                        </button>
                        <button
                          type="button"
                          onClick={() => create.mutate({ allowDuplicate: true })}
                          disabled={create.isPending}
                          className="rounded-md border border-[var(--tone-red-line)] bg-card px-3 py-1.5 text-[12px] font-semibold text-[var(--tone-red-fg)] hover:bg-[var(--tone-red-bg-2)] disabled:opacity-60"
                        >
                          Create it anyway
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Outside the scrolling grid on purpose: shown above the fields it
                would push the Phone box down under the cursor mid-typing, and
                below them it would be out of sight. Here it is always visible
                and moves nothing. */}
            {showLiveDups && (
              <div role="status" className="flex flex-wrap items-center gap-2 border-t border-[var(--tone-amber-line)] bg-[var(--tone-amber-bg)] px-5 py-2.5 text-[12px] text-[var(--tone-amber-fg-strong)]">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  {liveDups.length === 1 ? 'Possible duplicate: ' : `${liveDups.length} possible duplicates: `}
                  {liveDups.slice(0, 3).map((m, i) => (
                    <span key={m.id}>
                      {i > 0 && ', '}
                      <span className="font-mono text-[11px]">{m.leadId}</span> <b>{m.businessName || 'Unnamed lead'}</b> ({m.matchedOn.join(', ')})
                    </span>
                  ))}
                  {liveDups.length > 3 && ` +${liveDups.length - 3} more`}
                </span>
                <button
                  type="button"
                  onClick={() => router.push(`/leads/${liveDups[0].id}`)}
                  className="rounded-md border bg-card px-2.5 py-1 text-[11.5px] font-semibold text-foreground hover:bg-muted"
                >
                  Open {liveDups[0].leadId}
                </button>
              </div>
            )}

            <div className="flex items-center gap-3 border-t px-5 py-3.5">
              <button type="submit" disabled={create.isPending} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
                {create.isPending ? 'Creating…' : 'Create & open'}
              </button>
              <button type="button" onClick={closeForm} disabled={create.isPending} className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60">
                Cancel
              </button>
              {create.isError && !dupBlock && <span className="text-sm text-[var(--tone-red-fg)]">Failed to create lead</span>}
            </div>
          </form>
        </div>
      )}

      <DataTable
        tableKey="lead-library"
        columns={columns}
        rows={leads}
        getRowKey={(l) => l.id}
        title="Lead Library"
        subtitle={
          isLoading
            ? 'Loading leads…'
            : total === 0
              ? 'No leads'
              : leads.length >= total
                ? `${total.toLocaleString()} lead${total === 1 ? '' : 's'}`
                : `${leads.length.toLocaleString()} of ${total.toLocaleString()} loaded — scroll for more`
        }
        loading={isLoading}
        refreshing={isRefreshing}
        emptyText="No leads match the current filters."
        prefs={prefs}
        fillViewport
        selectable
        dragSelect
        sort={sort}
        onSortChange={setSort}
        uppercaseHeaders
        onDeleteSelected={async (rows) => { await removeLeads.mutateAsync(rows); }}
        deleteConfirm={(rows) => `Delete ${rows.length} selected lead${rows.length === 1 ? '' : 's'}? You can undo this straight afterwards.`}
        bulkActions={(rows, clear) => (
          <button
            onClick={() => { clearTableSelection.current = clear; setAssignLeads(rows); }}
            title="Assign selected leads to an employee"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[12px] font-semibold text-foreground hover:bg-muted"
          >
            <UserPlus className="h-4 w-4" /> Assign
          </button>
        )}
      />

      <div ref={sentinelRef} className="mt-3 flex items-center justify-center gap-3 py-2">
        {hasNextPage ? (
          <button
            type="button"
            onClick={() => leadsQuery.fetchNextPage()}
            disabled={isFetchingNextPage || leadsQuery.isPlaceholderData}
            className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-[12px] font-semibold hover:bg-muted disabled:opacity-50"
          >
            {isFetchingNextPage ? 'Loading more…' : `Load more (${(total - leads.length).toLocaleString()} left)`}
          </button>
        ) : (
          total > 0 && <p className="text-[11.5px] text-muted-foreground">All {total.toLocaleString()} leads loaded.</p>
        )}
      </div>

      {activityLead && (
        <LeadActivityDrawer leadId={activityLead.id} leadName={activityLead.businessName} onClose={() => setActivityLead(null)} />
      )}

      {/* First-time assignment only — an already-owned lead is excluded, not
          offered for transfer. Reassignment happens from Lead Management. */}
      {assignLeads && (
        <LeadAssignDialog
          leads={assignLeads}
          onClose={() => setAssignLeads(null)}
          onAssigned={() => clearTableSelection.current?.()}
          allowTransfer={false}
        />
      )}
    </div>
  );
}
