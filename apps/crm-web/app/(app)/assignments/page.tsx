'use client';

import { useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shuffle, Users } from 'lucide-react';
import { assignmentsApi, type AssignmentSummary } from '@/lib/crm';
import { PageHead, Avatar } from '@/components/page-head';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { DataTable, type ColumnDef } from '@/components/data-table';

type Strategy = 'equal' | 'state' | 'timezone';
type Caller = AssignmentSummary['callers'][number];

export default function AssignmentsPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [strategy, setStrategy] = useState<Strategy>('equal');

  const { data } = useQuery({ queryKey: ['assignments-summary'], queryFn: assignmentsApi.summary });
  const auto = useMutation({
    mutationFn: () => assignmentsApi.auto({ callerIds: [...selected], strategy }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['assignments-summary'] });
      // Auto-distribution changes who owns what, so the lead lists and the
      // Calling Panel's queue and cards are stale the moment it succeeds.
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['caller-leads'] });
      qc.invalidateQueries({ queryKey: ['caller-dash'] });
    },
  });

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const totalAssigned = data?.callers.reduce((a, c) => a + c.leadCount, 0) ?? 0;

  // Ref keeps the checkbox cell reading the latest selection without churning
  // the column defs (which would otherwise reset prefs on every toggle).
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const columns = useMemo<ColumnDef<Caller>[]>(() => [
    { key: 'check', header: '', required: true, headerClassName: 'w-10', render: (c) => <input type="checkbox" checked={selectedRef.current.has(c.id)} readOnly className="pointer-events-none accent-[var(--brand)]" /> },
    { key: 'caller', header: 'Caller', required: true, render: (c) => <div className="flex items-center gap-[10px]"><Avatar name={c.name} /><span className="font-semibold">{c.name}</span></div> },
    { key: 'email', header: 'Email', cellClassName: 'text-muted-foreground', render: (c) => c.email },
    { key: 'leads', header: 'Assigned Leads', headerClassName: 'text-right', cellClassName: 'text-right font-mono tabular-nums', render: (c) => c.leadCount },
  ], []);

  return (
    <div>
      <PageHead>
        <div className="flex items-center gap-[7px] rounded-md border bg-card px-3 py-2 text-[12.5px] font-medium">
          <Shuffle className="h-3.5 w-3.5 text-muted-foreground" />
          <select value={strategy} onChange={(e) => setStrategy(e.target.value as Strategy)} className="border-none bg-transparent font-medium outline-none">
            <option value="equal">Equal count</option>
            <option value="state">By state</option>
            <option value="timezone">By timezone</option>
          </select>
        </div>
        <button disabled={selected.size === 0 || (data?.unassigned ?? 0) === 0 || auto.isPending} onClick={() => auto.mutate()} className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[12.5px] font-semibold text-primary-foreground disabled:opacity-50">
          {auto.isPending ? 'Distributing…' : `Distribute to ${selected.size}`}
        </button>
      </PageHead>

      <div className="mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        <KpiCard icon={Users} iconBg="var(--tone-amber-bg)" iconColor="var(--tone-amber-fg)" value={data?.unassigned ?? 0} label="Unassigned Leads" />
        <KpiCard icon={Shuffle} iconBg="var(--brand-surface)" iconColor="var(--brand-on-surface)" value={totalAssigned.toLocaleString()} label="Assigned Leads" />
        <KpiCard icon={Users} iconBg="var(--brand-surface-2)" iconColor="var(--brand-on-surface)" value={data?.callers.length ?? 0} label="Active Callers" />
      </div>

      {auto.isSuccess && (
        <div className="mb-4 rounded-md bg-[var(--brand-surface-2)] px-4 py-2.5 text-sm text-[var(--brand-on-surface)]">
          Assigned {auto.data.assigned} leads across {Object.keys(auto.data.perCaller).length} caller(s).
        </div>
      )}

      <DataTable
        tableKey="assignments-callers"
        columns={columns}
        rows={data?.callers ?? []}
        getRowKey={(c) => c.id}
        title="Callers"
        subtitle="Select callers, then distribute"
        emptyText="No callers."
        onRowClick={(c) => toggle(c.id)}
      />
    </div>
  );
}
