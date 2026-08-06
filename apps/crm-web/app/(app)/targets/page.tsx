'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Flag, MapPin, Building2 } from 'lucide-react';
import { targetsApi, type Target } from '@/lib/crm';
import { PageHead } from '@/components/page-head';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { DataTable, type ColumnDef } from '@/components/data-table';

export default function TargetsPage() {
  const { data: targets = [], isLoading } = useQuery({ queryKey: ['targets'], queryFn: targetsApi.list });

  const columns = useMemo<ColumnDef<Target>[]>(() => [
    { key: 'timezone', header: 'Timezone', required: true, render: (t) => <span className="rounded-full bg-[var(--brand-surface)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--brand-on-surface)]">{t.timezone}</span> },
    { key: 'state', header: 'State', render: (t) => t.state },
    { key: 'city', header: 'City', cellClassName: 'font-semibold', render: (t) => t.city },
    { key: 'target', header: 'Monthly Target', headerClassName: 'text-right', cellClassName: 'text-right font-mono tabular-nums', render: (t) => t.monthlyTarget.toLocaleString(), footer: (rows) => rows.reduce((a, t) => a + t.monthlyTarget, 0).toLocaleString() },
  ], []);
  const totalTarget = targets.reduce((a, t) => a + t.monthlyTarget, 0);
  const cities = new Set(targets.map((t) => `${t.state}/${t.city}`)).size;
  const states = new Set(targets.map((t) => t.state)).size;

  return (
    <div>

      <div className="mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        <KpiCard icon={Flag} iconBg="var(--brand-surface)" iconColor="var(--brand-on-surface)" value={totalTarget.toLocaleString()} label="Total Planned Leads" />
        <KpiCard icon={Building2} iconBg="var(--tone-blue-bg)" iconColor="var(--tone-blue-fg)" value={cities} label="Cities with Targets" />
        <KpiCard icon={MapPin} iconBg="var(--tone-amber-bg)" iconColor="var(--tone-amber-fg)" value={states} label="States Covered" />
      </div>

      <DataTable
        tableKey="targets"
        columns={columns}
        rows={targets}
        getRowKey={(t) => t.id}
        title="City Targets"
        subtitle={`${targets.length} configured`}
        loading={isLoading}
        emptyText="No targets configured."
      />
    </div>
  );
}
