'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Upload, Eye, Clock, MapPin, Building2, PhoneCall, Info } from 'lucide-react';
import { leadsApi, type Lead, type LeadListQuery } from '@/lib/leads';
import { useDebounced } from '@/lib/use-debounced';
import { useInfiniteLeads, useLeadScrollSentinel } from '@/lib/use-infinite-leads';
import { LeadActivityDrawer } from '@/components/lead-activity-log';
import { TimezoneChip } from '@/components/timezone-chip';
import { api } from '@/lib/api';
import { PageHead, Avatar } from '@/components/page-head';
import { DateFilter, FilterSelect, SearchInput, optionsFrom } from '@/components/filter-controls';
import { DataTable, useColumnPrefs, type ColumnDef } from '@/components/data-table';
import { downloadCsv, downloadXlsx } from '@/lib/export';
import { EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';
import { usePersistedState } from '@/lib/use-persisted-state';
import { pushToast } from '@/lib/toast';
import { formatDate } from '@/lib/display-settings';
import { TIMEZONE_FILTER_OPTIONS_COMPACT } from '@/lib/timezone';
import { useOutcomeLabels } from '@/lib/use-outcome-label';

/** Ceiling for an export — the API's `limit` cap. Beyond it the user is told
 *  what was left out rather than handed a short file that looks complete. */
const EXPORT_LIMIT = 5000;

/**
 * The outcome filter is built from the CONFIGURED outcome list, not a frozen
 * copy of it.
 *
 * This was seven hard-coded options matching on the display NAME. It worked only
 * while those strings stayed byte-identical to what Admin → Outcomes holds:
 * rename "Dm-Not Interested" there and this menu goes on sending the old name,
 * which the API can no longer resolve, so the filter quietly returns nothing.
 * Sending the slug removes the coupling entirely — the API accepts either, and
 * the label follows whatever the outcome is currently called.
 */
const ALL_STATUSES = { label: 'All Call Statuses', value: '' };

export default function ClosedLeadsPage() {
  const router = useRouter();
  const { outcomes } = useOutcomeLabels();
  // Ordered by the outcome list's own sortOrder, which the API already applies —
  // so this menu reads in the order an admin arranged them.
  const callStatusOpts = useMemo(
    () => [ALL_STATUSES, ...outcomes.map((o) => ({ label: o.name, value: o.slug }))],
    [outcomes],
  );
  const [tz, setTz] = useState('');
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [callStatus, setCallStatus] = useState('');
  const [closedBy, setClosedBy] = useState('');
  // Persisted so the chosen date filter survives navigating within the module.
  const [dateFilter, setDateFilter] = usePersistedState<DateFilterValue>('closed-leads:date-filter', EMPTY_DATE_FILTER);
  const [q, setQ] = useState('');
  const [activityLead, setActivityLead] = useState<Lead | null>(null);

  // One continuous list of every closed lead, filled in as it is scrolled — the
  // same panel Lead Management uses, with the same filters applied by the API.
  //
  // The API scopes it by role: admins & team leaders get every closed lead in
  // the org, employees only the ones they personally closed. Dates here are
  // CLOSURE dates, not creation dates; for anything that took work to win the
  // two are months apart.
  const debouncedQ = useDebounced(q, 250);
  const listQuery = useMemo<LeadListQuery>(() => ({
    closed: true,
    q: debouncedQ || undefined,
    timezone: tz || undefined,
    state: state || undefined,
    city: city || undefined,
    callStatus: callStatus || undefined,
    closedBy: closedBy || undefined,
    closedFrom: dateFilter.from || undefined,
    closedTo: dateFilter.to || undefined,
    sortBy: 'closedAt',
    sortDir: 'desc',
  }), [debouncedQ, tz, state, city, callStatus, closedBy, dateFilter.from, dateFilter.to]);

  // Same contract as Lead Management: `isLoading` only when there is nothing to
  // show, `isRefreshing` while the rows on screen are being brought up to date.
  const leadsQuery = useInfiniteLeads(listQuery);
  const { rows: leads, total, isLoading, isRefreshing, isFetchingNextPage, hasNextPage } = leadsQuery;
  const sentinelRef = useLeadScrollSentinel(leadsQuery);

  // Dropdown values come from the whole closed book, not from the rows loaded
  // so far — a filter offering only what has been scrolled past is no filter.
  const { data: filterOpts } = useQuery({
    queryKey: ['leads', 'filter-options', 'closed', tz, state],
    queryFn: ({ signal }) => leadsApi.filterOptions({ closed: true, timezone: tz || undefined, state: state || undefined }, signal),
    staleTime: 5 * 60_000,
    // Holds the current menu contents while the cascaded ones reload, so the
    // State and City selects don't empty out under the pointer.
    placeholderData: keepPreviousData,
  });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data, retry: false });
  const canManage = me?.role === 'admin' || me?.role === 'team_leader';

  const EXPORT_HEADERS = [
    'Lead ID',
    'Closed Date',
    'Closed By',
    'Company Name',
    'Contact Person',
    'Phone',
    'Email',
    'Country',
    'State',
    'City',
    'Time Zone',
    'Industry',
    'Assigned To',
    'Call Status',
    'First Contact',
    'Last Contact',
    'Meeting Date',
    'Lost Reason',
    'Created Date',
  ];
  const exportRows = (rows: Lead[]) => rows.map((l: Lead) => [
    l.leadId,
    l.closedAt ? formatDate(l.closedAt) : '',
    l.closedBy?.name ?? '',
    l.businessName,
    l.contactName ?? '',
    l.phone,
    l.email ?? '',
    l.country ?? '',
    l.state,
    l.city,
    l.timezone ?? '',
    l.industry ?? '',
    l.assignedTo?.name ?? '',
    l.callStatus ?? '',
    l.firstContact ? formatDate(l.firstContact) : '',
    l.lastContact ? formatDate(l.lastContact) : '',
    l.meetingDate ? formatDate(l.meetingDate) : '',
    l.lostReason ?? '',
    l.createdAt ? formatDate(l.createdAt) : '',
  ]);

  // States cascade from the selected timezone; cities from timezone + state —
  // the same cascade the API applies when it groups them.
  const stateOpts = optionsFrom(filterOpts?.states ?? [], 'All States');
  const cityOpts = optionsFrom(filterOpts?.cities ?? [], 'All Cities');
  // Managers can narrow to a single closer; an employee's list is all their own.
  const closerOpts = optionsFrom(filterOpts?.closers ?? [], 'All Employees');

  const columns = useMemo<ColumnDef<Lead>[]>(() => [
    {
      // Pinned leftmost — same rule as every other table that carries a Lead ID.
      key: 'leadId', header: 'Lead ID', required: true, pinFirst: true, searchable: true,
      searchValue: (l) => l.leadId,
      render: (l) => (
        <div className="flex items-center gap-[10px]">
          <Avatar name={l.leadId} />
          <span className="font-mono text-[11px] text-muted-foreground">{l.leadId}</span>
        </div>
      ),
    },
    { key: 'closedAt', header: 'Closed Date', cellClassName: 'text-muted-foreground', render: (l) => l.closedAt ? formatDate(l.closedAt) : '—', trackable: true },
    { key: 'closedBy', header: 'Closed By', render: (l) => l.closedBy?.name ?? '—', searchable: true, trackable: true, searchValue: (l) => l.closedBy?.name },
    { key: 'businessName', header: 'Company Name', render: (l) => l.businessName, searchable: true, searchValue: (l) => l.businessName },
    { key: 'contactName', header: 'Contact Person', render: (l) => l.contactName ?? '—', searchable: true, searchValue: (l) => l.contactName },
    { key: 'phone', header: 'Phone', cellClassName: 'font-mono text-[11.5px] text-muted-foreground', render: (l) => l.phone, searchable: true, searchValue: (l) => l.phone },
    { key: 'email', header: 'Email', cellClassName: 'text-muted-foreground', render: (l) => l.email ?? '—', searchable: true, searchValue: (l) => l.email },
    { key: 'country', header: 'Country', cellClassName: 'text-muted-foreground', render: (l) => l.country ?? '—', searchable: true, searchValue: (l) => l.country },
    { key: 'state', header: 'State', cellClassName: 'text-muted-foreground', render: (l) => l.state, searchable: true, searchValue: (l) => l.state },
    { key: 'city', header: 'City', cellClassName: 'text-muted-foreground', render: (l) => l.city, searchable: true, searchValue: (l) => l.city },
    { key: 'tz', header: 'Time Zone', render: (l) => <TimezoneChip tz={l.timezone} /> },
    { key: 'industry', header: 'Industry', cellClassName: 'text-muted-foreground', render: (l) => l.industry ?? '—', searchable: true, searchValue: (l) => l.industry },
    { key: 'caller', header: 'Assigned To', render: (l) => l.assignedTo?.name ?? '—', searchable: true, searchValue: (l) => l.assignedTo?.name },
    { key: 'callStatus', header: 'Call Status', cellClassName: 'text-muted-foreground', render: (l) => l.callStatus ?? '—', searchable: true, searchValue: (l) => l.callStatus },
    { key: 'firstContact', header: 'First Contact', cellClassName: 'text-muted-foreground', render: (l) => l.firstContact ? formatDate(l.firstContact) : '—' },
    { key: 'lastContact', header: 'Last Contact', cellClassName: 'text-muted-foreground', render: (l) => l.lastContact ? formatDate(l.lastContact) : '—' },
    { key: 'meetingDate', header: 'Meeting Date', cellClassName: 'text-muted-foreground', render: (l) => l.meetingDate ? formatDate(l.meetingDate) : '—' },
    { key: 'lostReason', header: 'Lost Reason', cellClassName: 'text-muted-foreground', render: (l) => l.lostReason ?? '—', searchable: true, searchValue: (l) => l.lostReason },
    { key: 'createdDate', header: 'Created Date', cellClassName: 'text-muted-foreground', render: (l) => l.createdAt ? formatDate(l.createdAt) : '—' },
    {
      key: 'actions', header: '', required: true,
      render: (l) => (
        <div className="flex items-center gap-1.5">
          {/* Lead History — Admin & Team Leader only, as in Lead Management. */}
          {canManage && (
            <button
              onClick={() => setActivityLead(l)}
              title="Lead history"
              aria-label="Lead history"
              className="grid h-[30px] w-[30px] place-items-center rounded-lg border border-[var(--tone-blue-line)] bg-[var(--tone-blue-bg-2)] text-[var(--tone-blue-fg-2)] hover:bg-[#2D8CFF] hover:text-white"
            >
              <Info className="h-[15px] w-[15px]" />
            </button>
          )}
          <div className="flex gap-1.5 opacity-50 transition-opacity group-hover:opacity-100">
            <button onClick={() => router.push(`/leads/${l.id}`)} title="View" aria-label={`View ${l.businessName}`} className="grid h-[30px] w-[30px] place-items-center rounded-lg border text-[#333f25] hover:bg-primary hover:text-primary-foreground dark:text-foreground"><Eye className="h-[15px] w-[15px]" /></button>
          </div>
        </div>
      ),
    },
  ], [router, canManage]);

  const prefs = useColumnPrefs('closed-leads', columns);

  // Filtering used to happen here, over whatever slice of the closed book had
  // been downloaded. It is all in `listQuery` now, so the list being scrolled is
  // the filtered one rather than a filtered view of a partial download.

  // Re-runs the current filters unpaged, so the file holds every matching lead
  // rather than only the chunks that happen to have been scrolled into view.
  const [exporting, setExporting] = useState(false);
  const runExport = async (write: (rows: (string | number)[][]) => void) => {
    setExporting(true);
    try {
      const all = await leadsApi.page({ ...listQuery, page: 1, limit: EXPORT_LIMIT });
      write(exportRows(all.rows));
      if (all.total > all.rows.length) {
        pushToast('info', `Exported the first ${all.rows.length.toLocaleString()} of ${all.total.toLocaleString()} leads. Narrow the filters to export the rest.`);
      }
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <PageHead>
        <button
          onClick={() => runExport((rows) => downloadCsv('onboarding-leads', EXPORT_HEADERS, rows))}
          disabled={total === 0 || exporting}
          className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[12.5px] font-semibold hover:bg-muted disabled:opacity-50"
        >
          <Upload className="h-4 w-4" /> {exporting ? 'Preparing…' : 'Export CSV'}
        </button>
        <button
          onClick={() => runExport((rows) => downloadXlsx('onboarding-leads', EXPORT_HEADERS, rows))}
          disabled={total === 0 || exporting}
          className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[12.5px] font-semibold hover:bg-muted disabled:opacity-50"
        >
          <Upload className="h-4 w-4" /> Export Excel
        </button>
      </PageHead>

      {/* Filter bar — one row from `lg` up; see the note on Lead Management's. */}
      <div className="mb-[18px] flex flex-wrap items-center gap-2.5 lg:flex-nowrap">
        <SearchInput value={q} onChange={setQ} placeholder="Search business, ID, phone, email…" className="min-w-[260px] flex-[2]" />
        <FilterSelect className="min-w-0 flex-1" icon={Clock} value={tz} onChange={(v) => { setTz(v); setState(''); setCity(''); }} options={TIMEZONE_FILTER_OPTIONS_COMPACT} />
        <FilterSelect className="min-w-0 flex-1" icon={MapPin} value={state} onChange={(v) => { setState(v); setCity(''); }} options={stateOpts} />
        <FilterSelect className="min-w-0 flex-1" icon={Building2} value={city} onChange={setCity} options={cityOpts} />
        {canManage && <FilterSelect className="min-w-0 flex-1" icon={Info} value={closedBy} onChange={setClosedBy} options={closerOpts} />}
        <FilterSelect className="min-w-0 flex-1" icon={PhoneCall} value={callStatus} onChange={setCallStatus} options={callStatusOpts} />
        <DateFilter value={dateFilter} onChange={setDateFilter} iconOnly />
      </div>

      {/* Table */}
      <DataTable
        tableKey="closed-leads"
        columns={columns}
        rows={leads}
        getRowKey={(l) => l.id}
        // Matches the sidebar entry — a menu item leading to a card headed
        // something else reads as the wrong page. `tableKey` deliberately stays
        // `closed-leads`: it is the storage key for saved column preferences.
        title="Onboarding Leads"
        subtitle={
          // Same as Lead Management: don't report an empty book while the first
          // page is still loading.
          isLoading
            ? 'Loading onboarding leads…'
            : total === 0
              ? 'No onboarding leads'
              : leads.length >= total
                ? `${total.toLocaleString()} onboarding lead${total === 1 ? '' : 's'}`
                : `${leads.length.toLocaleString()} of ${total.toLocaleString()} loaded — scroll for more`
        }
        loading={isLoading}
        refreshing={isRefreshing}
        emptyText="No onboarding leads match the current filters."
        prefs={prefs}
        selectable={false}
      />

      {/* Same end-of-list marker as Lead Management: scrolling to it brings the
          next chunk, and the button covers anyone who never reaches it. */}
      <div ref={sentinelRef} className="mt-3 flex items-center justify-center gap-3 py-2">
        {hasNextPage ? (
          <button
            type="button"
            onClick={() => leadsQuery.fetchNextPage()}
            // Off while the rows belong to the outgoing query — see Lead Management.
            disabled={isFetchingNextPage || leadsQuery.isPlaceholderData}
            className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-[12px] font-semibold hover:bg-muted disabled:opacity-50"
          >
            {isFetchingNextPage ? 'Loading more…' : `Load more (${(total - leads.length).toLocaleString()} left)`}
          </button>
        ) : (
          total > 0 && <p className="text-[11.5px] text-muted-foreground">All {total.toLocaleString()} onboarding leads loaded.</p>
        )}
      </div>

      {/* Lead History drawer — Admin & Team Leader only. */}
      {canManage && activityLead && (
        <LeadActivityDrawer leadId={activityLead.id} leadName={activityLead.businessName} onClose={() => setActivityLead(null)} />
      )}
    </div>
  );
}
