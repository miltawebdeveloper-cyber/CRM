'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Phone, Users, NotebookPen, CheckCircle2, Download } from 'lucide-react';
import { activitiesApi, type Activity } from '@/lib/crm';
import { PageHead, Avatar } from '@/components/page-head';
import { StatusPill } from '@/components/status-pill';
import { DateFilter, SearchInput } from '@/components/filter-controls';
import { DataTable, type ColumnDef } from '@/components/data-table';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { downloadCsv } from '@/lib/export';
import { inDateBounds, EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';

export default function ActivityPage() {
  const { data: allActivities = [] } = useQuery({ queryKey: ['activities'], queryFn: activitiesApi.list, retry: false });
  const [dateRange, setDateRange] = useState<DateFilterValue>(EMPTY_DATE_FILTER);
  const [q, setQ] = useState('');

  const term = q.trim().toLowerCase();
  const activities = allActivities.filter(
    (a) =>
      inDateBounds(a.createdAt, dateRange) &&
      (!term ||
        (a.lead?.businessName ?? '').toLowerCase().includes(term) ||
        (a.user?.name ?? '').toLowerCase().includes(term) ||
        a.action.toLowerCase().includes(term) ||
        (a.newValue ?? '').toLowerCase().includes(term)),
  );
  const calls = activities.filter((a) => a.action === 'call_completed');
  const positive = calls.filter((a) => a.newValue === 'closed_deal' || a.newValue === 'interested').length;

  // Distinct leads represented in the filtered activities.
  const leadsTouched = new Set(activities.map((a) => a.lead?.id).filter(Boolean)).size;

  // Every figure here is derived from `activities`, so all four move with the
  // search and date filters. This row previously carried a hardcoded "5h 10m"
  // Talk Time that never changed with the data — the activity feed carries no
  // call duration to compute it from, so it's been replaced with a count this
  // page can actually stand behind.
  const KPIS = [
    { icon: Phone, bg: '#d8eed9', color: '#266929', val: calls.length, lab: 'Calls Logged' },
    { icon: Users, bg: '#e3f1ee', color: '#2f6f63', val: leadsTouched, lab: 'Leads Touched' },
    { icon: NotebookPen, bg: '#fbf3e2', color: '#c98a18', val: activities.length, lab: 'Activities' },
    { icon: CheckCircle2, bg: '#e4f2e4', color: '#317d34', val: positive, lab: 'Positive Outcomes' },
  ];

  const columns = useMemo<ColumnDef<Activity>[]>(() => [
    { key: 'time', header: 'Time', cellClassName: 'font-mono text-[12px] text-muted-foreground', render: (a) => new Date(a.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
    { key: 'lead', header: 'Lead', required: true, render: (a) => <div className="flex items-center gap-[10px]"><Avatar name={a.lead?.businessName ?? '—'} /><span className="font-semibold">{a.lead?.businessName ?? '—'}</span></div> },
    { key: 'by', header: 'By', cellClassName: 'text-muted-foreground', render: (a) => a.user?.name ?? '—' },
    { key: 'action', header: 'Action', render: (a) => <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{a.action}</span> },
    { key: 'outcome', header: 'Outcome', render: (a) => (a.newValue ? <StatusPill status={a.newValue} /> : '—') },
  ], []);

  return (
    <div>
      <PageHead>
        <SearchInput value={q} onChange={setQ} placeholder="Search lead, user, outcome…" className="min-w-[220px]" />
        <DateFilter value={dateRange} onChange={setDateRange} />
        <button
          onClick={() => downloadCsv('activity-log', ['Time', 'Lead', 'By', 'Action', 'Outcome'], activities.map((a) => [new Date(a.createdAt).toLocaleString(), a.lead?.businessName ?? '', a.user?.name ?? '', a.action, a.newValue ?? '']))}
          disabled={activities.length === 0}
          className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[13px] font-semibold hover:bg-muted disabled:opacity-50"
        ><Download className="h-4 w-4" /> Export</button>
      </PageHead>

      {/* Summary cards come from the shared KpiCard, like every other module. This
          page used to hand-roll the same markup, which meant it silently missed the
          hover lift and entrance animation and would drift further with each tweak
          to the real card. */}
      <div className="mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        {KPIS.map((k, i) => (
          <KpiCard key={k.lab} index={i} icon={k.icon} iconBg={k.bg} iconColor={k.color} value={k.val} label={k.lab} />
        ))}
      </div>

      <DataTable
        tableKey="activity"
        columns={columns}
        rows={activities}
        getRowKey={(a) => a.id}
        title="Call Activity Log"
        subtitle={`${activities.length} shown`}
        emptyText={allActivities.length === 0 ? 'No activity yet — complete a call to log activity.' : 'No activity matches the current filters.'}
        selectionMode="row"
      />
    </div>
  );
}
