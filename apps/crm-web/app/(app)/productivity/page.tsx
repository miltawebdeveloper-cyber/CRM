'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Phone, Clock, Percent, Star } from 'lucide-react';
import { productivityApi, formatDuration, type Period, type CallerProductivity } from '@/lib/crm';
import { Avatar, PageHead } from '@/components/page-head';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { DataTable, type ColumnDef } from '@/components/data-table';
import { DateFilter } from '@/components/filter-controls';
import type { DateFilterValue } from '@/lib/date-filters';

const PERIOD_LABEL: Record<Period, string> = { day: 'today', week: 'this week', month: 'this month' };

// The picker (same one Lead Management uses) also offers Year and a custom
// range — this API only buckets by day/week/month, so those two collapse to
// month, the broadest bucket it has.
const toPeriod = (mode: DateFilterValue['mode']): Period =>
  mode === 'day' || mode === 'week' || mode === 'month' ? mode : 'month';

export default function ProductivityPage() {
  const [dateFilter, setDateFilter] = useState<DateFilterValue>({ mode: 'week', from: '', to: '' });
  const period = toPeriod(dateFilter.mode);
  const { data: rows = [], isFetching } = useQuery({ queryKey: ['productivity', period], queryFn: () => productivityApi.perCaller(period) });

  const totalCalls = rows.reduce((a, r) => a + r.callsToday, 0);
  const totalTalk = rows.reduce((a, r) => a + r.productiveSecs, 0);
  const best = [...rows].sort((a, b) => b.callsToday - a.callsToday)[0];
  const maxConv = Math.max(1, ...rows.map((r) => r.conversionPct));

  const columns = useMemo<ColumnDef<CallerProductivity>[]>(() => [
    { key: 'caller', header: 'Caller', required: true, render: (r) => <div className="flex items-center gap-[10px]"><Avatar name={r.name} /><div className="font-semibold">{r.name}</div></div> },
    { key: 'assigned', header: 'Assigned', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (r) => r.assigned },
    { key: 'completed', header: 'Completed', headerClassName: 'text-right', cellClassName: 'text-right font-semibold tabular-nums', render: (r) => r.leadsCompleted },
    { key: 'talk', header: 'Talk Time', headerClassName: 'text-right', cellClassName: 'text-right font-mono', render: (r) => formatDuration(r.productiveSecs) },
    { key: 'conversion', header: 'Conversion', headerClassName: 'text-right', cellClassName: 'text-right font-bold tabular-nums text-primary', render: (r) => `${r.conversionPct}%` },
    {
      key: 'output', header: 'Output', cellClassName: 'min-w-[160px]',
      render: (r) => (
        <div className="flex items-center gap-[9px]">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--brand-surface)]">
            <span className="block h-full rounded-full" style={{ width: `${(r.conversionPct / maxConv) * 100}%`, background: 'linear-gradient(90deg,var(--brand-mid),var(--brand-lime-deep))' }} />
          </div>
        </div>
      ),
    },
  ], [maxConv]);

  return (
    <div>
      <PageHead>
        <DateFilter value={dateFilter} onChange={setDateFilter} iconOnly />
      </PageHead>

      <div className={`mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))] transition-opacity ${isFetching ? 'opacity-60' : ''}`}>
        <KpiCard icon={Phone} iconBg="var(--brand-surface)" iconColor="var(--brand-on-surface)" value={totalCalls} label={`Total Calls (${PERIOD_LABEL[period]})`} />
        <KpiCard icon={Clock} iconBg="var(--tone-teal-bg)" iconColor="var(--tone-teal-fg)" value={formatDuration(totalTalk)} label="Total Talk Time" />
        <KpiCard icon={Percent} iconBg="var(--tone-amber-bg)" iconColor="var(--tone-amber-fg)" value={totalCalls ? formatDuration(Math.round(totalTalk / totalCalls)) : '0s'} label="Avg Call Time" />
        <KpiCard icon={Star} iconBg="var(--brand-surface-2)" iconColor="var(--brand-on-surface)" value={best?.name?.split(' ')[0] ?? '—'} label="Best Performer" />
      </div>

      <DataTable
        tableKey="productivity"
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.id}
        title="Caller Productivity"
        subtitle="Talk time, conversion, output"
        loading={isFetching && rows.length === 0}
        emptyText="No productivity data."
      />
    </div>
  );
}
