'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Phone, PhoneOutgoing, PhoneIncoming, PhoneMissed, PhoneOff, CheckCircle2, Clock, Timer, Download, MapPin, Building2, Tag, PhoneCall, User as UserIcon } from 'lucide-react';
import { callsApi, outcomesApi, formatDuration, type CallRecord } from '@/lib/crm';
import { OutcomePill } from '@/components/outcome-pill';
import { DataTable, useColumnPrefs, type ColumnDef } from '@/components/data-table';
import { downloadCsv, downloadXlsx } from '@/lib/export';
import { Avatar } from '@/components/page-head';
import { CAT, DirectionPill, useCallFilters } from '@/components/calls-shared';
import { DateFilter, FilterSelect, optionsFrom } from '@/components/filter-controls';

const LEAD_STATUS_OPTS = [
  { label: 'All Lead Statuses', value: '' },
  { label: 'Assigned', value: 'assigned' },
  { label: 'Unassigned', value: 'unassigned' },
  { label: 'Contacted', value: 'contacted' },
] as const;

const TIMEZONES = ['EST', 'CST', 'MST', 'PST'];

/**
 * Calls Made — the call log: what was dialled in the selected range, summarised,
 * with every record behind it. Analysis of those calls (targets, ratios, the
 * pipeline) lives on the Analytics tab; this tab stays a history.
 *
 * Employees see their own calls; managers see the team and can narrow to one
 * rep. The API enforces both regardless of what the UI shows.
 */
export function CallsMade({ isManager }: { isManager: boolean }) {
  const filters = useCallFilters(isManager);
  const { params: scope, dateFilter, setDateFilter, userId, setUserId, userOpts } = filters;

  const [tz, setTz] = useState('');
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [leadStatus, setLeadStatus] = useState('');
  const [callStatus, setCallStatus] = useState('');

  // Every filter goes to the API. Applying the geography/status ones in the
  // browser used to mean the tiles (server-side) and the table (client-side)
  // described different sets of calls, and that filtering only ever saw the
  // capped page of rows already loaded — so a filtered total was simply wrong.
  const params = useMemo(
    () => ({
      ...scope,
      ...(tz ? { timezone: tz } : {}),
      ...(state ? { state } : {}),
      ...(city ? { city } : {}),
      ...(leadStatus ? { leadStatus } : {}),
      ...(callStatus ? { outcome: callStatus } : {}),
    }),
    [scope, tz, state, city, leadStatus, callStatus],
  );

  // Both queries key off the same params, so the summary and rows always agree.
  const { data: stats } = useQuery({ queryKey: ['calls-made', 'stats', params], queryFn: () => callsApi.madeStats(params) });
  const { data: records = [], isLoading } = useQuery({ queryKey: ['calls-made', 'records', params], queryFn: () => callsApi.madeRecords(params) });
  const { data: outcomes = [] } = useQuery({ queryKey: ['outcomes-config'], queryFn: outcomesApi.list });
  // Menu options follow the date/employee scope only — not the geography filters
  // themselves, or picking a state would erase every other state from the menu.
  const { data: filterOpts } = useQuery({
    queryKey: ['calls-made', 'filters', scope],
    queryFn: () => callsApi.madeFilters(scope),
  });

  const outcomeOf = (slug: string | null) => outcomes.find((o) => o.slug === slug);

  const columns = useMemo<ColumnDef<CallRecord>[]>(() => [
    {
      key: 'startTime', header: 'Call Date & Time', required: true, searchable: true,
      searchValue: (c) => new Date(c.startTime).toLocaleString(),
      render: (c) => (
        <div>
          <div className="font-medium">{new Date(c.startTime).toLocaleDateString()}</div>
          <div className="text-[11.5px] text-muted-foreground">{new Date(c.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
      ),
    },
    {
      key: 'customer', header: 'Customer Name', searchable: true, searchValue: (c) => c.lead?.businessName,
      render: (c) => c.lead ? (
        <div className="flex items-center gap-[10px]">
          <Avatar name={c.lead.businessName} />
          <div>
            <div className="font-medium">{c.lead.businessName}</div>
            {c.lead.contactName && <div className="text-[11.5px] text-muted-foreground">{c.lead.contactName}</div>}
          </div>
        </div>
      ) : '—',
    },
    { key: 'phone', header: 'Phone Number', cellClassName: 'font-mono text-[12px] text-muted-foreground', searchable: true, searchValue: (c) => c.lead?.phone, render: (c) => c.lead?.phone ?? '—' },
    { key: 'caller', header: 'Assigned Employee', searchable: true, trackable: true, searchValue: (c) => c.caller?.name, render: (c) => c.caller?.name ?? '—' },
    { key: 'direction', header: 'Direction', render: (c) => <DirectionPill direction={c.direction} /> },
    {
      key: 'status', header: 'Call Status', searchable: true, searchValue: (c) => c.status,
      // No provider status means the call never went through OpenPhone; fall
      // back to whether it was completed in the dialer.
      render: (c) => <span className="capitalize text-muted-foreground">{c.status ?? (c.endTime ? 'completed' : 'in progress')}</span>,
    },
    { key: 'duration', header: 'Call Duration', cellClassName: 'tabular-nums', render: (c) => c.durationSecs != null ? formatDuration(c.durationSecs) : '—' },
    {
      key: 'outcome', header: 'Call Outcome', trackable: true, searchable: true,
      searchValue: (c) => outcomeOf(c.outcome)?.name,
      render: (c) => {
        const o = outcomeOf(c.outcome);
        return c.outcome ? <OutcomePill name={o?.name ?? c.outcome} color={o?.color} /> : <span className="text-muted-foreground">—</span>;
      },
    },
    { key: 'leadId', header: 'Lead ID', cellClassName: 'font-mono text-[11.5px] text-muted-foreground', searchable: true, searchValue: (c) => c.lead?.leadId, render: (c) => c.lead?.leadId ?? '—' },
    { key: 'leadStatus', header: 'Lead Status', cellClassName: 'capitalize text-muted-foreground', searchable: true, searchValue: (c) => c.lead?.status, render: (c) => c.lead?.status?.replace(/_/g, ' ') ?? '—' },
  ], [outcomes]); // eslint-disable-line react-hooks/exhaustive-deps

  const prefs = useColumnPrefs('calls-made', columns);

  // Cascading geography menus, built from the whole scope rather than the loaded
  // page, so every state/city that actually has calls is offered.
  const geo = useMemo(() => filterOpts?.geo ?? [], [filterOpts]);
  const stateOpts = useMemo(
    () => optionsFrom(geo.filter((g) => !tz || g.timezone === tz).map((g) => g.state), 'All States'),
    [geo, tz],
  );
  const cityOpts = useMemo(
    () => optionsFrom(
      geo.filter((g) => (!tz || g.timezone === tz) && (!state || g.state === state)).map((g) => g.city),
      'All Cities',
    ),
    [geo, tz, state],
  );

  // Driven by the configured outcome list (Admin → Outcomes) instead of a frozen
  // copy of it, plus any legacy imported statuses still present in the data, so
  // renaming or adding an outcome can't silently break this filter.
  const callStatusOpts = useMemo(() => {
    const fromOutcomes = outcomes.map((o) => ({ label: o.name, value: o.slug }));
    const known = new Set(outcomes.map((o) => o.name.toLowerCase()));
    const legacy = (filterOpts?.callStatuses ?? [])
      .filter((s) => !known.has(s.toLowerCase()))
      .map((s) => ({ label: s, value: s }));
    return [{ label: 'All Call Statuses', value: '' }, ...fromOutcomes, ...legacy];
  }, [outcomes, filterOpts]);

  // The API already applied every filter — the table shows exactly what it returned.
  const filteredRecords = records;

  // Name the file after what's in it — the range and the rep are the whole
  // reason someone pulled this export.
  const exportName = [
    'calls-made',
    dateFilter.from && dateFilter.to ? `${dateFilter.from}_${dateFilter.to}` : 'all-dates',
    userId ? userOpts.find((u) => u.value === userId)?.label.replace(/\s+/g, '-').toLowerCase() : null,
  ].filter(Boolean).join('-');

  // Export mirrors what's on screen: the same rows the filters produced, in the
  // same order, with the outcome/status resolved to the names people recognise
  // rather than the slugs stored on the call.
  // Deliberately reports only WHETHER a recording exists, never its URL: provider
  // recording links are signature-authorized (anyone holding one can fetch the
  // audio without a CRM session) and are rotated/refreshed server-side, so putting
  // them in a spreadsheet both leaks access and goes stale. Play or download from
  // the Recordings tab, which enforces the manager-only rule on every request.
  const EXPORT_HEADERS = [
    'Call Date', 'Call Time', 'Customer Name', 'Contact Person', 'Phone Number',
    'Assigned Employee', 'Direction', 'Call Status', 'Call Duration', 'Duration (secs)',
    'Call Outcome', 'Funnel Bucket', 'Lead ID', 'Lead Status', 'Recording',
  ];
  const exportRows = () => filteredRecords.map((c) => {
    const o = outcomeOf(c.outcome);
    const start = new Date(c.startTime);
    return [
      start.toLocaleDateString(),
      start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      c.lead?.businessName ?? '',
      c.lead?.contactName ?? '',
      c.lead?.phone ?? '',
      c.caller?.name ?? '',
      c.direction ? (c.direction === 'inbound' ? 'Incoming' : 'Outgoing') : '',
      c.status ?? (c.endTime ? 'completed' : 'in progress'),
      c.durationSecs != null ? formatDuration(c.durationSecs) : '',
      c.durationSecs ?? '',
      o?.name ?? c.outcome ?? '',
      o?.category ? CAT[o.category].label : '',
      c.lead?.leadId ?? '',
      c.lead?.status?.replace(/_/g, ' ') ?? '',
      c.hasRecording ? 'Yes' : 'No',
    ];
  });

  return (
    <div>
      {/* Call summary — eight nano-compact stat tiles. A tighter gap + smaller
          padding keeps all 8 in a single row on typical ≥1280 px screens. */}
      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
        <StatTile icon={Phone} iconBg="#e7f0f8" iconColor="#2c5d8f" value={(stats?.total ?? 0).toLocaleString()} label="Total Calls Made" />
        <StatTile icon={PhoneOutgoing} iconBg="#e7eed8" iconColor="#42512f" value={(stats?.outgoing ?? 0).toLocaleString()} label="Outgoing Calls" />
        <StatTile icon={PhoneIncoming} iconBg="#e3f1ee" iconColor="#2f6f63" value={(stats?.incoming ?? 0).toLocaleString()} label="Incoming Calls" />
        <StatTile icon={CheckCircle2} iconBg="#e8f2e4" iconColor="#3f7a32" value={(stats?.connected ?? 0).toLocaleString()} label={`Connected · ${stats?.connectedPct ?? 0}%`} />
        <StatTile icon={PhoneMissed} iconBg="#fdecdc" iconColor="#c98a18" value={(stats?.missed ?? 0).toLocaleString()} label="Missed Calls" />
        <StatTile icon={PhoneOff} iconBg="#fbeeec" iconColor="#a8431f" value={(stats?.failed ?? 0).toLocaleString()} label="Failed Calls" />
        <StatTile icon={Clock} iconBg="#fbf3e2" iconColor="#c98a18" value={formatDuration(stats?.totalDurationSecs ?? 0)} label="Call Duration" />
        <StatTile icon={Timer} iconBg="#eef0e8" iconColor="#6b7359" value={formatDuration(stats?.avgDurationSecs ?? 0)} label="Avg Call" />
      </div>

      {/* Call Details filters — same geography/status/date bar as Lead Management. */}
      <div className="mb-[14px] flex flex-wrap items-center gap-2.5">
        {isManager && <FilterSelect icon={UserIcon} value={userId} onChange={setUserId} options={userOpts} />}
        <FilterSelect icon={Clock} value={tz} onChange={(v) => { setTz(v); setState(''); setCity(''); }} options={[{ label: 'All Timezones', value: '' }, ...TIMEZONES.map((t) => ({ label: t, value: t }))]} />
        <FilterSelect icon={MapPin} value={state} onChange={(v) => { setState(v); setCity(''); }} options={stateOpts} />
        <FilterSelect icon={Building2} value={city} onChange={setCity} options={cityOpts} />
        <FilterSelect icon={Tag} value={leadStatus} onChange={setLeadStatus} options={LEAD_STATUS_OPTS} />
        <FilterSelect icon={PhoneCall} value={callStatus} onChange={setCallStatus} options={callStatusOpts} />
        <DateFilter value={dateFilter} onChange={setDateFilter} />
      </div>

      {/* Call records — same table component and behaviour as Lead Management. */}
      <DataTable
        tableKey="calls-made"
        columns={columns}
        rows={filteredRecords}
        getRowKey={(c) => c.id}
        title="Call Details"
        // The tiles count every matching call; the table can only carry 500. Say so
        // against the real total rather than implying the page IS the result.
        subtitle={`${filteredRecords.length.toLocaleString()} call${filteredRecords.length === 1 ? '' : 's'}${
          stats && stats.total > filteredRecords.length ? ` shown · ${stats.total.toLocaleString()} match the filters` : ''
        }`}
        loading={isLoading}
        emptyText="No calls match the selected filters."
        prefs={prefs}
        selectable={false}
        fillViewport
        toolbar={
          <>
            <button
              onClick={() => downloadCsv(exportName, EXPORT_HEADERS, exportRows())}
              disabled={filteredRecords.length === 0}
              className="inline-flex items-center gap-[7px] rounded-md border bg-card px-3 py-2 text-[13px] font-medium hover:bg-muted disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5 text-muted-foreground" /> Export CSV
            </button>
            <button
              onClick={() => downloadXlsx(exportName, EXPORT_HEADERS, exportRows())}
              disabled={filteredRecords.length === 0}
              className="inline-flex items-center gap-[7px] rounded-md border bg-card px-3 py-2 text-[13px] font-medium hover:bg-muted disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5 text-muted-foreground" /> Export Excel
            </button>
          </>
        }
      />
    </div>
  );
}

// ── StatTile ──────────────────────────────────────────────────────────────────
// A slimmer, more compact variant of KpiCard used for the 8-tile summary row.
// Smaller padding, icon, value, and label so all 8 sit comfortably on one line
// without crowding at typical 1280 px+ viewports.
import type { LucideIcon } from 'lucide-react';

function StatTile({ icon: Icon, iconBg, iconColor, value, label }: {
  icon: LucideIcon;
  iconBg: string;
  iconColor: string;
  value: React.ReactNode;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2.5 overflow-hidden rounded-xl border bg-card px-3 py-2.5 shadow-sm transition-all hover:-translate-y-[1px] hover:shadow-md">
      <div
        className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[8px]"
        style={{ background: iconBg, color: iconColor }}
      >
        <Icon className="h-[13px] w-[13px]" />
      </div>
      <div className="min-w-0">
        <div className="font-display text-[16px] font-semibold leading-none tracking-tight">{value}</div>
        <div className="mt-[3px] truncate text-[10px] font-medium text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}
