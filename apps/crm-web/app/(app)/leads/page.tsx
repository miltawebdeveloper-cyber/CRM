'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload, Phone, Eye, Clock, MapPin, Building2, Globe, Target, Zap, Percent, RefreshCw, PhoneCall, Tag, UserPlus, User as UserIcon, Hourglass, Lock, CalendarClock } from 'lucide-react';
import { leadsApi, movementLabel, type Lead, type LeadListQuery } from '@/lib/leads';
import { usersApi } from '@/lib/users';
import { LeadAssignDialog } from '@/components/lead-assign-dialog';
import { LeadOutcomeCell } from '@/components/lead-outcome-cell';
import { LeadCommentCell } from '@/components/lead-comment-cell';
import { LeadInlineCell } from '@/components/lead-inline-cell';
import { metricsApi, outcomesApi } from '@/lib/crm';
import { api } from '@/lib/api';
import { QuoStatusBadge } from '@/components/quo-status-badge';
import { useCanCall } from '@/lib/use-can-call';
import { StatusPill } from '@/components/status-pill';
import { TimezoneChip } from '@/components/timezone-chip';
import { PageHead, Avatar } from '@/components/page-head';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { TIMEZONE_FILTER_OPTIONS_COMPACT, leadDate, leadDateTime, zoneNote } from '@/lib/timezone';
import { DateFilter, FilterSelect, SearchInput, optionsFrom } from '@/components/filter-controls';
import { DataTable, useColumnPrefs, type ColumnDef } from '@/components/data-table';
import { type SortState } from '@/lib/use-column-prefs';
import { downloadCsv, downloadXlsx } from '@/lib/export';
import { EXPORT_HEADERS, exportRows } from '@/lib/lead-export';
import { EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';
import { usePersistedState } from '@/lib/use-persisted-state';
import { useDebounced } from '@/lib/use-debounced';
import { useInfiniteLeads, useLeadScrollSentinel } from '@/lib/use-infinite-leads';
import { pushToast } from '@/lib/toast';

/** Ceiling for an export — the API's own `limit` cap, and five times what the
 *  module could reach before. Beyond it the user is told what was left out
 *  rather than handed a short file that looks complete. */
const EXPORT_LIMIT = 5000;

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

// No 'Closed' option — closed leads live in the Closed Leads module and are
// filtered out of this list by the API. No Assigned/Unassigned either — this
// page only ever shows assigned leads now (Lead Library shows both), so
// ownership is no longer a toggle here.
const STATUS_OPTS = [
  { label: 'Status', value: '' },
  { label: 'Contacted', value: 'contacted' },
];

export default function LeadsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [tz, setTz] = useState('');
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const [status, setStatus] = useState('');
  const [callStatus, setCallStatus] = useState('');
  // Whose leads to show. Admin-only — the API ignores this parameter for every
  // other role, so the control is hidden rather than merely disabled.
  const [employeeId, setEmployeeId] = useState('');
  // Persisted so the chosen date filter survives navigating within the module.
  const [dateFilter, setDateFilter] = usePersistedState<DateFilterValue>('leads:date-filter', EMPTY_DATE_FILTER);
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
  const [dateField, setDateField] = usePersistedState<'created' | 'scheduled'>('leads:date-field', 'created');
  const [q, setQ] = useState('');
  // Lead lists open in IMPORT order — row 1 of the uploaded file first — until
  // the user sorts by something else. Declared here because the list query below
  // is built from it: ordering is the server's job, not a pass over rows already
  // downloaded. Was `leadId`, which the API had to reinterpret because sorting
  // the id as a string puts L-2026-10 ahead of L-2026-2.
  const [sort, setSort] = useState<SortState>({ key: 'importSeq', dir: 'asc' });

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
    status: status === 'contacted' ? 'contacted' : undefined,
    callStatus: callStatus || undefined,
    employeeId: employeeId || undefined,
    createdFrom: dateFilter.from || undefined,
    createdTo: dateFilter.to || undefined,
    dateField,
    sortBy: sort.key,
    sortDir: sort.dir,
  }), [debouncedQ, tz, state, city, country, status, callStatus, employeeId, dateFilter.from, dateFilter.to, dateField, sort.key, sort.dir]);

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
    queryKey: ['leads', 'filter-options', tz, state],
    queryFn: ({ signal }) => leadsApi.filterOptions({ closed: false, timezone: tz || undefined, state: state || undefined }, signal),
    staleTime: 5 * 60_000,
    // Keys on the zone and the state, so picking either one changes the key and
    // would otherwise leave `filterOpts` undefined for the length of a request —
    // during which the State and City menus collapse to just their "All" entry
    // and the chosen value disappears out of the control the user is holding.
    placeholderData: keepPreviousData,
  });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data, retry: false });
  const canManage = me?.role === 'admin' || me?.role === 'team_leader';
  const isAdmin = me?.role === 'admin';

  // Who the Employee filter offers. Fetched only for an admin: `usersApi.list`
  // is itself role-gated, so asking as anyone else is a guaranteed 403 in the
  // console for a control they cannot see anyway.
  const { data: staff = [] } = useQuery({ queryKey: ['users'], queryFn: usersApi.list, enabled: !!isAdmin, retry: false });
  const employeeOpts = useMemo(
    () => [
      { label: 'Employees', value: '' },
      // Admins hold no lead book of their own, so listing them would offer
      // filters that can only ever come back empty.
      ...staff.filter((u) => u.role !== 'admin').map((u) => ({ label: u.name, value: u.id })),
    ],
    [staff],
  );
  // The configured outcome list (Admin → Outcomes) drives both the Call Outcome
  // filter and the inline editor, so renaming or adding an outcome shows up in
  // both with no code change — and the filter can't offer a value the CRM no
  // longer recognises, which the old hard-coded list did.
  const { data: outcomeDefs = [] } = useQuery({ queryKey: ['outcomes-config'], queryFn: outcomesApi.list });
  const callOutcomeOpts = useMemo(
    () => [{ label: 'Call Outcomes', value: '' }, ...outcomeDefs.map((o) => ({ label: o.name, value: o.slug }))],
    [outcomeDefs],
  );
  // Refuse to dial before the API would reject the call (no assigned caller ID),
  // since the Quo app handoff fires first and can't be taken back.
  const { dial, callingEnabled } = useCanCall();
  // Employees (any non-manager role) get a self-scoped view: they see only their
  // own leads, and their KPI cards are derived from that book.
  const isEmployee = !!me && !canManage;
  const [assignLeads, setAssignLeads] = useState<Lead[] | null>(null);  // Reassign popup (managers only)
  const clearTableSelection = useRef<(() => void) | null>(null);        // set from DataTable's bulkActions clear fn

  // Bulk-push every not-yet-synced lead to Quo/OpenPhone as a contact.
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const syncAll = useMutation({
    mutationFn: leadsApi.syncAllToQuo,
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
  const tzOpts = useMemo(
    () => TIMEZONE_FILTER_OPTIONS_COMPACT.map((o) => (o.value === '' ? { ...o, label: 'Time Zones' } : o)),
    [],
  );

  // KPI cards respect the same date filter as the table, ON THE SAME DATE —
  // `dateField` goes with the range, so switching the grid to scheduled dates
  // moves the cards with it rather than leaving them counting leads by when they
  // were created while the table below lists leads by when they are queued.
  const { data: s } = useQuery({
    queryKey: ['metrics', 'summary', dateFilter.from, dateFilter.to, dateField],
    queryFn: ({ signal }) => metricsApi.summary({ from: dateFilter.from || undefined, to: dateFilter.to || undefined, dateField }, signal),
    retry: false,
    // Same reason as the filter options: the date range is part of the key, so
    // moving it would drop every card to "0" until the new counts land. Holding
    // the previous figures for a moment is a smaller lie than reporting zero
    // leads to someone who has just changed a date.
    placeholderData: keepPreviousData,
  });

  const columns = useMemo<ColumnDef<Lead>[]>(() => [
    // The order the leads arrived in, and the grid's default sort. Hidden by
    // default — it is the order the rows are already in, so it earns its space
    // only when someone wants to see or re-apply the position explicitly.
    {
      key: 'importSeq', header: 'Import Order', defaultHidden: true, sortable: true,
      cellClassName: 'tabular-nums text-muted-foreground',
      sortValue: (l) => l.importSeq,
      render: (l) => l.importSeq,
    },
    {
      // Pinned leftmost: the Lead ID identifies the row, so it stays the first
      // thing on it whatever else a user rearranges. `importSeq` above is hidden
      // by default and sorts behind this when shown.
      key: 'leadId', header: 'Lead ID', required: true, pinFirst: true, searchable: true, sortable: true,
      searchValue: (l) => l.leadId,
      render: (l) => (
        <div className="flex items-center gap-[10px]">
          <Avatar name={l.leadId} />
          <span className="font-mono text-[11px] text-muted-foreground">{l.leadId}</span>
        </div>
      ),
    },
    { key: 'leadGenerationId', header: 'Lead Generation ID', cellClassName: 'text-muted-foreground', render: (l) => l.leadGenerationId ?? '—', searchable: true, sortable: true, searchValue: (l) => l.leadGenerationId },
    /**
     * The original creation stamp, to the minute.
     *
     * This is where the module's plain "Created Date" column used to be, and it
     * has taken that column's place: the date-only version was WITHDRAWN
     * TEMPORARILY rather than kept alongside, because the two showed the same
     * instant and the grid is wide enough already. Restoring it is one line —
     * `{ key: 'createdDate', header: 'Created Date', … formatDate(l.createdAt) }`
     * back in front of this one. The export still writes both.
     *
     * The date alone was never enough for the question this answers. A lead
     * reassigned in the afternoon, or carried into the next day, is
     * indistinguishable on the date from one created that morning. The time is
     * the evidence that the record is the ORIGINAL — and it survives every
     * reassignment and every next-day move, because nothing in the CRM writes
     * `createdAt` after the lead is created.
     *
     * `key` is `createdAt` deliberately: the grid sends the column key as the
     * server's sort field, and that is the column the server orders by.
     */
    {
      key: 'createdAt', header: 'Created Date & Time', width: 170, sortable: true,
      cellClassName: 'text-muted-foreground whitespace-nowrap',
      searchable: true,
      searchValue: (l) => leadDateTime(l.createdAt, l.timezone, ''),
      render: (l) => <span title={zoneNote(l.timezone)}>{leadDateTime(l.createdAt, l.timezone)}</span>,
    },
    /**
     * The other half of the pair: the day this lead is currently scheduled to be
     * worked, taken from its active assignment.
     *
     * Distinct from Created Date & Time in exactly the way the two dates are
     * distinct. A lead created on the 1st, never finished, and carried forward
     * every night reads "Jan 1, 09:14" beside today's date — one row saying both
     * how old the lead is and that it is on today's queue. Before this pair
     * existed the grid could only show the first, so a carried lead looked like
     * a stale one nobody had scheduled.
     */
    {
      key: 'scheduledDate', header: 'Scheduled Date', width: 150,
      cellClassName: 'text-muted-foreground whitespace-nowrap',
      trackable: true,
      render: (l) => <span title={zoneNote(l.timezone)}>{leadDate(l.assignedAt, l.timezone)}</span>,
    },
    /**
     * How the lead came to be on that date — assigned, handed over, or moved
     * forward, with the number of times it has been moved.
     *
     * Hidden by default: it is a diagnosis column, wanted when a manager is
     * asking why a lead is still open rather than on every screen.
     */
    {
      key: 'movement', header: 'Movement', width: 190, defaultHidden: true,
      cellClassName: 'text-muted-foreground',
      searchable: true,
      searchValue: (l) => movementLabel(l),
      render: (l) => movementLabel(l) || '—',
    },
    { key: 'leadSource', header: 'Lead Source', cellClassName: 'text-muted-foreground', render: (l) => l.leadSource ?? '—', searchable: true, sortable: true, searchValue: (l) => l.leadSource },
    { key: 'businessName', header: 'Company Name', render: (l) => l.businessName, searchable: true, sortable: true, searchValue: (l) => l.businessName },
    { key: 'contactName', header: 'Contact Person', render: (l) => l.contactName ?? '—', searchable: true, sortable: true, searchValue: (l) => l.contactName },
    { key: 'contactName2', header: 'Designation', render: (l) => l.contactName2 ?? '—', searchable: true, sortable: true, searchValue: (l) => l.contactName2 },
    { key: 'phone', header: 'Phone', cellClassName: 'font-mono text-[11.5px] text-muted-foreground', render: (l) => l.phone, searchable: true, sortable: true, searchValue: (l) => l.phone },
    { key: 'altPhone', header: 'Alt Phone', cellClassName: 'font-mono text-[11.5px] text-muted-foreground', render: (l) => l.altPhone ?? '—', searchable: true, sortable: true, searchValue: (l) => l.altPhone },
    { key: 'email', header: 'Email', cellClassName: 'text-muted-foreground', render: (l) => l.email ?? '—', searchable: true, sortable: true, searchValue: (l) => l.email },
    { key: 'website', header: 'Website', cellClassName: 'text-muted-foreground', render: (l) => l.website ?? '—', searchable: true, sortable: true, searchValue: (l) => l.website },
    { key: 'socialMedia', header: 'Social Media', cellClassName: 'text-muted-foreground', render: (l) => l.socialMedia ?? '—', searchable: true, sortable: true, searchValue: (l) => l.socialMedia },
    { key: 'country', header: 'Country', cellClassName: 'text-muted-foreground', render: (l) => l.country ?? '—', searchable: true, sortable: true, searchValue: (l) => l.country },
    { key: 'state', header: 'State', cellClassName: 'text-muted-foreground', render: (l) => l.state, searchable: true, sortable: true, searchValue: (l) => l.state },
    { key: 'city', header: 'City', cellClassName: 'text-muted-foreground', render: (l) => l.city, searchable: true, sortable: true, searchValue: (l) => l.city },
    // A lead with no zone is called out rather than shown as an empty chip: it
    // is the one state that blocks scheduling a callback, so the list is where
    // someone notices and fixes it.
    { key: 'tz', header: 'Time Zone', render: (l) => <TimezoneChip tz={l.timezone} /> },
    { key: 'industry', header: 'Industry', cellClassName: 'text-muted-foreground', render: (l) => l.industry ?? '—', searchable: true, sortable: true, searchValue: (l) => l.industry },
    { key: 'companySize', header: 'Company Size', cellClassName: 'text-muted-foreground', render: (l) => l.companySize ?? '—', searchable: true, sortable: true, searchValue: (l) => l.companySize },
    { key: 'foundedYear', header: 'Founded Year', cellClassName: 'text-muted-foreground', render: (l) => l.foundedYear ?? '—', searchable: true, sortable: true, searchValue: (l) => l.foundedYear },
    { key: 'address', header: 'Address', cellClassName: 'text-muted-foreground max-w-[200px] truncate', render: (l) => l.address ?? '—', searchable: true, sortable: true, searchValue: (l) => l.address },
    // An owned lead is called out with a badge, not just a name: a lead has exactly
    // one owner, and these rows are locked out of bulk assignment, so it has to be
    // obvious at a glance why their checkbox is greyed out.
    {
      key: 'caller',
      header: 'Assigned To',
      render: (l) =>
        l.assignedTo ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--brand-surface)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--brand-on-surface)]">
            <Lock className="h-3 w-3" /> {l.assignedTo.name}
          </span>
        ) : (
          <span className="text-muted-foreground">Unassigned</span>
        ),
      searchable: true,
      trackable: true,
      searchValue: (l) => l.assignedTo?.name,
    },
    {
      key: 'callStatus',
      header: 'Call Outcome',
      // Editable in place: one click opens the configured outcome list and the
      // pick saves straight away, so a mis-dispositioned lead is corrected from
      // the row instead of a round trip through the Edit Lead page.
      render: (l) => <LeadOutcomeCell lead={l} />,
      searchable: true,
      sortable: true,
      searchValue: (l) => l.callStatus,
    },
    // Every date on this row belongs to the lead, so every one of them is read
    // on the lead's clock — including the follow-up, which is an hour agreed
    // with the customer and is the one it would be most damaging to state on
    // anybody else's.
    /**
     * The three contact stamps, to the minute.
     *
     * They carry a time now because the calling flow writes one: a disposition
     * records the instant it happened, and a booked callback is an hour agreed
     * with the customer. Shown to the day these read as three identical dates on
     * a lead called three times in an afternoon, and Next Follow-up — the one
     * somebody acts on — loses the only part of it that says when to ring.
     *
     * A lead whose values came from the import shows midnight, which is what its
     * sheet actually said.
     */
    { key: 'firstContact', header: 'First Contact', width: 170, cellClassName: 'text-muted-foreground whitespace-nowrap', render: (l) => <span title={zoneNote(l.timezone)}>{leadDateTime(l.firstContact, l.timezone)}</span> },
    { key: 'lastContact', header: 'Last Contact', width: 170, cellClassName: 'text-muted-foreground whitespace-nowrap', render: (l) => <span title={zoneNote(l.timezone)}>{leadDateTime(l.lastContact, l.timezone)}</span> },
    { key: 'followup', header: 'Next Follow-up', width: 170, cellClassName: 'text-muted-foreground whitespace-nowrap', render: (l) => <span title={zoneNote(l.timezone)}>{leadDateTime(l.nextFollowUpDate, l.timezone)}</span>, trackable: true },
    // Counts the follow-ups actually MADE — a call that answered one an earlier
    // call booked. Written by the calling flow, so it climbs on its own; see the
    // contact-tracking block in the API's `applyDisposition`.
    { key: 'followupCount', header: 'Follow-up Count', cellClassName: 'text-muted-foreground tabular-nums', render: (l) => l.followupCount ?? '—' },
    // Requested tail order: Meeting Date → Comments → Lost Reason → Actions. Comments
    // and Lost Reason both edit in place; Comments also syncs with call notes.
    /**
     * The lead's next Zoom meeting, to the minute.
     *
     * Written by the Zoom module rather than only by the import: booking a
     * meeting sets it, rescheduling moves it, cancelling or completing it moves
     * to the next pending meeting or clears it. A meeting booked through the CRM
     * used to leave this cell empty, so the grid said a lead had no meeting
     * while the calendar had one.
     *
     * Independent of Next Follow-up above, and never written from it. The two
     * answer different questions — when are we meeting them, and when are we
     * ringing them back — and a lead can easily have one and not the other.
     */
    { key: 'meetingDate', header: 'Meeting Date & Time', width: 170, cellClassName: 'text-muted-foreground whitespace-nowrap', render: (l) => <span title={zoneNote(l.timezone)}>{leadDateTime(l.meetingDate, l.timezone)}</span> },
    {
      key: 'comments',
      header: 'Comments',
      width: 240,
      render: (l) => <LeadCommentCell lead={l} />,
      searchable: true,
      trackable: true,
      sortable: true,
      searchValue: (l) => l.comments,
    },
    {
      key: 'lostReason',
      header: 'Lost Reason',
      width: 200,
      render: (l) => <LeadInlineCell lead={l} field="lostReason" placeholder="Add a reason…" />,
      searchable: true,
      trackable: true,
      sortable: true,
      searchValue: (l) => l.lostReason,
    },
    {
      key: 'actions', header: '', required: true,
      render: (l) => (
        <div className="flex items-center gap-1.5 opacity-50 transition-opacity group-hover:opacity-100">
          {/* Hidden while calling is disabled — a Call button that can't call is
              worse than no button. The row's View action still opens the lead. */}
          {callingEnabled && (
            <button onClick={() => { if (!dial(l.phone)) return; router.push(`/calling?leadId=${l.id}&autocall=1`); }} title="Call" aria-label={`Call ${l.businessName}`} className="grid h-[30px] w-[30px] place-items-center rounded-lg border text-[var(--brand-deep)] hover:bg-primary hover:text-primary-foreground dark:text-foreground"><Phone className="h-[15px] w-[15px]" /></button>
          )}
          <button onClick={() => router.push(`/leads/${l.id}`)} title="View" aria-label={`View ${l.businessName}`} className="grid h-[30px] w-[30px] place-items-center rounded-lg border text-[var(--brand-deep)] hover:bg-primary hover:text-primary-foreground dark:text-foreground"><Eye className="h-[15px] w-[15px]" /></button>
        </div>
      ),
    },
  ], [router, dial, callingEnabled]);

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

  // Re-runs the current query unpaged so the file holds every matching lead.
  // Capped at the API's ceiling; if the filter selects more than that, say so
  // rather than handing over a truncated file that looks complete.
  const [exporting, setExporting] = useState(false);
  const runExport = async (write: (rows: (string | number)[][]) => void) => {
    setExporting(true);
    try {
      // `limit` rather than `pageSize`: pageSize is capped at 500 so a page
      // request can't turn into a bulk read, while `limit` is the deliberate
      // bulk path and allows the full 5,000.
      const all = await leadsApi.page({ ...listQuery, page: 1, pageSize: undefined, limit: EXPORT_LIMIT });
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
          onClick={() => runExport((rows) => downloadCsv('leads', EXPORT_HEADERS, rows))}
          disabled={total === 0 || exporting}
          className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[12.5px] font-semibold hover:bg-muted disabled:opacity-50"
        >
          <Upload className="h-4 w-4" /> {exporting ? 'Preparing…' : 'Export CSV'}
        </button>
        <button
          onClick={() => runExport((rows) => downloadXlsx('leads', EXPORT_HEADERS, rows))}
          disabled={total === 0 || exporting}
          className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[12.5px] font-semibold hover:bg-muted disabled:opacity-50"
        >
          <Upload className="h-4 w-4" /> Export Excel
        </button>
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
        <KpiCard icon={Target} iconBg="var(--tone-blue-bg)" iconColor="var(--tone-blue-fg)" value={(s?.totalLeads ?? 0).toLocaleString()} label="Total Leads" />
        <KpiCard icon={Zap} iconBg="var(--brand-surface)" iconColor="var(--brand-on-surface)" value={(s?.assignedLeads ?? 0).toLocaleString()} label="Assigned Leads" />
        <KpiCard icon={PhoneCall} iconBg="var(--tone-teal-bg)" iconColor="var(--tone-teal-fg)" value={(s?.contactedLeads ?? 0).toLocaleString()} label="Contacted" />
        <KpiCard icon={Hourglass} iconBg="var(--tone-amber-bg)" iconColor="var(--tone-amber-fg)" value={(s?.balanceLeads ?? 0).toLocaleString()} label="Balance Leads" />
        <KpiCard icon={Percent} iconBg="var(--brand-surface-2)" iconColor="var(--brand-on-surface)" value={`${s?.progressPct ?? 0}%`} label="Progress" />
      </div>

      {/* Filter bar — one row on a laptop and up.
          Each control takes `min-w-0 flex-1` so the row divides its width between
          them rather than letting any one take its intrinsic size. A native
          `<select>` is otherwise as wide as its longest option — the longest
          employee name, the longest city — which is what overflowed the row and
          wrapped the date filter onto a line of its own. Below `lg` it still
          wraps, which is what a tablet and a phone want. */}
      <div className="mb-[18px] flex flex-wrap items-center gap-2.5 lg:flex-nowrap">
        <SearchInput value={q} onChange={setQ} placeholder="Search business, ID, phone, email…" className="min-w-[260px] flex-[2]" />
        <FilterSelect className="min-w-0 flex-1" icon={Clock} value={tz} onChange={(v) => { setTz(v); setState(''); setCity(''); }} options={tzOpts} />
        <FilterSelect className="min-w-0 flex-1" icon={MapPin} value={state} onChange={(v) => { setState(v); setCity(''); }} options={stateOpts} />
        <FilterSelect className="min-w-0 flex-1" icon={Building2} value={city} onChange={setCity} options={cityOpts} />
        {/* Admin only. Hidden rather than disabled for other roles: a team
            leader has no use for a control the API will ignore, and an
            employee is already pinned to their own book. */}
        {isAdmin && <FilterSelect className="min-w-0 flex-1" icon={UserIcon} value={employeeId} onChange={setEmployeeId} options={employeeOpts} />}
        <FilterSelect className="min-w-0 flex-1" icon={Globe} value={country} onChange={setCountry} options={countryOpts} />
        <FilterSelect className="min-w-0 flex-1" icon={Tag} value={status} onChange={setStatus} options={STATUS_OPTS} />
        <FilterSelect className="min-w-0 flex-1" icon={PhoneCall} value={callStatus} onChange={setCallStatus} options={callOutcomeOpts} />
        {/* Sits immediately before the calendar because it says what the calendar
            means. Picking a day is ambiguous on its own — created that day, or
            queued for that day — and these are different sets of leads the
            moment anything is carried forward. */}
        <FilterSelect className="min-w-0 flex-1" icon={CalendarClock} value={dateField} onChange={(v) => setDateField(v as 'created' | 'scheduled')} options={DATE_FIELD_OPTS} />
        <DateFilter value={dateFilter} onChange={setDateFilter} iconOnly />
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
          <button
            onClick={() => { clearTableSelection.current = clear; setAssignLeads(rows); }}
            title="Reassign selected leads to another employee"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[12px] font-semibold text-foreground hover:bg-muted"
          >
            <UserPlus className="h-4 w-4" /> Reassign
          </button>
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
