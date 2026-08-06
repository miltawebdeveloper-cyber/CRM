'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Phone, Clock, Percent, Star } from 'lucide-react';
import { productivityApi, formatDuration, type Period, type CallerProductivity } from '@/lib/crm';
import { PageHead, Avatar } from '@/components/page-head';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { Segmented } from '@/components/segmented';
import { DataTable, type ColumnDef } from '@/components/data-table';

const PERIODS = [
  { label: 'Day', value: 'day' as Period },
  { label: 'Week', value: 'week' as Period },
  { label: 'Month', value: 'month' as Period },
];
const PERIOD_LABEL: Record<Period, string> = { day: 'today', week: 'this week', month: 'this month' };

export default function ProductivityPage() {
  const [period, setPeriod] = useState<Period>('week');
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
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--brand-tint)]">
            <span className="block h-full rounded-full" style={{ width: `${(r.conversionPct / maxConv) * 100}%`, background: 'linear-gradient(90deg,var(--brand-mid),var(--brand-lime-deep))' }} />
          </div>
        </div>
      ),
    },
  ], [maxConv]);

  return (
    <div>
      <PageHead>
        <Segmented options={PERIODS} value={period} onChange={setPeriod} />
      </PageHead>

      <div className={`mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))] transition-opacity ${isFetching ? 'opacity-60' : ''}`}>
        <KpiCard icon={Phone} iconBg="var(--brand-tint)" iconColor="var(--brand)" value={totalCalls} label={`Total Calls (${PERIOD_LABEL[period]})`} />
        <KpiCard icon={Clock} iconBg="#e3f1ee" iconColor="#2f6f63" value={formatDuration(totalTalk)} label="Total Talk Time" />
        <KpiCard icon={Percent} iconBg="#fdf1de" iconColor="#c98a18" value={totalCalls ? formatDuration(Math.round(totalTalk / totalCalls)) : '0s'} label="Avg Call Time" />
        <KpiCard icon={Star} iconBg="var(--brand-tint-2)" iconColor="var(--brand-strong)" value={best?.name?.split(' ')[0] ?? '—'} label="Best Performer" />
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
