'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { productivityApi, type DailySummaryRow } from '@/lib/crm';
import { DataTable, type ColumnDef } from '@/components/data-table';

function toCsv(rows: DailySummaryRow[]): string {
  const header = 'Caller,Calls Made,Connected,Callbacks,Deals';
  const body = rows.map((r) => [r.name, r.callsMade, r.connected, r.callbacks, r.deals].join(','));
  return [header, ...body].join('\n');
}

export default function CallSummaryPage() {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['daily-summary'],
    queryFn: productivityApi.dailySummary,
  });

  function exportCsv() {
    const blob = new Blob([toCsv(rows)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `daily-call-summary-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const sum = (key: keyof Pick<DailySummaryRow, 'callsMade' | 'connected' | 'callbacks' | 'deals'>) =>
    rows.reduce((a, r) => a + r[key], 0);

  const columns = useMemo<ColumnDef<DailySummaryRow>[]>(() => [
    { key: 'caller', header: 'Caller', required: true, cellClassName: 'font-medium', render: (r) => r.name, footer: () => 'Total' },
    { key: 'callsMade', header: 'Calls Made', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (r) => r.callsMade, footer: () => sum('callsMade') },
    { key: 'connected', header: 'Connected', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (r) => r.connected, footer: () => sum('connected') },
    { key: 'callbacks', header: 'Callbacks', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (r) => r.callbacks, footer: () => sum('callbacks') },
    { key: 'deals', header: 'Deals', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (r) => r.deals, footer: () => sum('deals') },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [rows]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          End-of-day report — calls, connected, callbacks, deals per caller (CAL-023)
        </p>
        <button
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          <Upload className="h-4 w-4" /> Export CSV
        </button>
      </div>

      <DataTable
        tableKey="call-summary"
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.id}
        title="Daily Call Summary"
        subtitle={`${rows.length} callers`}
        loading={isLoading}
        emptyText="No summary data yet."
      />
    </div>
  );
}
