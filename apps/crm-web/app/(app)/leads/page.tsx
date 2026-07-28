'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload, Download, Plus, Phone, Eye, Clock, MapPin, Building2, Filter, Target, Zap, Percent, Info, RefreshCw, PhoneCall, Tag, UserPlus, X, Hourglass, Lock } from 'lucide-react';
import { leadsApi, type CreateLeadInput, type Lead } from '@/lib/leads';
import { LeadActivityDrawer } from '@/components/lead-activity-log';
import { LeadAssignDialog } from '@/components/lead-assign-dialog';
import { LeadOutcomeCell } from '@/components/lead-outcome-cell';
import { LeadCommentCell } from '@/components/lead-comment-cell';
import { LeadInlineCell } from '@/components/lead-inline-cell';
import { metricsApi, outcomesApi } from '@/lib/crm';
import { api } from '@/lib/api';
import { QuoStatusBadge } from '@/components/quo-status-badge';
import { useCanCall } from '@/lib/use-can-call';
import { StatusPill } from '@/components/status-pill';
import { PageHead, Avatar } from '@/components/page-head';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { DateFilter, FilterSelect, SearchInput, optionsFrom } from '@/components/filter-controls';
import { DataTable, useColumnPrefs, type ColumnDef } from '@/components/data-table';
import { sortRows, type SortState } from '@/lib/use-column-prefs';
import { downloadCsv, downloadXlsx } from '@/lib/export';
import { inDateBounds, EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';
import { usePersistedState } from '@/lib/use-persisted-state';

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

// No 'Closed' option — closed leads live in the Closed Leads module and are
// filtered out of this list by the API.
const STATUS_OPTS = [
  { label: 'All Lead Statuses', value: '' },
  { label: 'Assigned',   value: 'assigned' },
  { label: 'Unassigned', value: 'unassigned' },
  { label: 'Contacted',  value: 'contacted' },
];

export default function LeadsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [form, setForm] = useState<CreateLeadInput>(EMPTY);
  const [showForm, setShowForm] = useState(false);
  const [tz, setTz] = useState('');
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [status, setStatus] = useState('');
  const [callStatus, setCallStatus] = useState('');
  // Persisted so the chosen date filter survives navigating within the module.
  const [dateFilter, setDateFilter] = usePersistedState<DateFilterValue>('leads:date-filter', EMPTY_DATE_FILTER);
  const [q, setQ] = useState('');

  // Only active leads — one marked closed moves to /closed-leads.
  //
  // Scope is the API's call, not a flag from here: an employee is pinned to their
  // own assigned leads (so no two employees ever see the same lead), while a
  // manager gets the whole book, which is what makes the select-and-distribute
  // flow below possible at all. Asking for `mine` here would leave a manager with
  // nothing to hand out.
  const { data: allLeads = [], isLoading } = useQuery({
    queryKey: ['leads', 'scoped', 'active'],
    queryFn: () => leadsApi.list({ closed: false }),
  });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data, retry: false });
  const canManage = me?.role === 'admin' || me?.role === 'team_leader';
  // The configured outcome list (Admin → Outcomes) drives both the Call Outcome
  // filter and the inline editor, so renaming or adding an outcome shows up in
  // both with no code change — and the filter can't offer a value the CRM no
  // longer recognises, which the old hard-coded list did.
  const { data: outcomeDefs = [] } = useQuery({ queryKey: ['outcomes-config'], queryFn: outcomesApi.list });
  const callOutcomeOpts = useMemo(
    () => [{ label: 'All Call Outcomes', value: '' }, ...outcomeDefs.map((o) => ({ label: o.name, value: o.slug }))],
    [outcomeDefs],
  );
  // Refuse to dial before the API would reject the call (no assigned caller ID),
  // since the Quo app handoff fires first and can't be taken back.
  const { dial, callingEnabled } = useCanCall();
  // Employees (any non-manager role) get a self-scoped view: they see only their
  // own leads, and their KPI cards are derived from that book.
  const isEmployee = !!me && !canManage;
  const [activityLead, setActivityLead] = useState<Lead | null>(null); // Activity Log drawer (managers only)
  const [assignLeads, setAssignLeads] = useState<Lead[] | null>(null);  // Employee-wise assign popup (managers only)
  const clearTableSelection = useRef<(() => void) | null>(null);        // set from DataTable's bulkActions clear fn
  // Lead lists open in ascending order (by lead id) until the user says otherwise.
  const [sort, setSort] = useState<SortState>({ key: 'leadId', dir: 'asc' });

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

  const EXPORT_HEADERS = [
    'Lead ID',
    'Lead Generation ID',
    'Created Date',
    'Lead Source',
    'Company Name',
    'Contact Person',
    'Designation',
    'Phone',
    'Alt Phone',
    'Email',
    'Website',
    'Social Media',
    'Country',
    'State',
    'City',
    'Time Zone',
    'Industry',
    'Company Size',
    'Founded Year',
    'Address',
    'Assigned To',
    'Call Status',
    'First Contact',
    'Last Contact',
    'Next Follow-up',
    'Follow-up Count',
    'Meeting Date',
    'Lost Reason',
    'Comments'
  ];
  const exportRows = () => leads.map((l) => [
    l.leadId,
    l.leadGenerationId ?? '',
    l.createdAt ? new Date(l.createdAt).toLocaleDateString() : '',
    l.leadSource ?? '',
    l.businessName,
    l.contactName ?? '',
    l.contactName2 ?? '',
    l.phone,
    l.altPhone ?? '',
    l.email ?? '',
    l.website ?? '',
    l.socialMedia ?? '',
    l.country ?? '',
    l.state,
    l.city,
    l.timezone,
    l.industry ?? '',
    l.companySize ?? '',
    l.foundedYear ?? '',
    l.address ?? '',
    l.assignedTo?.name ?? '',
    l.callStatus ?? '',
    l.firstContact ? new Date(l.firstContact).toLocaleDateString() : '',
    l.lastContact ? new Date(l.lastContact).toLocaleDateString() : '',
    l.nextFollowUpDate ? new Date(l.nextFollowUpDate).toLocaleDateString() : '',
    l.followupCount ?? '',
    l.meetingDate ? new Date(l.meetingDate).toLocaleDateString() : '',
    l.lostReason ?? '',
    l.comments ?? ''
  ]);

  // States cascade from the selected timezone; cities from timezone + state.
  const stateOpts = optionsFrom(
    allLeads.filter((l) => !tz || l.timezone === tz).map((l) => l.state),
    'All States',
  );
  const cityOpts = optionsFrom(
    allLeads.filter((l) => (!tz || l.timezone === tz) && (!state || l.state === state)).map((l) => l.city),
    'All Cities',
  );

  // KPI cards respect the same date filter as the table (backend scopes by createdAt).
  const { data: s } = useQuery({
    queryKey: ['metrics', 'summary', dateFilter.from, dateFilter.to],
    queryFn: () => metricsApi.summary({ from: dateFilter.from || undefined, to: dateFilter.to || undefined }),
    retry: false,
  });

  // Leads still outstanding — always the remainder of whichever ratio the
  // Progress card shows, so the two cards can never disagree.
  //   employee: Progress is contacted/total  → balance is the leads left to contact
  //   manager:  Progress is total/planned    → balance is `balanceLeads` (planned − total)
  // An employee's balance can't use `balanceLeads`: targets are set per
  // territory, not per user, so `plannedLeads` is the whole territory's target
  // and would dwarf one person's book.
  const balanceLeads = isEmployee
    ? Math.max((s?.totalLeads ?? 0) - (s?.contactedLeads ?? 0), 0)
    : (s?.balanceLeads ?? 0);

  // Soft-delete selected leads (Admin / TL). Runs sequentially, then refreshes.
  // One transaction, not a loop of requests — deleting a few hundred leads used to
  // fire that many round-trips. Refreshes the table and every dashboard count.
  const removeLeads = useMutation({
    mutationFn: (rows: Lead[]) => leadsApi.bulkDelete(rows.map((l) => l.id)),
    meta: { successMessage: 'Selected lead(s) deleted' },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['metrics', 'summary'] });
      qc.invalidateQueries({ queryKey: ['assignments-summary'] });
      // Deleting removes leads from whoever held them — the Calling Panel's queue
      // and its Assigned / Pending counts both drop with it.
      qc.invalidateQueries({ queryKey: ['caller-leads'] });
      qc.invalidateQueries({ queryKey: ['caller-dash'] });
    },
  });

  const create = useMutation({
    // Drop empty optional strings so they persist as null rather than "".
    mutationFn: () => {
      const cleaned = Object.fromEntries(
        Object.entries(form).map(([k, v]) => [k, typeof v === 'string' && v.trim() === '' ? undefined : v]),
      ) as CreateLeadInput;
      return leadsApi.create({ ...cleaned, businessName: form.businessName, phone: form.phone, state: form.state, city: form.city });
    },
    meta: { successMessage: 'Lead created' },
    onSuccess: (lead) => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      router.push(`/leads/${lead.id}`);
    },
  });

  // Dismiss without submitting — also drops anything typed so the form starts
  // clean next time it's opened.
  const closeForm = () => { setForm(EMPTY); setShowForm(false); create.reset(); };

  const columns = useMemo<ColumnDef<Lead>[]>(() => [
    {
      key: 'leadId', header: 'Lead ID', required: true, searchable: true, sortable: true,
      searchValue: (l) => l.leadId,
      render: (l) => (
        <div className="flex items-center gap-[10px]">
          <Avatar name={l.leadId} />
          <span className="font-mono text-[11.5px] text-muted-foreground">{l.leadId}</span>
        </div>
      ),
    },
    { key: 'leadGenerationId', header: 'Lead Generation ID', cellClassName: 'text-muted-foreground', render: (l) => l.leadGenerationId ?? '—', searchable: true, sortable: true, searchValue: (l) => l.leadGenerationId },
    { key: 'createdDate', header: 'Created Date', cellClassName: 'text-muted-foreground', render: (l) => l.createdAt ? new Date(l.createdAt).toLocaleDateString() : '—' },
    { key: 'leadSource', header: 'Lead Source', cellClassName: 'text-muted-foreground', render: (l) => l.leadSource ?? '—', searchable: true, sortable: true, searchValue: (l) => l.leadSource },
    { key: 'businessName', header: 'Company Name', render: (l) => l.businessName, searchable: true, sortable: true, searchValue: (l) => l.businessName },
    { key: 'contactName', header: 'Contact Person', render: (l) => l.contactName ?? '—', searchable: true, sortable: true, searchValue: (l) => l.contactName },
    { key: 'contactName2', header: 'Designation', render: (l) => l.contactName2 ?? '—', searchable: true, sortable: true, searchValue: (l) => l.contactName2 },
    { key: 'phone', header: 'Phone', cellClassName: 'font-mono text-[12px] text-muted-foreground', render: (l) => l.phone, searchable: true, sortable: true, searchValue: (l) => l.phone },
    { key: 'altPhone', header: 'Alt Phone', cellClassName: 'font-mono text-[12px] text-muted-foreground', render: (l) => l.altPhone ?? '—', searchable: true, sortable: true, searchValue: (l) => l.altPhone },
    { key: 'email', header: 'Email', cellClassName: 'text-muted-foreground', render: (l) => l.email ?? '—', searchable: true, sortable: true, searchValue: (l) => l.email },
    { key: 'website', header: 'Website', cellClassName: 'text-muted-foreground', render: (l) => l.website ?? '—', searchable: true, sortable: true, searchValue: (l) => l.website },
    { key: 'socialMedia', header: 'Social Media', cellClassName: 'text-muted-foreground', render: (l) => l.socialMedia ?? '—', searchable: true, sortable: true, searchValue: (l) => l.socialMedia },
    { key: 'country', header: 'Country', cellClassName: 'text-muted-foreground', render: (l) => l.country ?? '—', searchable: true, sortable: true, searchValue: (l) => l.country },
    { key: 'state', header: 'State', cellClassName: 'text-muted-foreground', render: (l) => l.state, searchable: true, sortable: true, searchValue: (l) => l.state },
    { key: 'city', header: 'City', cellClassName: 'text-muted-foreground', render: (l) => l.city, searchable: true, sortable: true, searchValue: (l) => l.city },
    { key: 'tz', header: 'Time Zone', render: (l) => <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold">{l.timezone}</span> },
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
          <span className="inline-flex items-center gap-1 rounded-full bg-[#d8eed9] px-2 py-0.5 text-[11px] font-medium text-[#266929]">
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
    { key: 'firstContact', header: 'First Contact', cellClassName: 'text-muted-foreground', render: (l) => l.firstContact ? new Date(l.firstContact).toLocaleDateString() : '—' },
    { key: 'lastContact', header: 'Last Contact', cellClassName: 'text-muted-foreground', render: (l) => l.lastContact ? new Date(l.lastContact).toLocaleDateString() : '—' },
    { key: 'followup', header: 'Next Follow-up', cellClassName: 'text-muted-foreground', render: (l) => l.nextFollowUpDate ? new Date(l.nextFollowUpDate).toLocaleDateString() : '—', trackable: true },
    { key: 'followupCount', header: 'Follow-up Count', cellClassName: 'text-muted-foreground', render: (l) => l.followupCount ?? '—' },
    // Requested tail order: Meeting Date → Comments → Lost Reason → Actions. Comments
    // and Lost Reason both edit in place; Comments also syncs with call notes.
    { key: 'meetingDate', header: 'Meeting Date', cellClassName: 'text-muted-foreground', render: (l) => l.meetingDate ? new Date(l.meetingDate).toLocaleDateString() : '—' },
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
          {/* Lead History — Admin & Team Leader only; hidden entirely for employees. */}
          {canManage && (
            <button
              onClick={() => setActivityLead(l)}
              title="Lead history"
              aria-label="Lead history"
              className="grid h-[30px] w-[30px] place-items-center rounded-lg border border-[#bcd9ff] bg-[#f2f8ff] text-[#1f5fae] hover:bg-[#2D8CFF] hover:text-white"
            >
              <Info className="h-[15px] w-[15px]" />
            </button>
          )}
          <div className="flex gap-1.5 opacity-50 transition-opacity group-hover:opacity-100">
            {/* Hidden while calling is disabled — a Call button that can't call is
                worse than no button. The row's View action still opens the lead. */}
            {callingEnabled && (
              <button onClick={() => { if (!dial(l.phone)) return; router.push(`/calling?leadId=${l.id}&autocall=1`); }} title="Call" aria-label={`Call ${l.businessName}`} className="grid h-[30px] w-[30px] place-items-center rounded-lg border text-[#1d491f] hover:bg-primary hover:text-primary-foreground dark:text-foreground"><Phone className="h-[15px] w-[15px]" /></button>
            )}
            <button onClick={() => router.push(`/leads/${l.id}`)} title="View" aria-label={`View ${l.businessName}`} className="grid h-[30px] w-[30px] place-items-center rounded-lg border text-[#1d491f] hover:bg-primary hover:text-primary-foreground dark:text-foreground"><Eye className="h-[15px] w-[15px]" /></button>
          </div>
        </div>
      ),
    },
  ], [router, canManage, dial, callingEnabled]);

  // Shared column prefs for Column Customization (visibility/order) — unchanged.
  const prefs = useColumnPrefs('leads', columns);
  const term = q.trim().toLowerCase();
  // All columns that have a searchValue — search runs across ALL of them regardless
  // of which columns the user has toggled visible in Column Customization.
  const searchCols = useMemo(() => columns.filter((c) => c.searchable && c.searchValue), [columns]);
  const filteredLeads = allLeads.filter((l) => {
    // Lead Status filter logic
    if (status === 'assigned'   && !l.assignedTo) return false;
    if (status === 'unassigned' && !!l.assignedTo) return false;
    if (status === 'contacted'  && l.status !== 'contacted') return false;
    // Call Status filter (case-insensitive match)
    // Match on the slug OR the display name. A lead dispositioned through the CRM
    // stores the outcome's SLUG (`call_back`), while leads imported before the
    // outcome list existed carry the display NAME ("Call Back") — and the inline
    // editor writes slugs, so a name-only comparison would quietly stop matching
    // every lead the moment its outcome was corrected.
    if (callStatus) {
      const have = (l.callStatus ?? '').toLowerCase();
      const want = callStatus.toLowerCase();
      const alias = (outcomeDefs.find((o) => o.slug === callStatus)?.name ?? '').toLowerCase();
      if (have !== want && (!alias || have !== alias)) return false;
    }
    // Remaining filters
    if (tz && l.timezone !== tz) return false;
    if (state && l.state !== state) return false;
    if (city && l.city !== city) return false;
    if (!inDateBounds(l.createdAt, dateFilter)) return false;
    if (term && !searchCols.some((c) => String(c.searchValue!(l) ?? '').toLowerCase().includes(term))) return false;
    return true;
  });

  // Sorting is owned here rather than inside the table so that Export CSV/Excel can
  // reuse the exact order on screen — `leads` is what both the grid and the export
  // read. Ascending by lead id is the default, per spec.
  const sortedLeads = useMemo(() => sortRows(filteredLeads, sort, columns), [filteredLeads, sort, columns]);
  const leads = sortedLeads;

  return (
    <div>
      <PageHead>
        {canManage && (
          <button onClick={() => router.push('/import')} className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[13px] font-semibold hover:bg-muted">
            <Upload className="h-4 w-4" /> Import CSV
          </button>
        )}
        <button
          onClick={() => downloadCsv('leads', EXPORT_HEADERS, exportRows())}
          disabled={leads.length === 0}
          className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[13px] font-semibold hover:bg-muted disabled:opacity-50"
        >
          <Download className="h-4 w-4" /> Export CSV
        </button>
        <button
          onClick={() => downloadXlsx('leads', EXPORT_HEADERS, exportRows())}
          disabled={leads.length === 0}
          className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[13px] font-semibold hover:bg-muted disabled:opacity-50"
        >
          <Download className="h-4 w-4" /> Export Excel
        </button>
        {canManage && (
          <button
            onClick={() => { setSyncMsg(null); syncAll.mutate(); }}
            disabled={syncAll.isPending}
            title="Push every not-yet-synced lead to QUO/OpenPhone as a contact"
            className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[13px] font-semibold hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${syncAll.isPending ? 'animate-spin' : ''}`} />
            {syncAll.isPending ? 'Syncing…' : 'Sync all to QUO'}
          </button>
        )}
        <button onClick={() => (showForm ? closeForm() : setShowForm(true))} className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[13px] font-semibold text-primary-foreground shadow-sm hover:opacity-90">
          {showForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />} {showForm ? 'Close' : 'Add Lead'}
        </button>
      </PageHead>
      {syncMsg && (
        <div className="mb-3 rounded-md border bg-muted/50 px-3 py-2 text-[13px] text-muted-foreground">{syncMsg}</div>
      )}

      {/* KPIs — for employees every card is derived from their own assigned book. */}
      <div className="mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        <KpiCard icon={Target} iconBg="#e7f0f8" iconColor="#2c5d8f" value={(s?.totalLeads ?? 0).toLocaleString()} label="Total Leads" />
        <KpiCard icon={Zap} iconBg="#d8eed9" iconColor="#266929" value={(isEmployee ? (s?.totalLeads ?? 0) : (s?.plannedLeads ?? 0)).toLocaleString()} label="Assigned Leads" />
        <KpiCard icon={PhoneCall} iconBg="#e3f1ee" iconColor="#2f6f63" value={(s?.contactedLeads ?? 0).toLocaleString()} label="Contacted" />
        <KpiCard icon={Hourglass} iconBg="#fbf3e2" iconColor="#c98a18" value={balanceLeads.toLocaleString()} label="Balance Leads" />
        <KpiCard icon={Percent} iconBg="#e4f2e4" iconColor="#317d34" value={`${isEmployee ? (s?.contactedPct ?? 0) : (s?.progressPct ?? 0)}%`} label={isEmployee ? 'Progress' : 'Progress to Target'} />
      </div>

      {/* Filter bar */}
      <div className="mb-[18px] flex flex-wrap items-center gap-2.5">
        <SearchInput value={q} onChange={setQ} placeholder="Search business, ID, phone, email…" className="min-w-[260px] flex-1" />
        <FilterSelect icon={Clock} value={tz} onChange={(v) => { setTz(v); setState(''); setCity(''); }} options={[{ label: 'All Timezones', value: '' }, ...['EST', 'CST', 'MST', 'PST'].map((t) => ({ label: t, value: t }))]} />
        <FilterSelect icon={MapPin} value={state} onChange={(v) => { setState(v); setCity(''); }} options={stateOpts} />
        <FilterSelect icon={Building2} value={city} onChange={setCity} options={cityOpts} />
        <FilterSelect icon={Tag} value={status} onChange={setStatus} options={STATUS_OPTS} />
        <FilterSelect icon={PhoneCall} value={callStatus} onChange={setCallStatus} options={callOutcomeOpts} />
        <DateFilter value={dateFilter} onChange={setDateFilter} />
      </div>

      {/* Create form */}
      {showForm && (
        <form
          onSubmit={(e) => { e.preventDefault(); create.mutate(); }}
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
          ] as const)
            // Employees can't reassign to others — their new leads are theirs.
            .filter(([key]) => canManage || key !== 'caller')
            .map(([key, label]) => (
            <label key={key} className="space-y-1 text-sm">
              <span className="font-medium">{label}</span>
              <input value={(form as any)[key] ?? ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })} required={label.includes('*')} className="w-full rounded-md border bg-background px-3 py-2" />
            </label>
          ))}
          <label className="space-y-1 text-sm">
            <span className="font-medium">Timezone</span>
            <select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} className="w-full rounded-md border bg-background px-3 py-2">
              {['EST', 'CST', 'MST', 'PST'].map((t) => <option key={t}>{t}</option>)}
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
          <div className="col-span-full flex items-center gap-3">
            <button type="submit" disabled={create.isPending} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
              {create.isPending ? 'Creating…' : 'Create & open'}
            </button>
            <button type="button" onClick={closeForm} disabled={create.isPending} className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60">
              Cancel
            </button>
            {create.isError && <span className="text-sm text-[#9e2b21]">Failed to create lead</span>}
          </div>
        </form>
      )}

      {/* Table */}
      <DataTable
        tableKey="leads"
        columns={columns}
        rows={leads}
        getRowKey={(l) => l.id}
        title="All Leads"
        subtitle={`${leads.length} shown`}
        loading={isLoading}
        emptyText={allLeads.length === 0 ? 'No leads yet — add one above.' : 'No leads match the current filters.'}
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
        // Every row stays selectable, because the checkbox serves DELETE as well as
        // assignment — locking owned leads out of it also made them impossible to
        // bulk-delete. Ownership is protected where it actually matters instead: the
        // Assign popup drops owned and same-day-locked leads from the pool and says
        // so, and the API refuses them regardless of what the client sends. The
        // "Assigned" badge on each row still shows which leads those are.
        onDeleteSelected={canManage ? async (rows) => { await removeLeads.mutateAsync(rows); } : undefined}
        deleteConfirm={() => 'Are you sure you want to delete the selected lead(s)? This action cannot be undone.'}
        bulkActions={canManage ? (rows, clear) => (
          <button
            onClick={() => { clearTableSelection.current = clear; setAssignLeads(rows); }}
            title="Assign selected leads to an employee"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[12.5px] font-semibold text-foreground hover:bg-muted"
          >
            <UserPlus className="h-4 w-4" /> Assign
          </button>
        ) : undefined}
      />

      {/* Lead History drawer — Admin & Team Leader only. */}
      {canManage && activityLead && (
        <LeadActivityDrawer leadId={activityLead.id} leadName={activityLead.businessName} onClose={() => setActivityLead(null)} />
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
