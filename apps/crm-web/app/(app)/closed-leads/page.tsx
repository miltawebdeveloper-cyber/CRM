'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Download, Eye, Clock, MapPin, Building2, PhoneCall, Info } from 'lucide-react';
import { leadsApi, type Lead } from '@/lib/leads';
import { LeadActivityDrawer } from '@/components/lead-activity-log';
import { api } from '@/lib/api';
import { PageHead, Avatar } from '@/components/page-head';
import { DateFilter, FilterSelect, SearchInput, optionsFrom } from '@/components/filter-controls';
import { DataTable, useColumnPrefs, type ColumnDef } from '@/components/data-table';
import { downloadCsv, downloadXlsx } from '@/lib/export';
import { inDateBounds, EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';
import { usePersistedState } from '@/lib/use-persisted-state';

const CALL_STATUS_OPTS = [
  { label: 'All Call Statuses', value: '' },
  { label: 'Closed-Won',        value: 'Closed-Won' },
  { label: 'Closed-Lost',       value: 'Closed-Lost' },
  { label: 'Negotiation',       value: 'Negotiation' },
  { label: 'Meeting Scheduled', value: 'Meeting Scheduled' },
  { label: 'Zoom',              value: 'Zoom' },
  { label: 'Not Interested',    value: 'Not Interested' },
  { label: 'Dm-Not Interested', value: 'Dm-Not Interested' },
];

export default function ClosedLeadsPage() {
  const router = useRouter();
  const [tz, setTz] = useState('');
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [callStatus, setCallStatus] = useState('');
  const [closedBy, setClosedBy] = useState('');
  // Persisted so the chosen date filter survives navigating within the module.
  const [dateFilter, setDateFilter] = usePersistedState<DateFilterValue>('closed-leads:date-filter', EMPTY_DATE_FILTER);
  const [q, setQ] = useState('');
  const [activityLead, setActivityLead] = useState<Lead | null>(null);

  // The API scopes this list by role: admins & team leaders get every closed
  // lead in the org, employees only the ones they personally closed.
  const { data: allLeads = [], isLoading } = useQuery({
    queryKey: ['leads', 'closed'],
    queryFn: () => leadsApi.list({ closed: true }),
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
  const exportRows = () => leads.map((l) => [
    l.leadId,
    l.closedAt ? new Date(l.closedAt).toLocaleDateString() : '',
    l.closedBy?.name ?? '',
    l.businessName,
    l.contactName ?? '',
    l.phone,
    l.email ?? '',
    l.country ?? '',
    l.state,
    l.city,
    l.timezone,
    l.industry ?? '',
    l.assignedTo?.name ?? '',
    l.callStatus ?? '',
    l.firstContact ? new Date(l.firstContact).toLocaleDateString() : '',
    l.lastContact ? new Date(l.lastContact).toLocaleDateString() : '',
    l.meetingDate ? new Date(l.meetingDate).toLocaleDateString() : '',
    l.lostReason ?? '',
    l.createdAt ? new Date(l.createdAt).toLocaleDateString() : '',
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
  // Managers can narrow to a single closer; an employee's list is all their own.
  const closerOpts = optionsFrom(
    allLeads.map((l) => l.closedBy?.name).filter((n): n is string => !!n),
    'All Employees',
  );

  const columns = useMemo<ColumnDef<Lead>[]>(() => [
    {
      key: 'leadId', header: 'Lead ID', required: true, searchable: true,
      searchValue: (l) => l.leadId,
      render: (l) => (
        <div className="flex items-center gap-[10px]">
          <Avatar name={l.leadId} />
          <span className="font-mono text-[11.5px] text-muted-foreground">{l.leadId}</span>
        </div>
      ),
    },
    { key: 'closedAt', header: 'Closed Date', cellClassName: 'text-muted-foreground', render: (l) => l.closedAt ? new Date(l.closedAt).toLocaleDateString() : '—', trackable: true },
    { key: 'closedBy', header: 'Closed By', render: (l) => l.closedBy?.name ?? '—', searchable: true, trackable: true, searchValue: (l) => l.closedBy?.name },
    { key: 'businessName', header: 'Company Name', render: (l) => l.businessName, searchable: true, searchValue: (l) => l.businessName },
    { key: 'contactName', header: 'Contact Person', render: (l) => l.contactName ?? '—', searchable: true, searchValue: (l) => l.contactName },
    { key: 'phone', header: 'Phone', cellClassName: 'font-mono text-[12px] text-muted-foreground', render: (l) => l.phone, searchable: true, searchValue: (l) => l.phone },
    { key: 'email', header: 'Email', cellClassName: 'text-muted-foreground', render: (l) => l.email ?? '—', searchable: true, searchValue: (l) => l.email },
    { key: 'country', header: 'Country', cellClassName: 'text-muted-foreground', render: (l) => l.country ?? '—', searchable: true, searchValue: (l) => l.country },
    { key: 'state', header: 'State', cellClassName: 'text-muted-foreground', render: (l) => l.state, searchable: true, searchValue: (l) => l.state },
    { key: 'city', header: 'City', cellClassName: 'text-muted-foreground', render: (l) => l.city, searchable: true, searchValue: (l) => l.city },
    { key: 'tz', header: 'Time Zone', render: (l) => <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold">{l.timezone}</span> },
    { key: 'industry', header: 'Industry', cellClassName: 'text-muted-foreground', render: (l) => l.industry ?? '—', searchable: true, searchValue: (l) => l.industry },
    { key: 'caller', header: 'Assigned To', render: (l) => l.assignedTo?.name ?? '—', searchable: true, searchValue: (l) => l.assignedTo?.name },
    { key: 'callStatus', header: 'Call Status', cellClassName: 'text-muted-foreground', render: (l) => l.callStatus ?? '—', searchable: true, searchValue: (l) => l.callStatus },
    { key: 'firstContact', header: 'First Contact', cellClassName: 'text-muted-foreground', render: (l) => l.firstContact ? new Date(l.firstContact).toLocaleDateString() : '—' },
    { key: 'lastContact', header: 'Last Contact', cellClassName: 'text-muted-foreground', render: (l) => l.lastContact ? new Date(l.lastContact).toLocaleDateString() : '—' },
    { key: 'meetingDate', header: 'Meeting Date', cellClassName: 'text-muted-foreground', render: (l) => l.meetingDate ? new Date(l.meetingDate).toLocaleDateString() : '—' },
    { key: 'lostReason', header: 'Lost Reason', cellClassName: 'text-muted-foreground', render: (l) => l.lostReason ?? '—', searchable: true, searchValue: (l) => l.lostReason },
    { key: 'createdDate', header: 'Created Date', cellClassName: 'text-muted-foreground', render: (l) => l.createdAt ? new Date(l.createdAt).toLocaleDateString() : '—' },
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
              className="grid h-[30px] w-[30px] place-items-center rounded-lg border border-[#bcd9ff] bg-[#f2f8ff] text-[#1f5fae] hover:bg-[#2D8CFF] hover:text-white"
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
  const term = q.trim().toLowerCase();
  // Search runs across every searchable column regardless of which are visible.
  const searchCols = useMemo(() => columns.filter((c) => c.searchable && c.searchValue), [columns]);
  const leads = allLeads.filter((l) => {
    if (callStatus && (l.callStatus ?? '').toLowerCase() !== callStatus.toLowerCase()) return false;
    if (closedBy && l.closedBy?.name !== closedBy) return false;
    if (tz && l.timezone !== tz) return false;
    if (state && l.state !== state) return false;
    if (city && l.city !== city) return false;
    // Closed leads are filtered on when they closed, not when they were created.
    if (!inDateBounds(l.closedAt, dateFilter)) return false;
    if (term && !searchCols.some((c) => String(c.searchValue!(l) ?? '').toLowerCase().includes(term))) return false;
    return true;
  });

  return (
    <div>
      <PageHead>
        <button
          onClick={() => downloadCsv('closed-leads', EXPORT_HEADERS, exportRows())}
          disabled={leads.length === 0}
          className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[13px] font-semibold hover:bg-muted disabled:opacity-50"
        >
          <Download className="h-4 w-4" /> Export CSV
        </button>
        <button
          onClick={() => downloadXlsx('closed-leads', EXPORT_HEADERS, exportRows())}
          disabled={leads.length === 0}
          className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[13px] font-semibold hover:bg-muted disabled:opacity-50"
        >
          <Download className="h-4 w-4" /> Export Excel
        </button>
      </PageHead>

      {/* Filter bar */}
      <div className="mb-[18px] flex flex-wrap items-center gap-2.5">
        <SearchInput value={q} onChange={setQ} placeholder="Search business, ID, phone, email…" className="min-w-[260px] flex-1" />
        <FilterSelect icon={Clock} value={tz} onChange={(v) => { setTz(v); setState(''); setCity(''); }} options={[{ label: 'All Timezones', value: '' }, ...['EST', 'CST', 'MST', 'PST'].map((t) => ({ label: t, value: t }))]} />
        <FilterSelect icon={MapPin} value={state} onChange={(v) => { setState(v); setCity(''); }} options={stateOpts} />
        <FilterSelect icon={Building2} value={city} onChange={setCity} options={cityOpts} />
        {canManage && <FilterSelect icon={Info} value={closedBy} onChange={setClosedBy} options={closerOpts} />}
        <FilterSelect icon={PhoneCall} value={callStatus} onChange={setCallStatus} options={CALL_STATUS_OPTS} />
        <DateFilter value={dateFilter} onChange={setDateFilter} />
      </div>

      {/* Table */}
      <DataTable
        tableKey="closed-leads"
        columns={columns}
        rows={leads}
        getRowKey={(l) => l.id}
        title="Closed Leads"
        subtitle={`${leads.length} shown`}
        loading={isLoading}
        emptyText={allLeads.length === 0 ? 'No closed leads yet.' : 'No closed leads match the current filters.'}
        prefs={prefs}
        selectable={false}
      />

      {/* Lead History drawer — Admin & Team Leader only. */}
      {canManage && activityLead && (
        <LeadActivityDrawer leadId={activityLead.id} leadName={activityLead.businessName} onClose={() => setActivityLead(null)} />
      )}
    </div>
  );
}
