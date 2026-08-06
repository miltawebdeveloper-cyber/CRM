'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { PhoneMissed, PhoneIncoming, Clock } from 'lucide-react';
import { communicationsApi, type MissedCall } from '@/lib/crm';
import { DataTable, useColumnPrefs, type ColumnDef } from '@/components/data-table';
import { Avatar } from '@/components/page-head';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { SearchInput } from '@/components/filter-controls';
import { formatInLeadZone } from '@/lib/timezone';
import { formatDate, formatDateTime, formatTime } from '@/lib/display-settings';

/** Kept in step with the user's call history without needing a manual reload. */
const POLL_MS = 30_000;

/** Whether a missed call landed today, on the viewer's calendar. */
const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();

/**
 * Missed Calls — inbound calls that were never picked up.
 *
 * Scoped by the API: an employee sees only calls routed to them, a manager sees
 * the team's. It reads the same Call rows as the rest of the call history, so it
 * cannot drift from Call Recordings or the lead's own timeline — a missed call is
 * simply one with no answer, not a separate kind of record.
 *
 * Deliberately read-only. Returning the call is a dialling action, and dialling
 * is switched off while the CRM is in lead-processing mode; the row links to the
 * lead instead, which is where the work actually gets picked up.
 */
export function MissedCalls() {
  const [q, setQ] = useState('');
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['missed-calls', 'panel'],
    queryFn: () => communicationsApi.missedCalls(200),
    refetchInterval: POLL_MS,
    retry: false,
  });

  const term = q.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          !term ||
          r.businessName.toLowerCase().includes(term) ||
          (r.contactName ?? '').toLowerCase().includes(term) ||
          r.phone.toLowerCase().includes(term) ||
          (r.assignedTo ?? '').toLowerCase().includes(term),
      ),
    [rows, term],
  );

  const todayCount = useMemo(() => rows.filter((r) => isToday(r.at)).length, [rows]);

  const columns = useMemo<ColumnDef<MissedCall>[]>(
    () => [
      {
        key: 'at',
        header: 'Date & Time',
        required: true,
        searchable: true,
        searchValue: (r) => formatDateTime(r.at),
        render: (r) => (
          <div>
            <div className="font-medium">{formatDate(r.at)}</div>
            <div className="text-[11px] text-muted-foreground">
              {formatTime(r.at)}
            </div>
          </div>
        ),
      },
      {
        key: 'caller',
        header: 'Caller Name',
        required: true,
        searchable: true,
        searchValue: (r) => r.contactName ?? r.businessName,
        // The person who rang, with the company beneath. Falls back to the company
        // alone when the lead names no contact — an unknown caller is shown as the
        // business rather than as a blank cell.
        render: (r) => (
          <div className="flex items-center gap-[10px]">
            <Avatar name={r.contactName || r.businessName} />
            <div className="min-w-0">
              <div className="truncate font-medium">{r.contactName || r.businessName}</div>
              {r.contactName && <div className="truncate text-[11px] text-muted-foreground">{r.businessName}</div>}
            </div>
          </div>
        ),
      },
      {
        key: 'phone',
        header: 'Phone Number',
        cellClassName: 'font-mono text-[11.5px] text-muted-foreground',
        searchable: true,
        searchValue: (r) => r.phone,
        render: (r) => r.phone,
      },
      {
        key: 'assignedTo',
        header: 'Assigned User',
        searchable: true,
        trackable: true,
        searchValue: (r) => r.assignedTo ?? '',
        render: (r) => r.assignedTo ?? '—',
      },
      {
        key: 'lead',
        header: 'Lead',
        searchable: true,
        searchValue: (r) => r.leadRef,
        // Links through to the record, which is where a missed call is actually
        // acted on — there is no call-back button, because dialling is off.
        render: (r) => (
          <Link href={`/leads/${r.leadId}`} className="font-mono text-[11px] font-medium text-primary hover:underline">
            {r.leadRef}
          </Link>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        render: (r) => (
          <span className="inline-flex items-center gap-1 rounded-full bg-[#fde9e6] px-2 py-[3px] text-[10.5px] font-semibold capitalize text-[#a8431f]">
            <PhoneMissed className="h-3 w-3" />
            {r.status.replace(/[-_]/g, ' ')}
          </span>
        ),
      },
      {
        key: 'location',
        header: 'Location',
        cellClassName: 'text-muted-foreground',
        render: (r) => [r.city, r.state].filter(Boolean).join(', ') || '—',
      },
    ],
    [],
  );

  const prefs = useColumnPrefs('missed-calls', columns);

  return (
    <div>
      <div className="mb-[18px] grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        <KpiCard icon={PhoneMissed} iconBg="#fde9e6" iconColor="#a8431f" value={rows.length.toLocaleString()} label="Missed Calls" />
        <KpiCard icon={Clock} iconBg="#fdf1de" iconColor="#c98a18" value={todayCount.toLocaleString()} label="Missed Today" />
        <KpiCard
          icon={PhoneIncoming}
          iconBg="#e3f1ee"
          iconColor="#2f6f63"
          value={rows[0] ? formatInLeadZone(rows[0].at, undefined) : '—'}
          label="Most Recent"
        />
      </div>

      <div className="mb-[14px] flex flex-wrap items-center gap-2.5">
        <SearchInput value={q} onChange={setQ} placeholder="Search caller, phone, employee…" className="min-w-[240px]" />
      </div>

      <DataTable
        tableKey="missed-calls"
        columns={columns}
        rows={filtered}
        getRowKey={(r) => r.id}
        title="Missed Calls"
        subtitle={`${filtered.length.toLocaleString()} missed call${filtered.length === 1 ? '' : 's'}`}
        loading={isLoading}
        emptyText="No missed calls. Inbound calls that go unanswered appear here."
        prefs={prefs}
        selectable={false}
        fillViewport
      />
    </div>
  );
}
