'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { activitiesApi, type Activity } from '@/lib/crm';
import { DataTable, type ColumnDef } from '@/components/data-table';
import { useState } from 'react';
import { DateFilter, FilterSelect } from '@/components/filter-controls';
import { Filter } from 'lucide-react';
import { inDateBounds, EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';
import { formatDateTime } from '@/lib/display-settings';

export default function SecurityPage() {
  const { data: activities = [], isLoading, isError } = useQuery({
    queryKey: ['activities'],
    queryFn: activitiesApi.list,
    retry: false,
  });
  const [dateRange, setDateRange] = useState<DateFilterValue>(EMPTY_DATE_FILTER);
  const [action, setAction] = useState('');
  const actions = Array.from(new Set(activities.map((a) => a.action))).sort();
  const filtered = activities.filter((a) => (!action || a.action === action) && inDateBounds(a.createdAt, dateRange));

  const columns = useMemo<ColumnDef<Activity>[]>(() => [
    { key: 'when', header: 'When', required: true, cellClassName: 'text-muted-foreground', render: (a) => formatDateTime(a.createdAt) },
    { key: 'user', header: 'User', render: (a) => a.user?.name ?? '—' },
    { key: 'action', header: 'Action', render: (a) => <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{a.action}</span> },
    { key: 'lead', header: 'Lead', render: (a) => a.lead?.businessName ?? '—' },
    { key: 'detail', header: 'Detail', cellClassName: 'text-muted-foreground', render: (a) => `${a.oldValue ? `${a.oldValue} → ` : ''}${a.newValue ?? ''}` },
  ], []);

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Audit / activity log — every status change and call is recorded (SEC-004)
      </p>
      <div className="flex flex-wrap items-center gap-2.5">
        <FilterSelect icon={Filter} value={action} onChange={setAction} options={[{ label: 'All Actions', value: '' }, ...actions.map((a) => ({ label: a.replace('_', ' '), value: a }))]} />
        <DateFilter value={dateRange} onChange={setDateRange} />
      </div>

      <DataTable
        tableKey="security-audit"
        columns={columns}
        rows={isError ? [] : filtered}
        getRowKey={(a) => a.id}
        title="Audit Log"
        subtitle={`${filtered.length} entries`}
        loading={isLoading}
        emptyText={isError ? 'Could not load activity log (admin or team-leader role required).' : 'No activity recorded yet — complete a call to generate audit entries.'}
      />
    </div>
  );
}
