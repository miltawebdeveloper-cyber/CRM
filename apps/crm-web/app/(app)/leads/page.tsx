'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, MapPin, Building2, Globe, Zap, Percent, RefreshCw, PhoneCall, UserPlus, UserMinus, User as UserIcon, Hourglass, CalendarClock } from 'lucide-react';
import { leadsApi, type Lead, type LeadListQuery } from '@/lib/leads';
import { LeadAssignDialog } from '@/components/lead-assign-dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { LeadOutcomeFilter, LeadQuickFilters } from '@/components/lead-filters';
import { LeadActivityDrawer } from '@/components/lead-activity-log';
import { leadColumns } from '@/components/lead-columns';
import { assignmentsApi } from '@/lib/crm';
import { api } from '@/lib/api';
import { useCanCall } from '@/lib/use-can-call';
import { PageHead } from '@/components/page-head';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { useTimezoneFilterOptions, countryOfZone, zoneMatchesCountry, UNSET_TIMEZONE_LABEL } from '@/lib/timezone';
import { ClearFiltersButton, DateFilter, FilterSelect, SearchInput, optionsFrom } from '@/components/filter-controls';
import { DataTable, useColumnPrefs } from '@/components/data-table';
import { type SortState } from '@/lib/use-column-prefs';
import { LeadExportButtons } from '@/components/lead-export-buttons';
import { type DateFilterValue } from '@/lib/date-filters';
import { useLeadListFilters } from '@/lib/lead-list-filters';
import { useSavedViews } from '@/lib/saved-views';
import { SavedViewsMenu } from '@/components/saved-views-menu';
import { useDebounced } from '@/lib/use-debounced';
import { useInfiniteLeads, useLeadScrollSentinel } from '@/lib/use-infinite-leads';
import { pushToast } from '@/lib/toast';

/**
 * What the date filter beside this one is filtering on.
 *
 * "Created Date" is the lead's original arrival — the date it was first created,
 * which nothing afterwards rewrites. "Scheduled Date" is the day it is currently
 * queued to be worked, which moves when the lead is reassigned or carried into
 * the next day. Both are shown as columns, and both are exported.
 */
const DATE_FIELD_OPTS = [
  { label: 'By Created Date', value: 'created' },
  { label: 'By Scheduled Date', value: 'scheduled' },
];

/** "the queues of Ann (8) and Bob (4)" — whose work an Unassign takes away. */
function ownerSummary(rows: Lead[]): string {
  const counts = new Map<string, number>();
  for (const l of rows) {
    const name = l.assignedTo?.name ?? 'nobody';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const parts = [...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} (${n})`);
  const shown = parts.length > 3 ? [...parts.slice(0, 3), `${parts.length - 3} more`] : parts;
  const list = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0];
  return `the queue${counts.size === 1 ? '' : 's'} of ${list}`;
}

export default function LeadsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data, retry: false });
  const canManage = me?.role === 'admin' || me?.role === 'team_leader';

  // The whole filter bar as one value — saved per browser and mirrored into the
  // URL, so opening a lead and coming back (by Back, the menu, or a shared link)
  // restores the view instead of resetting every control. See lead-list-filters.
  const { filters, update, clear: clearFilters, replace: replaceFilters, activeCount } = useLeadListFilters('leads:filters', { employee: canManage });
  // Named filter sets, per user and per list — see lib/saved-views.
  const savedViews = useSavedViews('leads');
  // No ownership filter here: this page only ever lists assigned leads (Lead
  // Library shows both). Contact and follow-up are the quick-filter chips.
  const { q, country, tz, state, city, contact, followUp, outcomes, dateFilter, dateField, sort } = filters;
  // Whose leads to show. Managers only (admin, team leader) — the API ignores
  // this parameter for an employee, so the control is hidden rather than merely
  // disabled, and a value saved by a manager in a shared browser is not sent
  // for an employee.
  const employeeId = canManage ? filters.employeeId : '';
  const setQ = (v: string) => update({ q: v });
  const setEmployeeId = (v: string) => update({ employeeId: v });
  const setDateFilter = (v: DateFilterValue) => update({ dateFilter: v });
  const setSort = (v: SortState) => update({ sort: v });
  /**
   * Which of a lead's two dates the date filter above applies to.
   *
   * A lead carries both — when it was created, and which day it is currently
   * scheduled to be worked — and picking a day means a different set of leads
   * depending on which one you mean. On `created` (the default, and how this
   * filter has always behaved) "today" is the leads that arrived today. On
   * `scheduled` it is the leads on today's queue, which includes every lead
   * created earlier that was carried into today because its call never
   * completed. That second set is the one a manager means by "today's leads",
   * and exporting the first while calling it the second is what left carried
   * leads out of the file.
   */
  const setDateField = (v: 'created' | 'scheduled') => update({ dateField: v });
  // Lead lists open in IMPORT order — row 1 of the uploaded file first — until
  // the user sorts by something else. Declared here because the list query below
  // is built from it: ordering is the server's job, not a pass over rows already
  // downloaded. Was `leadId`, which the API had to reinterpret because sorting
  // the id as a string puts L-2026-10 ahead of L-2026-2. That default lives in
  // DEFAULT_LEAD_LIST_FILTERS now, with the rest of the bar.

  // Only active leads — one marked closed moves to /closed-leads.
  //
  // Scope is the API's call, not a flag from here: an employee is pinned to their
  // own assigned leads (so no two employees ever see the same lead), while a
  // manager gets the whole book, which is what makes the select-and-distribute
  // flow below possible at all. Asking for `mine` here would leave a manager with
  // nothing to hand out.
  // One continuous list of every lead, filled in as it is scrolled.
  //
  // No page numbers: the panel reads as the whole book, and scrolling to the
  // bottom brings the next chunk. The wire still carries a chunk at a time,
  // which is the point — this module used to download the entire book before it
  // could show anything, and removing the paging controls by going back to that
  // would just trade the controls for the wait.
  //
  // Every filter below is a query parameter, so the list being scrolled is the
  // filtered one, not a filtered view of whatever happened to be downloaded.
  const debouncedQ = useDebounced(q, 250);

  const listQuery = useMemo<LeadListQuery>(() => ({
    closed: false,
    q: debouncedQ || undefined,
    timezone: tz || undefined,
    state: state || undefined,
    city: city || undefined,
    country: country || undefined,
    // Lead Management only ever shows assigned leads — Lead Library is where
    // an unassigned lead lives until its first assignment. Hardcoded rather
    // than a status option: for an employee this is already a no-op (their
    // book is server-side scoped to their own assignedToId regardless), and
    // for a manager it's exactly the new intended default.
    assigned: 'assigned',
    contact: contact || undefined,
    followUp: followUp || undefined,
    callStatus: outcomes.length ? outcomes.join(',') : undefined,
    employeeId: employeeId || undefined,
    createdFrom: dateFilter.from || undefined,
    createdTo: dateFilter.to || undefined,
    dateField,
    sortBy: sort.key,
    sortDir: sort.dir,
  }), [debouncedQ, tz, state, city, country, contact, followUp, outcomes, employeeId, dateFilter.from, dateFilter.to, dateField, sort.key, sort.dir]);

  // Changing a filter or the sort changes the query key, so the list starts
  // again from the top on its own — no page number to reset.
  // `isLoading` here means "there is nothing to show yet" — the first visit, or
  // a filter combination never fetched before. Every LATER change keeps the rows
  // it already has and reports `isRefreshing` instead, so the grid updates in
  // place rather than emptying and refilling. See `useInfiniteLeads`.
  const leadsQuery = useInfiniteLeads(listQuery);
  const { rows: leads, total, isLoading, isRefreshing, isFetchingNextPage, hasNextPage } = leadsQuery;
  const sentinelRef = useLeadScrollSentinel(leadsQuery);

  // The dropdown values come from the whole book, not from the page on screen —
  // a filter offering only the cities that happen to be on page 3 is no filter.
  const { data: filterOpts } = useQuery({
    queryKey: ['leads', 'filter-options', country, tz, state],
    queryFn: ({ signal }) => leadsApi.filterOptions({ closed: false, country: country || undefined, timezone: tz || undefined, state: state || undefined }, signal),
    staleTime: 5 * 60_000,
    // Keys on the zone and the state, so picking either one changes the key and
    // would otherwise leave `filterOpts` undefined for the length of a request —
    // during which the State and City menus collapse to just their "All" entry
    // and the chosen value disappears out of the control the user is holding.
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
  // Refuse to dial before the API would reject the call (no assigned caller ID),
  // since the Quo app handoff fires first and can't be taken back.
  const { dial, callingEnabled } = useCanCall();
  // Employees (any non-manager role) get a self-scoped view: they see only their
  // own leads, and their KPI cards are derived from that book.
  const isEmployee = !!me && !canManage;
  const [assignLeads, setAssignLeads] = useState<Lead[] | null>(null);  // Reassign popup (managers only)
  const [activityLead, setActivityLead] = useState<Lead | null>(null);  // History drawer (managers only)
  const [unassignLeads, setUnassignLeads] = useState<Lead[] | null>(null); // Unassign confirmation (managers only)

  /**
   * Bulk Unassign — the selected leads go back to the Lead Library's unassigned
   * pool. Before this, taking a lead off someone without handing it to somebody
   * else meant opening each lead's own page. The server re-checks ownership at
   * the moment of the write, so a lead that changed hands since the grid loaded
   * is left with its new owner and reported as skipped.
   */
  const unassign = useMutation({
    mutationFn: (rows: Lead[]) => assignmentsApi.unassign(rows.map((l) => l.id)),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['assignments-summary'] });
      qc.invalidateQueries({ queryKey: ['metrics', 'summary'] });
      qc.invalidateQueries({ queryKey: ['caller-leads'] });
      qc.invalidateQueries({ queryKey: ['caller-dash'] });
      pushToast(
        'success',
        `${r.unassigned.toLocaleString()} lead${r.unassigned === 1 ? '' : 's'} returned to the Lead Library` +
          (r.skipped ? ` · ${r.skipped} skipped (no longer assigned to the same person)` : ''),
      );
      clearTableSelection.current?.();
    },
  });
  const clearTableSelection = useRef<(() => void) | null>(null);        // set from DataTable's bulkActions clear fn

  // Bulk-push every not-yet-synced lead to Quo/OpenPhone as a contact.
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const syncAll = useMutation({
    // Runs as a background job on the server; the banner counts it up live.
    mutationFn: () =>
      leadsApi.syncAllToQuo((done, total) => {
        if (total > 0) setSyncMsg(`Syncing… ${done.toLocaleString()} of ${total.toLocaleString()}`);
      }),
    meta: { suppressErrorToast: true }, // shows its own inline result banner
    onSuccess: (r) => {
      setSyncMsg(
        r.total === 0
          ? 'All leads already synced.'
          : `Synced ${r.synced} of ${r.total}${r.failed ? ` · ${r.failed} failed` : ''}${r.sandbox ? ' (sandbox)' : ''}.`,
      );
      qc.invalidateQueries({ queryKey: ['leads'] });
    },
    onError: () => setSyncMsg('Sync failed — check the API is running and OpenPhone is configured.'),
  });

  // Export covers the whole FILTERED result set, not the page on screen.
  //
  // It used to map over `leads`, which was every row the page had downloaded and
  // filtered — the same thing. Now that the grid holds one page, mapping it
  // would quietly export fifty rows and call it the export. So it asks the API
  // for the same query without paging, and only then builds the file.
  //
  // The columns themselves live in `lib/lead-export`, where each heading and the
  // value that fills it are declared together — see the note there.

  // States cascade from the selected timezone; cities from timezone + state —
  // the cascade the API applies when it groups them, so these read the same as
  // when they were built from the downloaded book. Country is independent of
  // that cascade — see leads.service.ts's filterOptions.
  const stateOpts = optionsFrom(filterOpts?.states ?? [], 'States');
  const cityOpts = optionsFrom(filterOpts?.cities ?? [], 'Cities');
  const countryOpts = optionsFrom(filterOpts?.countries ?? [], 'Countries');
  // Relabel the reset entry rather than dropping it — a <select> needs an
  // option matching its current value, or the browser silently shows the
  // first real option instead of "nothing chosen" the moment the blank one
  // is removed.
  const tzFilterOpts = useTimezoneFilterOptions(country || null);
  const tzOpts = useMemo(
    () => tzFilterOpts.map((o) => (o.value === '' && !country ? { ...o, label: 'Time Zones' } : o)),
    [tzFilterOpts, country],
  );
  // Country -> Time Zone -> State -> City. A country drops any zone that isn't
  // in it; a zone picked with no country set fills its own country in, so the
  // pair on screen can never be India + EST.
  // One update per pick, so the cascade lands as a single change of filters
  // (one request, one URL write) rather than four.
  const pickCountry = (v: string) => {
    const keepZone = !tz || zoneMatchesCountry(tz === UNSET_TIMEZONE_LABEL ? null : tz, v || null);
    update({ country: v, tz: keepZone ? tz : '', state: '', city: '' });
  };
  const pickZone = (v: string) => {
    const owner = countryOfZone(v);
    update({ tz: v, state: '', city: '', ...(owner && !country ? { country: owner } : {}) });
  };

  // KPI cards count exactly what the table shows: the same query, minus paging
  // and sort, counted by the API (`GET /leads/summary`). They used to come from
  // the dashboard summary, which knew only the date range — so filtering the
  // grid to one state left the cards still counting the whole book.
  const { sortBy: _sortBy, sortDir: _sortDir, ...summaryQuery } = listQuery;
  const { data: s } = useQuery({
    queryKey: ['leads', 'summary', summaryQuery],
    queryFn: ({ signal }) => leadsApi.summary(summaryQuery, signal),
    retry: false,
    // The filters are part of the key, so changing one would drop every card to
    // "0" until the new counts land. Holding the previous figures for a moment
    // is a smaller lie than reporting zero leads to someone who has just
    // changed a filter.
    placeholderData: keepPreviousData,
  });

  // The grid's columns are shared with Lead Library — see components/lead-columns.
  // What differs between the pages is what they let you do with a lead.
  const columns = useMemo(() => leadColumns({
    onCall: callingEnabled ? (l) => { if (!dial(l.phone)) return; router.push(`/calling?leadId=${l.id}&autocall=1`); } : undefined,
    // Lead history is Admin + Team Leader only on the API, so only they get the button.
    onHistory: canManage ? setActivityLead : undefined,
    canEditLostReason: canManage,
  }), [router, dial, callingEnabled, canManage]);

  // Shared column prefs for Column Customization (visibility/order).
  //
  // Revision 1: the date-only "Created Date" was withdrawn and Created Date &
  // Time, Scheduled Date and Movement put in its place. That is a decision about
  // what this module shows, not a suggestion — so a saved layout from before it
  // adopts the new order once, instead of leaving anyone who had ever dragged or
  // hidden a column looking at the old arrangement with the new columns pushed
  // off the right-hand edge. Hidden columns and widths are kept; only the
  // arrangement is taken. See `useColumnPrefs`.
  const prefs = useColumnPrefs('leads', columns, 1);

  // Filtering and sorting used to happen here, over the whole downloaded book —
  // a pass across every lead on every keystroke, followed by a re-render of
  // every row. Both are the API's job now (see `listQuery`), which is what lets
  // this list start with a screenful rather than the whole book.


  return (
    <div>
      <PageHead>
        {/* The whole filtered list, however long — see lib/use-lead-export. */}
        <LeadExportButtons query={listQuery} fileBase="leads" disabled={total === 0} />
        {canManage && (
          <button
            onClick={() => { setSyncMsg(null); syncAll.mutate(); }}
            disabled={syncAll.isPending}
            title="Push every not-yet-synced lead to QUO/OpenPhone as a contact"
            className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[12.5px] font-semibold hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${syncAll.isPending ? 'animate-spin' : ''}`} />
            {syncAll.isPending ? 'Syncing…' : 'Sync all to QUO'}
          </button>
        )}
      </PageHead>
      {syncMsg && (
        <div className="mb-3 rounded-md border bg-muted/50 px-3 py-2 text-[12.5px] text-muted-foreground">{syncMsg}</div>
      )}

      {/* KPIs — for employees every card is derived from their own assigned book.
          All four counts come straight from the API under one set of rules, so
          this row reads the same as the dashboard's. The "Assigned Leads" card
          used to show `plannedLeads` for a manager — the territory's monthly
          TARGET, not the number of leads anyone had been given — which made
          Balance and Progress answer a different question than their labels. */}
      <div className="mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        {/* No "Total Leads" here: this page lists assigned leads only, so it
            always equalled Assigned Leads. The Library, which lists both, keeps it. */}
        <KpiCard icon={Zap} iconBg="var(--brand-surface)" iconColor="var(--brand-on-surface)" value={(s?.assignedLeads ?? 0).toLocaleString()} label="Assigned Leads" />
        <KpiCard icon={PhoneCall} iconBg="var(--tone-teal-bg)" iconColor="var(--tone-teal-fg)" value={(s?.contactedLeads ?? 0).toLocaleString()} label="Contacted" />
        <KpiCard icon={Hourglass} iconBg="var(--tone-amber-bg)" iconColor="var(--tone-amber-fg)" value={(s?.balanceLeads ?? 0).toLocaleString()} label="Balance Leads" />
        <KpiCard icon={Percent} iconBg="var(--brand-surface-2)" iconColor="var(--brand-on-surface)" value={`${s?.progressPct ?? 0}%`} label="Progress" />
      </div>

      <LeadQuickFilters
        followUp={followUp}
        contact={contact}
        onChange={update}
        counts={s?.chips}
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

      {/* Filter bar — one row on a laptop and up.
          Each control takes `min-w-0 flex-1` so the row divides its width between
          them rather than letting any one take its intrinsic size. A native
          `<select>` is otherwise as wide as its longest option — the longest
          employee name, the longest city — which is what overflowed the row and
          wrapped the date filter onto a line of its own. Below `lg` it still
          wraps, which is what a tablet and a phone want. */}
      <div className="mb-[18px] flex flex-wrap items-center gap-2.5 lg:flex-nowrap">
        <SearchInput value={q} onChange={setQ} placeholder="Search business, ID, phone, email…" className="min-w-[260px] flex-[2]" />
        <FilterSelect className="min-w-0 flex-1" icon={Globe} value={country} onChange={pickCountry} options={countryOpts} />
        <FilterSelect className="min-w-0 flex-1" icon={Clock} value={tz} onChange={pickZone} options={tzOpts} />
        <FilterSelect className="min-w-0 flex-1" icon={MapPin} value={state} onChange={(v) => update({ state: v, city: '' })} options={stateOpts} />
        <FilterSelect className="min-w-0 flex-1" icon={Building2} value={city} onChange={(v) => update({ city: v })} options={cityOpts} />
        {/* Managers only. Hidden rather than disabled for an employee, who
            is already pinned to their own book. */}
        {canManage && <FilterSelect className="min-w-0 flex-1" icon={UserIcon} value={employeeId} onChange={setEmployeeId} options={employeeOpts} />}
        {/* The configured outcome list (Admin → Outcomes), several at once. */}
        <LeadOutcomeFilter className="min-w-0 flex-1" value={outcomes} onChange={(v) => update({ outcomes: v })} />
        {/* Sits immediately before the calendar because it says what the calendar
            means. Picking a day is ambiguous on its own — created that day, or
            queued for that day — and these are different sets of leads the
            moment anything is carried forward. */}
        <FilterSelect className="min-w-0 flex-1" icon={CalendarClock} value={dateField} onChange={(v) => setDateField(v as 'created' | 'scheduled')} options={DATE_FIELD_OPTS} />
        <DateFilter value={dateFilter} onChange={setDateFilter} iconOnly />
        <ClearFiltersButton count={activeCount} onClear={clearFilters} />
      </div>

      {/* Table */}
      <DataTable
        tableKey="leads"
        columns={columns}
        rows={leads}
        getRowKey={(l) => l.id}
        title="Assigned Leads"
        // How many are in the list, and how many the list holds in total. Both,
        // because "50 leads" under a filter matching 40,000 would read as a
        // filter that had thrown almost everything away.
        subtitle={
          // "No leads" is a claim, and it must not be made while the first page
          // is still in the air — the grid below is showing "Loading…" at that
          // moment, and the two used to contradict each other.
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
        // Excel-style viewport: header pinned, horizontal scrollbar always on
        // screen. Lead Management has the most columns, so it needs it most.
        fillViewport
        selectable
        // Drag across rows to select a run of leads, then assign them in one go —
        // far quicker than ticking hundreds of boxes after a bulk import.
        dragSelect
        // A lead has exactly one owner, so one that already belongs to someone is
        // locked out of selection entirely — that keeps it out of select-all and
        // drag sweeps, which is where a bulk assignment would otherwise quietly
        // take it off them.
        sort={sort}
        onSortChange={setSort}
        // Lead Management headings read as capitals; the underlying column names stay
        // mixed-case for the Column Chooser and the CSV/Excel export.
        uppercaseHeaders
        // No delete here — that's master-data, Lead Library's job. Every row
        // stays selectable purely for Reassign: the Assign dialog names any
        // already-owned lead in the selection and leaves it out of the pool
        // unless the manager deliberately chooses to transfer it, and the API
        // refuses the move regardless of what the client sends unless that
        // choice was made. The "Assigned" badge on each row shows who holds it.
        bulkActions={canManage ? (rows, clear) => (
          <>
            <button
              onClick={() => { clearTableSelection.current = clear; setAssignLeads(rows); }}
              title="Reassign selected leads to another employee"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[12px] font-semibold text-foreground hover:bg-muted"
            >
              <UserPlus className="h-4 w-4" /> Reassign
            </button>
            <button
              onClick={() => { clearTableSelection.current = clear; setUnassignLeads(rows); }}
              title="Take the selected leads off their owners and return them to the Lead Library"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[12px] font-semibold text-foreground hover:bg-muted"
            >
              <UserMinus className="h-4 w-4" /> Unassign
            </button>
          </>
        ) : undefined}
      />

      {/* End of the list. The marker is what asks for the next chunk when it
          scrolls into view; the button beside it is for anyone who never
          reaches it — a keyboard user, or a viewport the observer can't see
          into. Both do the same thing, so neither is the only way through. */}
      <div ref={sentinelRef} className="mt-3 flex items-center justify-center gap-3 py-2">
        {hasNextPage ? (
          <button
            type="button"
            onClick={() => leadsQuery.fetchNextPage()}
            // Also off while the rows on screen belong to the outgoing query —
            // paging that one on would append its chunk 2 to a list about to be
            // replaced by a different filter's chunk 1.
            disabled={isFetchingNextPage || leadsQuery.isPlaceholderData}
            className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-[12px] font-semibold hover:bg-muted disabled:opacity-50"
          >
            {isFetchingNextPage ? 'Loading more…' : `Load more (${(total - leads.length).toLocaleString()} left)`}
          </button>
        ) : (
          total > 0 && <p className="text-[11.5px] text-muted-foreground">All {total.toLocaleString()} leads loaded.</p>
        )}
      </div>


      {/* Ownership trail + activity log, without leaving the list. Only managers
          can open it — the button isn't rendered for anyone else. */}
      {activityLead && (
        <LeadActivityDrawer leadId={activityLead.id} leadName={activityLead.businessName} onClose={() => setActivityLead(null)} />
      )}

      {/* Names whose queues the leads leave — "12 leads" alone doesn't tell a
          manager they are about to empty one rep's afternoon. */}
      {unassignLeads && (
        <ConfirmDialog
          title={`Unassign ${unassignLeads.length.toLocaleString()} lead${unassignLeads.length === 1 ? '' : 's'}?`}
          message={
            <>
              {unassignLeads.length === 1 ? 'It' : 'They'} will leave {ownerSummary(unassignLeads)} and go back to the Lead
              Library as Unassigned. Calls, notes and history stay with each lead.
            </>
          }
          confirmLabel="Unassign"
          onConfirm={async () => { await unassign.mutateAsync(unassignLeads); }}
          onClose={() => setUnassignLeads(null)}
        />
      )}

      {/* Employee-wise assign popup — Admin / Team Leader */}
      {assignLeads && (
        <LeadAssignDialog
          leads={assignLeads}
          onClose={() => setAssignLeads(null)}
          onAssigned={() => clearTableSelection.current?.()}
        />
      )}
    </div>
  );
}
