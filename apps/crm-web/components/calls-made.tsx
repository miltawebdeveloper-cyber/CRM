'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Phone, PhoneOutgoing, PhoneIncoming, PhoneMissed, PhoneOff, CheckCircle2, Clock, Timer, Download, MapPin, Building2, Tag, PhoneCall, User as UserIcon, Info, ClipboardCheck, Hourglass } from 'lucide-react';
import { callsApi, outcomesApi, formatDuration, type CallRecord } from '@/lib/crm';
import { OutcomePill } from '@/components/outcome-pill';
import { DataTable, useColumnPrefs, type ColumnDef } from '@/components/data-table';
import { downloadCsv, downloadXlsx } from '@/lib/export';
import { Avatar } from '@/components/page-head';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { CAT, DirectionPill, useCallFilters } from '@/components/calls-shared';
import { DateFilter, FilterSelect, optionsFrom } from '@/components/filter-controls';
import { useCallingEnabled } from '@/lib/use-calling-enabled';

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
  // With dialling off no call rows are written at all, which is the single
  // likeliest reason this view is empty — see the notice below.
  const { callingEnabled, disabledReason } = useCallingEnabled();

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
      // back to whether it was completed in the dialer. A processed row is marked
      // as such, so it is never mistaken for a call that was actually placed.
      render: (c) =>
        c.kind === 'processed' ? (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-[#eef0e8] px-2 py-[3px] text-[11px] font-semibold text-[#6b7359]"
            title="Worked from the queue with no call placed — dialling was switched off"
          >
            <ClipboardCheck className="h-3 w-3" /> No call
          </span>
        ) : (
          <span className="capitalize text-muted-foreground">{c.status ?? (c.endTime ? 'completed' : 'in progress')}</span>
        ),
    },
    // Blank for a processed row: no call was placed, so there is no duration to
    // report and a zero would read as a call that connected for no time.
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
        <KpiCard icon={Phone} iconBg="#e7f0f8" iconColor="#2c5d8f" value={(stats?.total ?? 0).toLocaleString()} label="Total Calls Made" />
        <KpiCard icon={PhoneOutgoing} iconBg="#e7eed8" iconColor="#42512f" value={(stats?.outgoing ?? 0).toLocaleString()} label="Outgoing Calls" />
        <KpiCard icon={PhoneIncoming} iconBg="#e3f1ee" iconColor="#2f6f63" value={(stats?.incoming ?? 0).toLocaleString()} label="Incoming Calls" />
        <KpiCard icon={CheckCircle2} iconBg="#e8f2e4" iconColor="#3f7a32" value={(stats?.connected ?? 0).toLocaleString()} label={`Connected · ${stats?.connectedPct ?? 0}%`} />
        <KpiCard icon={PhoneMissed} iconBg="#fdecdc" iconColor="#c98a18" value={(stats?.missed ?? 0).toLocaleString()} label="Missed Calls" />
        <KpiCard icon={PhoneOff} iconBg="#fbeeec" iconColor="#a8431f" value={(stats?.failed ?? 0).toLocaleString()} label="Failed Calls" />
        <KpiCard icon={Clock} iconBg="#fbf3e2" iconColor="#c98a18" value={formatDuration(stats?.totalDurationSecs ?? 0)} label="Call Duration" />
        <KpiCard icon={Timer} iconBg="#eef0e8" iconColor="#6b7359" value={formatDuration(stats?.avgDurationSecs ?? 0)} label="Avg Call" />
        {/* Leads worked with no call placed. Its own tile rather than part of
            Total Calls Made — the work is real and belongs in the log, but it
            wasn't dialled, and rolling it into call volume would overstate it. */}
        {(stats?.processed ?? 0) > 0 && (
          <>
            <KpiCard icon={ClipboardCheck} iconBg="#eef0e8" iconColor="#6b7359" value={(stats?.processed ?? 0).toLocaleString()} label="Processed · no call" />
            {/* Handling time, kept apart from talk time for the same reason the
                counts are: it is time spent working the lead, not on the phone. */}
            <KpiCard icon={Hourglass} iconBg="#eef0e8" iconColor="#6b7359" value={formatDuration(stats?.processingSecs ?? 0)} label="Processing Time" />
            <KpiCard icon={Timer} iconBg="#eef0e8" iconColor="#6b7359" value={formatDuration(stats?.avgProcessingSecs ?? 0)} label="Avg per Lead" />
          </>
        )}
      </div>

      {/* Why this view is empty while calling is switched off.
          Nothing is wrong: with dialling disabled the queue records dispositions
          straight onto the lead and writes NO call row, deliberately, so the
          figures above stay honest about a day on which nobody dialled. Without
          saying so, an empty Call Details table after a full shift of processed
          leads reads as lost data, which is exactly how this gets reported as a
          sync bug. The panel's own Calls Completed card does count that work. */}
      {!callingEnabled && (
        <div className="mb-[14px] flex items-start gap-2.5 rounded-xl border border-[#e8dcc0] bg-[#fbf6e9] px-4 py-3 text-[12.5px] text-[#7a5d17]">
          <Info className="mt-[1px] h-4 w-4 shrink-0" />
          <div>
            <div className="font-semibold">Calling is switched off — leads worked from the queue show as “No call”.</div>
            <div className="mt-0.5 leading-relaxed">
              {disabledReason || 'The queue records the outcome and notes against the lead itself.'} Those records carry no
              duration or direction because no call was placed, and they are counted under{' '}
              <span className="font-medium">Processed · no call</span> rather than Total Calls Made, so call volume stays
              accurate. Dialled calls resume appearing as soon as an admin turns calling back on (Settings → Calling Mode).
            </div>
          </div>
        </div>
      )}

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
        // The tiles count every matching contact; the table can only carry 500.
        // Say so against the real total rather than implying the page IS the
        // result. "Records" not "calls", because the log also lists leads worked
        // with no call placed.
        subtitle={`${filteredRecords.length.toLocaleString()} record${filteredRecords.length === 1 ? '' : 's'}${
          stats && stats.totalContacts > filteredRecords.length ? ` shown · ${stats.totalContacts.toLocaleString()} match the filters` : ''
        }`}
        loading={isLoading}
        emptyText="No records match the selected filters."
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

// The 8-tile summary row used to define its own StatTile here. That tile became
// the standard card for the whole app, so it now lives in KpiCard and this file
// just uses it — one definition, no drift.

