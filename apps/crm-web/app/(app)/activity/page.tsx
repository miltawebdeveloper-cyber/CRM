'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Phone, Users, NotebookPen, CheckCircle2, Upload } from 'lucide-react';
import { activitiesApi, type Activity } from '@/lib/crm';
import { PageHead, Avatar } from '@/components/page-head';
import { OutcomePill } from '@/components/outcome-pill';
import { useOutcomeLabels } from '@/lib/use-outcome-label';
import { DateFilter, SearchInput } from '@/components/filter-controls';
import { DataTable, type ColumnDef } from '@/components/data-table';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { downloadCsv } from '@/lib/export';
import { inDateBounds, EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';
import { formatDateTime, formatTime } from '@/lib/display-settings';

export default function ActivityPage() {
  const { data: allActivities = [] } = useQuery({ queryKey: ['activities'], queryFn: activitiesApi.list, retry: false });
  const { outcome, label: outcomeLabel } = useOutcomeLabels();
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
    { icon: Phone, bg: 'var(--brand-surface)', color: 'var(--brand-on-surface)', val: calls.length, lab: 'Calls Logged' },
    { icon: Users, bg: 'var(--tone-teal-bg)', color: 'var(--tone-teal-fg)', val: leadsTouched, lab: 'Leads Touched' },
    { icon: NotebookPen, bg: 'var(--tone-amber-bg)', color: 'var(--tone-amber-fg)', val: activities.length, lab: 'Activities' },
    { icon: CheckCircle2, bg: 'var(--brand-surface-2)', color: 'var(--brand-on-surface)', val: positive, lab: 'Positive Outcomes' },
  ];

  const columns = useMemo<ColumnDef<Activity>[]>(() => [
    { key: 'time', header: 'Time', cellClassName: 'font-mono text-[11.5px] text-muted-foreground', render: (a) => formatTime(a.createdAt) },
    { key: 'lead', header: 'Lead', required: true, render: (a) => <div className="flex items-center gap-[10px]"><Avatar name={a.lead?.businessName ?? '—'} /><span className="font-semibold">{a.lead?.businessName ?? '—'}</span></div> },
    { key: 'by', header: 'By', cellClassName: 'text-muted-foreground', render: (a) => a.user?.name ?? '—' },
    { key: 'action', header: 'Action', render: (a) => <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10.5px]">{a.action}</span> },
    // The configured outcome name, not the stored slug. This used to be a
    // StatusPill fed the raw value, and StatusPill replaces only the FIRST
    // underscore before CSS capitalises it — so `dm_not_interested` reached the
    // screen as "Dm Not_interested" rather than "Dm-Not Interested".
    {
      key: 'outcome', header: 'Outcome',
      render: (a) => (a.newValue ? <OutcomePill name={outcomeLabel(a.newValue)} color={outcome(a.newValue)?.color} /> : '—'),
    },
  ], [outcomeLabel, outcome]);

  return (
    <div>
      <PageHead>
        <SearchInput value={q} onChange={setQ} placeholder="Search lead, user, outcome…" className="min-w-[220px]" />
        <DateFilter value={dateRange} onChange={setDateRange} iconOnly />
        <button
          onClick={() =>
            downloadCsv(
              'activity-log',
              ['Time', 'Lead', 'By', 'Action', 'Outcome'],
              // Outcome resolved the same way the column resolves it, so the
              // export can't print a slug the screen never showed.
              activities.map((a) => [formatDateTime(a.createdAt), a.lead?.businessName ?? '', a.user?.name ?? '', a.action, outcomeLabel(a.newValue)]),
            )
          }
          disabled={activities.length === 0}
          className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[12.5px] font-semibold hover:bg-muted disabled:opacity-50"
        ><Upload className="h-4 w-4" /> Export</button>
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
