'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Plus, Pencil } from 'lucide-react';
import { productivityApi, type CallerProductivity } from '@/lib/crm';
import { PageHead, Avatar } from '@/components/page-head';
import { DataTable, type ColumnDef } from '@/components/data-table';

export default function AssignedPage() {
  const router = useRouter();
  const { data: callers = [] } = useQuery({ queryKey: ['productivity'], queryFn: () => productivityApi.perCaller() });

  const columns = useMemo<ColumnDef<CallerProductivity>[]>(() => [
    { key: 'caller', header: 'Caller', required: true, render: (c) => <div className="flex items-center gap-[10px]"><Avatar name={c.name} size="md" /><span className="font-semibold">{c.name}</span></div> },
    { key: 'assigned', header: 'Assigned', headerClassName: 'text-right', cellClassName: 'text-right font-semibold tabular-nums', render: (c) => c.assigned },
    { key: 'completed', header: 'Completed', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums text-primary', render: (c) => c.leadsCompleted },
    { key: 'pending', header: 'Pending', headerClassName: 'text-right', cellClassName: 'text-right tabular-nums', render: (c) => c.assigned - c.leadsCompleted },
    {
      key: 'distribution', header: 'Distribution', cellClassName: 'min-w-[130px]',
      render: (c) => { const pct = c.assigned ? Math.round((c.leadsCompleted / c.assigned) * 100) : 0; return <div className="h-2 overflow-hidden rounded-full bg-[#d8eed9]"><span className="block h-full rounded-full" style={{ width: `${pct}%`, background: 'linear-gradient(90deg,#2b732f,#7e9933)' }} /></div>; },
    },
    { key: 'actions', header: '', required: true, render: () => <button onClick={() => router.push('/assignments')} className="grid h-[30px] w-[30px] place-items-center rounded-lg border hover:bg-primary hover:text-primary-foreground"><Pencil className="h-[15px] w-[15px]" /></button> },
  ], [router]);

  return (
    <div>
      <PageHead>
        <button onClick={() => router.push('/assignments')} className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[13px] font-semibold hover:bg-muted"><RefreshCw className="h-4 w-4" /> Auto-distribute</button>
        <button onClick={() => router.push('/assignments')} className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[13px] font-semibold text-primary-foreground hover:opacity-90"><Plus className="h-4 w-4" /> Assign calls</button>
      </PageHead>

      <div className="mb-[18px] grid gap-[18px] md:grid-cols-2 xl:grid-cols-3">
        {callers.slice(0, 3).map((c) => {
          const pct = c.assigned ? Math.round((c.leadsCompleted / c.assigned) * 100) : 0;
          return (
            <div key={c.id} className="rounded-2xl border bg-card p-[18px] shadow-sm">
              <div className="mb-[14px] flex items-center gap-3">
                <Avatar name={c.name} size="md" />
                <div className="min-w-0 flex-1"><div className="truncate font-bold">{c.name}</div><div className="text-[12px] text-muted-foreground">Caller</div></div>
                <span className="rounded-full bg-[#d8eed9] px-2.5 py-[3px] text-[11.5px] font-semibold text-[#266929]">{c.assigned} leads</span>
              </div>
              <div className="mb-1.5 flex justify-between text-[12px]"><span className="text-muted-foreground">Progress</span><b>{pct}%</b></div>
              <div className="h-2 overflow-hidden rounded-full bg-[#d8eed9]"><span className="block h-full rounded-full" style={{ width: `${pct}%`, background: 'linear-gradient(90deg,#2b732f,#7e9933)' }} /></div>
              <div className="mt-3 flex justify-between text-[12.5px] text-muted-foreground"><span>{c.leadsCompleted} done</span><span>{c.assigned - c.leadsCompleted} left</span></div>
            </div>
          );
        })}
      </div>

      <DataTable
        tableKey="assigned"
        columns={columns}
        rows={callers}
        getRowKey={(c) => c.id}
        title="Assignment Detail"
        subtitle={`${callers.length} callers`}
        emptyText="Loading…"
      />
    </div>
  );
}
