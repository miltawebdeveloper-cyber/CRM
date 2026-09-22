'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Import as ImportIcon, Upload, Plus, Phone, Eye, Clock, MapPin, Building2, Globe, Info, PhoneCall, Tag, UserPlus, User as UserIcon, X, Hourglass, Lock, AlertTriangle, CalendarClock, Percent, Target, Zap } from 'lucide-react';
import { leadsApi, movementLabel, type CreateLeadInput, type DuplicateMatch, type Lead, type LeadListQuery } from '@/lib/leads';
import { usersApi } from '@/lib/users';
import { LeadActivityDrawer } from '@/components/lead-activity-log';
import { LeadAssignDialog } from '@/components/lead-assign-dialog';
import { LeadOutcomeCell } from '@/components/lead-outcome-cell';
import { LeadCommentCell } from '@/components/lead-comment-cell';
import { LeadInlineCell } from '@/components/lead-inline-cell';
import { metricsApi, outcomesApi } from '@/lib/crm';
import { api } from '@/lib/api';
import { useCanCall } from '@/lib/use-can-call';
import { TimezoneChip } from '@/components/timezone-chip';
import { PageHead, Avatar } from '@/components/page-head';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { LEAD_TIMEZONES, TIMEZONE_FILTER_OPTIONS_COMPACT, leadDate, leadDateTime, zoneNote } from '@/lib/timezone';
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
 * already follows for "a second page shaped like the leads grid".
 */

const EXPORT_LIMIT = 5000;

const EMPTY: CreateLeadInput = {
  businessName: '',
  phone: '',
  email: '',
  state: '',
  city: '',
  timezone: 'EST',
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
// assigned leads.
const STATUS_OPTS = [
  { label: 'Status', value: '' },
  { label: 'Assigned', value: 'assigned' },
  { label: 'Unassigned', value: 'unassigned' },
  { label: 'Contacted', value: 'contacted' },
];

export default function LeadLibraryPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [form, setForm] = useState<CreateLeadInput>(EMPTY);
  const [showForm, setShowForm] = useState(false);
  const [tz, setTz] = useState('');
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [country, setCountry] = useState('');
  const [status, setStatus] = useState('');
  const [callStatus, setCallStatus] = useState('');
  const [dateFilter, setDateFilter] = usePersistedState<DateFilterValue>('lead-library:date-filter', EMPTY_DATE_FILTER);
  const [dateField, setDateField] = usePersistedState<'created' | 'scheduled'>('lead-library:date-field', 'created');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'importSeq', dir: 'asc' });

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
    assigned: status === 'assigned' ? 'assigned' : status === 'unassigned' ? 'unassigned' : undefined,
    status: status === 'contacted' ? 'contacted' : undefined,
    callStatus: callStatus || undefined,
    employeeId: employeeId || undefined,
    createdFrom: dateFilter.from || undefined,
    createdTo: dateFilter.to || undefined,
    dateField,
    sortBy: sort.key,
    sortDir: sort.dir,
  }), [debouncedQ, tz, state, city, country, status, callStatus, employeeId, dateFilter.from, dateFilter.to, dateField, sort.key, sort.dir]);

  const leadsQuery = useInfiniteLeads(listQuery);
  const { rows: leads, total, isLoading, isRefreshing, isFetchingNextPage, hasNextPage } = leadsQuery;
  const sentinelRef = useLeadScrollSentinel(leadsQuery);

  const { data: filterOpts } = useQuery({
    queryKey: ['leads', 'filter-options', tz, state],
    queryFn: ({ signal }) => leadsApi.filterOptions({ closed: false, timezone: tz || undefined, state: state || undefined }, signal),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data, retry: false });
  const canManage = me?.role === 'admin' || me?.role === 'team_leader';
  const isAdmin = me?.role === 'admin';

  const { data: staff = [] } = useQuery({ queryKey: ['users'], queryFn: usersApi.list, enabled: !!isAdmin, retry: false });
  const employeeOpts = useMemo(
    () => [{ label: 'Employees', value: '' }, ...staff.filter((u) => u.role !== 'admin').map((u) => ({ label: u.name, value: u.id }))],
    [staff],
  );
  const { data: outcomeDefs = [] } = useQuery({ queryKey: ['outcomes-config'], queryFn: outcomesApi.list });
  const callOutcomeOpts = useMemo(
    () => [{ label: 'Call Outcomes', value: '' }, ...outcomeDefs.map((o) => ({ label: o.name, value: o.slug }))],
    [outcomeDefs],
  );
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
  const tzOpts = useMemo(
    () => TIMEZONE_FILTER_OPTIONS_COMPACT.map((o) => (o.value === '' ? { ...o, label: 'Time Zones' } : o)),
    [],
  );

  const { data: s } = useQuery({
    queryKey: ['metrics', 'summary', dateFilter.from, dateFilter.to, dateField],
    queryFn: ({ signal }) => metricsApi.summary({ from: dateFilter.from || undefined, to: dateFilter.to || undefined, dateField }, signal),
    retry: false,
    placeholderData: keepPreviousData,
  });

  const removeLeads = useMutation({
    mutationFn: (rows: Lead[]) => leadsApi.bulkDelete(rows.map((l) => l.id)),
    meta: { successMessage: 'Selected lead(s) deleted' },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['metrics', 'summary'] });
      qc.invalidateQueries({ queryKey: ['assignments-summary'] });
      qc.invalidateQueries({ queryKey: ['caller-leads'] });
      qc.invalidateQueries({ queryKey: ['caller-dash'] });
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

  const columns = useMemo<ColumnDef<Lead>[]>(() => [
    {
      key: 'importSeq', header: 'Import Order', defaultHidden: true, sortable: true,
      cellClassName: 'tabular-nums text-muted-foreground',
      sortValue: (l) => l.importSeq,
      render: (l) => l.importSeq,
    },
    {
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
    {
      key: 'createdAt', header: 'Created Date & Time', width: 170, sortable: true,
      cellClassName: 'text-muted-foreground whitespace-nowrap',
      searchable: true,
      searchValue: (l) => leadDateTime(l.createdAt, l.timezone, ''),
      render: (l) => <span title={zoneNote(l.timezone)}>{leadDateTime(l.createdAt, l.timezone)}</span>,
    },
    {
      key: 'scheduledDate', header: 'Scheduled Date', width: 150,
      cellClassName: 'text-muted-foreground whitespace-nowrap',
      trackable: true,
      render: (l) => <span title={zoneNote(l.timezone)}>{leadDate(l.assignedAt, l.timezone)}</span>,
    },
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
    { key: 'tz', header: 'Time Zone', render: (l) => <TimezoneChip tz={l.timezone} /> },
    { key: 'industry', header: 'Industry', cellClassName: 'text-muted-foreground', render: (l) => l.industry ?? '—', searchable: true, sortable: true, searchValue: (l) => l.industry },
    { key: 'companySize', header: 'Company Size', cellClassName: 'text-muted-foreground', render: (l) => l.companySize ?? '—', searchable: true, sortable: true, searchValue: (l) => l.companySize },
    { key: 'foundedYear', header: 'Founded Year', cellClassName: 'text-muted-foreground', render: (l) => l.foundedYear ?? '—', searchable: true, sortable: true, searchValue: (l) => l.foundedYear },
    { key: 'address', header: 'Address', cellClassName: 'text-muted-foreground max-w-[200px] truncate', render: (l) => l.address ?? '—', searchable: true, sortable: true, searchValue: (l) => l.address },
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
      render: (l) => <LeadOutcomeCell lead={l} />,
      searchable: true,
      sortable: true,
      searchValue: (l) => l.callStatus,
    },
    { key: 'firstContact', header: 'First Contact', width: 170, cellClassName: 'text-muted-foreground whitespace-nowrap', render: (l) => <span title={zoneNote(l.timezone)}>{leadDateTime(l.firstContact, l.timezone)}</span> },
    { key: 'lastContact', header: 'Last Contact', width: 170, cellClassName: 'text-muted-foreground whitespace-nowrap', render: (l) => <span title={zoneNote(l.timezone)}>{leadDateTime(l.lastContact, l.timezone)}</span> },
    { key: 'followup', header: 'Next Follow-up', width: 170, cellClassName: 'text-muted-foreground whitespace-nowrap', render: (l) => <span title={zoneNote(l.timezone)}>{leadDateTime(l.nextFollowUpDate, l.timezone)}</span>, trackable: true },
    { key: 'followupCount', header: 'Follow-up Count', cellClassName: 'text-muted-foreground tabular-nums', render: (l) => l.followupCount ?? '—' },
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
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setActivityLead(l)}
            title="Lead history"
            aria-label="Lead history"
            className="grid h-[30px] w-[30px] place-items-center rounded-lg border border-[var(--tone-blue-line)] bg-[var(--tone-blue-bg-2)] text-[var(--tone-blue-fg-2)] hover:bg-[#2D8CFF] hover:text-white"
          >
            <Info className="h-[15px] w-[15px]" />
          </button>
          <div className="flex gap-1.5 opacity-50 transition-opacity group-hover:opacity-100">
            {callingEnabled && (
              <button onClick={() => { if (!dial(l.phone)) return; router.push(`/calling?leadId=${l.id}&autocall=1`); }} title="Call" aria-label={`Call ${l.businessName}`} className="grid h-[30px] w-[30px] place-items-center rounded-lg border text-[var(--brand-deep)] hover:bg-primary hover:text-primary-foreground dark:text-foreground"><Phone className="h-[15px] w-[15px]" /></button>
            )}
            <button onClick={() => router.push(`/leads/${l.id}`)} title="View" aria-label={`View ${l.businessName}`} className="grid h-[30px] w-[30px] place-items-center rounded-lg border text-[var(--brand-deep)] hover:bg-primary hover:text-primary-foreground dark:text-foreground"><Eye className="h-[15px] w-[15px]" /></button>
          </div>
        </div>
      ),
    },
  ], [router, dial, callingEnabled]);

  const prefs = useColumnPrefs('lead-library', columns, 1);

  const [exporting, setExporting] = useState(false);
  const runExport = async (write: (rows: (string | number)[][]) => void) => {
    setExporting(true);
    try {
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
        <button onClick={() => router.push('/import')} className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[12.5px] font-semibold hover:bg-muted">
          <ImportIcon className="h-4 w-4" /> Import CSV
        </button>
        <button
          onClick={() => runExport((rows) => downloadCsv('lead-library', EXPORT_HEADERS, rows))}
          disabled={total === 0 || exporting}
          className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[12.5px] font-semibold hover:bg-muted disabled:opacity-50"
        >
          <Upload className="h-4 w-4" /> {exporting ? 'Preparing…' : 'Export CSV'}
        </button>
        <button
          onClick={() => runExport((rows) => downloadXlsx('lead-library', EXPORT_HEADERS, rows))}
          disabled={total === 0 || exporting}
          className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[12.5px] font-semibold hover:bg-muted disabled:opacity-50"
        >
          <Upload className="h-4 w-4" /> Export Excel
        </button>
        {/* Route/nav are already manager-only; the check here is defense in
            depth, matching every other action on this page. */}
        {canManage && (
          <button onClick={() => (showForm ? closeForm() : setShowForm(true))} className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[12.5px] font-semibold text-primary-foreground shadow-sm hover:opacity-90">
            {showForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />} {showForm ? 'Close' : 'Add Lead'}
          </button>
        )}
      </PageHead>

      <div className="mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        <KpiCard icon={Target} iconBg="var(--tone-blue-bg)" iconColor="var(--tone-blue-fg)" value={(s?.totalLeads ?? 0).toLocaleString()} label="Total Leads" />
        <KpiCard icon={Zap} iconBg="var(--brand-surface)" iconColor="var(--brand-on-surface)" value={(s?.assignedLeads ?? 0).toLocaleString()} label="Assigned Leads" />
        <KpiCard icon={PhoneCall} iconBg="var(--tone-teal-bg)" iconColor="var(--tone-teal-fg)" value={(s?.contactedLeads ?? 0).toLocaleString()} label="Contacted" />
        <KpiCard icon={Hourglass} iconBg="var(--tone-amber-bg)" iconColor="var(--tone-amber-fg)" value={(s?.balanceLeads ?? 0).toLocaleString()} label="Balance Leads" />
        <KpiCard icon={Percent} iconBg="var(--brand-surface-2)" iconColor="var(--brand-on-surface)" value={`${s?.progressPct ?? 0}%`} label="Progress" />
      </div>

      {/* Filter order: Time Zone, Country, State, City, Employee — Country
          sits right after Time Zone, ahead of the State/City cascade. */}
      <div className="mb-[18px] flex flex-wrap items-center gap-2.5 lg:flex-nowrap">
        <SearchInput value={q} onChange={setQ} placeholder="Search business, ID, phone, email…" className="min-w-[260px] flex-[2]" />
        <FilterSelect className="min-w-0 flex-1" icon={Clock} value={tz} onChange={(v) => { setTz(v); setState(''); setCity(''); }} options={tzOpts} />
        <FilterSelect className="min-w-0 flex-1" icon={Globe} value={country} onChange={setCountry} options={countryOpts} />
        <FilterSelect className="min-w-0 flex-1" icon={MapPin} value={state} onChange={(v) => { setState(v); setCity(''); }} options={stateOpts} />
        <FilterSelect className="min-w-0 flex-1" icon={Building2} value={city} onChange={setCity} options={cityOpts} />
        {isAdmin && <FilterSelect className="min-w-0 flex-1" icon={UserIcon} value={employeeId} onChange={setEmployeeId} options={employeeOpts} />}
        <FilterSelect className="min-w-0 flex-1" icon={Tag} value={status} onChange={setStatus} options={STATUS_OPTS} />
        <FilterSelect className="min-w-0 flex-1" icon={PhoneCall} value={callStatus} onChange={setCallStatus} options={callOutcomeOpts} />
        <FilterSelect className="min-w-0 flex-1" icon={CalendarClock} value={dateField} onChange={(v) => setDateField(v as 'created' | 'scheduled')} options={DATE_FIELD_OPTS} />
        <DateFilter value={dateFilter} onChange={setDateFilter} iconOnly />
      </div>

      {/* Create form */}
      {showForm && (
        <form
          onSubmit={(e) => { e.preventDefault(); setDupBlock(null); create.mutate({}); }}
          className="mb-[18px] grid grid-cols-1 gap-3 rounded-2xl border bg-card p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-3"
        >
          <div className="col-span-full flex items-center justify-between">
            <h3 className="text-sm font-semibold">Add Lead</h3>
            <button
              type="button"
              onClick={closeForm}
              title="Close"
              aria-label="Close add lead form"
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {([
            ['leadId', 'Lead ID'],
            ['leadGenerationId', 'Lead Generation ID'],
            ['leadSource', 'Lead Source'],
            ['businessName', 'Company Name *'],
            ['contactName', 'Contact Person (Primary)'],
            ['contactName2', 'Designation'],
            ['phone', 'Phone *'],
            ['altPhone', 'Alt Phone'],
            ['email', 'Email'],
            ['website', 'Website'],
            ['socialMedia', 'Social Media'],
            ['country', 'Country'],
            ['state', 'State *'],
            ['city', 'City *'],
            ['industry', 'Industry'],
            ['companySize', 'Company Size'],
            ['foundedYear', 'Founded Year'],
            ['address', 'Address'],
            ['caller', 'Assigned To (name/email)'],
            ['callStatus', 'Call Status'],
            ['lostReason', 'Lost Reason'],
          ] as const).map(([key, label]) => (
            <label key={key} className="space-y-1 text-sm">
              <span className="font-medium">{label}</span>
              <input value={(form as any)[key] ?? ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })} required={label.includes('*')} className="w-full rounded-md border bg-background px-3 py-2" />
            </label>
          ))}
          <label className="space-y-1 text-sm">
            <span className="font-medium">Timezone</span>
            <select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} className="w-full rounded-md border bg-background px-3 py-2">
              {LEAD_TIMEZONES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">First Contact</span>
            <input type="date" value={form.firstContact ?? ''} onChange={(e) => setForm({ ...form, firstContact: e.target.value })} className="w-full rounded-md border bg-background px-3 py-2" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Last Contact</span>
            <input type="date" value={form.lastContact ?? ''} onChange={(e) => setForm({ ...form, lastContact: e.target.value })} className="w-full rounded-md border bg-background px-3 py-2" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Next Follow-up Date</span>
            <input type="date" value={form.nextFollowUpDate ?? ''} onChange={(e) => setForm({ ...form, nextFollowUpDate: e.target.value })} className="w-full rounded-md border bg-background px-3 py-2" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Follow-up Count</span>
            <input type="number" value={form.followupCount ?? ''} onChange={(e) => setForm({ ...form, followupCount: e.target.value ? parseInt(e.target.value, 10) : undefined })} className="w-full rounded-md border bg-background px-3 py-2" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Meeting Date</span>
            <input type="date" value={form.meetingDate ?? ''} onChange={(e) => setForm({ ...form, meetingDate: e.target.value })} className="w-full rounded-md border bg-background px-3 py-2" />
          </label>
          <label className="col-span-full space-y-1 text-sm">
            <span className="font-medium">Comments</span>
            <textarea value={form.comments ?? ''} onChange={(e) => setForm({ ...form, comments: e.target.value })} rows={2} className="w-full rounded-md border bg-background px-3 py-2" />
          </label>
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

          <div className="col-span-full flex items-center gap-3">
            <button type="submit" disabled={create.isPending} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
              {create.isPending ? 'Creating…' : 'Create & open'}
            </button>
            <button type="button" onClick={closeForm} disabled={create.isPending} className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60">
              Cancel
            </button>
            {create.isError && !dupBlock && <span className="text-sm text-[var(--tone-red-fg)]">Failed to create lead</span>}
          </div>
        </form>
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
        deleteConfirm={() => 'Are you sure you want to delete the selected lead(s)? This action cannot be undone.'}
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
