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
import { TIMEZONE_FILTER_OPTIONS_COMPACT } from '@/lib/timezone';
import { useCallingEnabled } from '@/lib/use-calling-enabled';
import { formatDate, formatDateTime, formatTime } from '@/lib/display-settings';

const LEAD_STATUS_OPTS = [
  { label: 'All Lead Statuses', value: '' },
  { label: 'Assigned', value: 'assigned' },
  { label: 'Unassigned', value: 'unassigned' },
  { label: 'Contacted', value: 'contacted' },
] as const;


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
  // Named for what it filters on. It was `callStatus` and labelled "All Call
  // Statuses", but it has always sent `outcome` to the API — with the Call
  // Status column now gone, that name promised a filter on a column that
  // isn't there and hid the one it really is.
  const [outcomeFilter, setOutcomeFilter] = useState('');

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
      ...(outcomeFilter ? { outcome: outcomeFilter } : {}),
    }),
    [scope, tz, state, city, leadStatus, outcomeFilter],
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
      searchValue: (c) => formatDateTime(c.startTime),
      render: (c) => (
        <div>
          <div className="font-medium">{formatDate(c.startTime)}</div>
          <div className="text-[11px] text-muted-foreground">{formatTime(c.startTime)}</div>
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
            {c.lead.contactName && <div className="text-[11px] text-muted-foreground">{c.lead.contactName}</div>}
          </div>
        </div>
      ) : '—',
    },
    { key: 'phone', header: 'Phone Number', cellClassName: 'font-mono text-[11.5px] text-muted-foreground', searchable: true, searchValue: (c) => c.lead?.phone, render: (c) => c.lead?.phone ?? '—' },
    { key: 'caller', header: 'Assigned Employee', searchable: true, trackable: true, searchValue: (c) => c.caller?.name, render: (c) => c.caller?.name ?? '—' },
    {
      key: 'direction', header: 'Direction',
      // The "No call" badge lives here now that the Call Status column is gone.
      // It has to live somewhere: a lead worked from the queue with dialling off
      // has no direction, no duration and no recording, so without the badge its
      // row is indistinguishable from a dialled call that failed to record any
      // of them — which reads as broken data rather than as work done. Direction
      // is its natural home, being the column that says how the contact happened.
      render: (c) =>
        c.kind === 'processed' ? (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-[#f2f2ec] px-2 py-[3px] text-[10.5px] font-semibold text-[#75766a]"
            title="Worked from the queue with no call placed — dialling was switched off"
          >
            <ClipboardCheck className="h-3 w-3" /> No call
          </span>
        ) : (
          <DirectionPill direction={c.direction} />
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
    { key: 'leadId', header: 'Lead ID', cellClassName: 'font-mono text-[11px] text-muted-foreground', searchable: true, searchValue: (c) => c.lead?.leadId, render: (c) => c.lead?.leadId ?? '—' },
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
  const outcomeOpts = useMemo(() => {
    const fromOutcomes = outcomes.map((o) => ({ label: o.name, value: o.slug }));
    const known = new Set(outcomes.map((o) => o.name.toLowerCase()));
    const legacy = (filterOpts?.callStatuses ?? [])
      .filter((s) => !known.has(s.toLowerCase()))
      .map((s) => ({ label: s, value: s }));
    return [{ label: 'All Call Outcomes', value: '' }, ...fromOutcomes, ...legacy];
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
  // Call Status and Lead Status are absent here because they are absent from the
  // table — the export mirrors the columns on screen, and a spreadsheet carrying
  // two fields the module no longer shows is how the two drift apart.
  const EXPORT_HEADERS = [
    'Call Date', 'Call Time', 'Customer Name', 'Contact Person', 'Phone Number',
    'Assigned Employee', 'Direction', 'Call Duration', 'Duration (secs)',
    'Call Outcome', 'Funnel Bucket', 'Lead ID', 'Recording',
  ];
  const exportRows = () => filteredRecords.map((c) => {
    const o = outcomeOf(c.outcome);
    const start = new Date(c.startTime);
    return [
      formatDate(start),
      formatTime(start),
      c.lead?.businessName ?? '',
      c.lead?.contactName ?? '',
      c.lead?.phone ?? '',
      c.caller?.name ?? '',
      // Matches the column: a processed row reports how it was worked rather
      // than a direction it never had.
      c.kind === 'processed' ? 'No call' : c.direction ? (c.direction === 'inbound' ? 'Incoming' : 'Outgoing') : '',
      c.durationSecs != null ? formatDuration(c.durationSecs) : '',
      c.durationSecs ?? '',
      o?.name ?? c.outcome ?? '',
      o?.category ? CAT[o.category].label : '',
      c.lead?.leadId ?? '',
      c.hasRecording ? 'Yes' : 'No',
    ];
  });

  return (
    <div>
      {/* Call summary tiles — as many per row as genuinely fit.
          This was a fixed `xl:grid-cols-8`, which assumed a 1280px VIEWPORT meant
          1280px of room. It doesn't: the sidebar takes 248px, so a 1366px laptop
          left each of eight tiles about 130px — too narrow for "Total Calls Made"
          and a figure — and the three lead-processing tiles added later spilled
          into a ragged second row. `auto-fit` measures the container instead, so
          the row reflows to the space actually available, on any laptop, and
          whether the sidebar is expanded or railed. */}
      <div className="mb-4 grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
        <KpiCard icon={Phone} iconBg="#e6effb" iconColor="#2c5d8f" value={(stats?.total ?? 0).toLocaleString()} label="Total Calls Made" />
        <KpiCard icon={PhoneOutgoing} iconBg="#e7eed8" iconColor="#42512f" value={(stats?.outgoing ?? 0).toLocaleString()} label="Outgoing Calls" />
        <KpiCard icon={PhoneIncoming} iconBg="#e3f1ee" iconColor="#2f6f63" value={(stats?.incoming ?? 0).toLocaleString()} label="Incoming Calls" />
        <KpiCard icon={CheckCircle2} iconBg="#e8f2e4" iconColor="#3f7a32" value={(stats?.connected ?? 0).toLocaleString()} label={`Connected · ${stats?.connectedPct ?? 0}%`} />
        {/* "Unanswered", not "Missed Calls": this is a volume breakdown of the
            log and counts BOTH directions, so most of it is outbound calls the
            customer didn't pick up. The Missed Calls tab next door means
            something narrower — inbound calls the user missed — and two tiles a
            click apart must not use one label for two different numbers. */}
        <KpiCard icon={PhoneMissed} iconBg="#fdecdc" iconColor="#c98a18" value={(stats?.missed ?? 0).toLocaleString()} label="Unanswered" />
        <KpiCard icon={PhoneOff} iconBg="#fde9e6" iconColor="#a8431f" value={(stats?.failed ?? 0).toLocaleString()} label="Failed Calls" />
        <KpiCard icon={Clock} iconBg="#fdf1de" iconColor="#c98a18" value={formatDuration(stats?.totalDurationSecs ?? 0)} label="Call Duration" />
        <KpiCard icon={Timer} iconBg="#f2f2ec" iconColor="#75766a" value={formatDuration(stats?.avgDurationSecs ?? 0)} label="Avg Call" />
        {/* Leads worked with no call placed. Its own tile rather than part of
            Total Calls Made — the work is real and belongs in the log, but it
            wasn't dialled, and rolling it into call volume would overstate it. */}
        {(stats?.processed ?? 0) > 0 && (
          <>
            <KpiCard icon={ClipboardCheck} iconBg="#f2f2ec" iconColor="#75766a" value={(stats?.processed ?? 0).toLocaleString()} label="Processed · no call" />
            {/* Handling time, kept apart from talk time for the same reason the
                counts are: it is time spent working the lead, not on the phone. */}
            <KpiCard icon={Hourglass} iconBg="#f2f2ec" iconColor="#75766a" value={formatDuration(stats?.processingSecs ?? 0)} label="Processing Time" />
            <KpiCard icon={Timer} iconBg="#f2f2ec" iconColor="#75766a" value={formatDuration(stats?.avgProcessingSecs ?? 0)} label="Avg per Lead" />
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
        <div className="mb-[14px] flex items-start gap-2.5 rounded-xl border border-[#e8dcc0] bg-[#fbf6e9] px-4 py-3 text-[12px] text-[#7a5d17]">
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

      {/* Call Details filters — same geography/status/date bar as Lead Management,
          and one row from `lg` up for the same reason; see the note there. */}
      <div className="mb-[14px] flex flex-wrap items-center gap-2.5 lg:flex-nowrap">
        {isManager && <FilterSelect className="min-w-0 flex-1" icon={UserIcon} value={userId} onChange={setUserId} options={userOpts} />}
        <FilterSelect className="min-w-0 flex-1" icon={Clock} value={tz} onChange={(v) => { setTz(v); setState(''); setCity(''); }} options={TIMEZONE_FILTER_OPTIONS_COMPACT} />
        <FilterSelect className="min-w-0 flex-1" icon={MapPin} value={state} onChange={(v) => { setState(v); setCity(''); }} options={stateOpts} />
        <FilterSelect className="min-w-0 flex-1" icon={Building2} value={city} onChange={setCity} options={cityOpts} />
        <FilterSelect className="min-w-0 flex-1" icon={Tag} value={leadStatus} onChange={setLeadStatus} options={LEAD_STATUS_OPTS} />
        <FilterSelect className="min-w-0 flex-1" icon={PhoneCall} value={outcomeFilter} onChange={setOutcomeFilter} options={outcomeOpts} />
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
              className="inline-flex items-center gap-[7px] rounded-md border bg-card px-3 py-2 text-[12.5px] font-medium hover:bg-muted disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5 text-muted-foreground" /> Export CSV
            </button>
            <button
              onClick={() => downloadXlsx(exportName, EXPORT_HEADERS, exportRows())}
              disabled={filteredRecords.length === 0}
              className="inline-flex items-center gap-[7px] rounded-md border bg-card px-3 py-2 text-[12.5px] font-medium hover:bg-muted disabled:opacity-50"
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

