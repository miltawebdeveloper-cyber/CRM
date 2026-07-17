'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Filter, User } from 'lucide-react';
import { api } from '@/lib/api';
import { type Role } from '@/lib/nav';
import { callsApi, outcomesApi, type OutcomeRecord } from '@/lib/crm';
import { PageHead } from '@/components/page-head';
import { OutcomePill } from '@/components/outcome-pill';
import { DataTable, type ColumnDef } from '@/components/data-table';
import { DateRangePicker, FilterSelect, SearchInput } from '@/components/filter-controls';
import { inDateBounds, type DateRange } from '@/lib/date-filters';

export default function OutcomesPage() {
  const { data: rows = [], isLoading } = useQuery({ queryKey: ['outcomes'], queryFn: () => callsApi.outcomes(), retry: false });
  const { data: outcomeDefs = [] } = useQuery({ queryKey: ['outcomes-config'], queryFn: outcomesApi.list });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data, retry: false });
  const role = me?.role as Role | undefined;
  const isManager = role === 'admin' || role === 'team_leader';

  const defBySlug = useMemo(() => new Map(outcomeDefs.map((o) => [o.slug, o])), [outcomeDefs]);
  const OUTCOME_OPTS = useMemo(
    () => [{ label: 'All Outcomes', value: '' }, ...outcomeDefs.map((o) => ({ label: o.name, value: o.slug }))],
    [outcomeDefs],
  );
  const [outcome, setOutcome] = useState('');
  const [userId, setUserId] = useState('');
  const [range, setRange] = useState<DateRange>({ from: '', to: '' });
  const [q, setQ] = useState('');

  // Distinct callers present in the data → User filter (req 6).
  const userOpts = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) if (r.caller) seen.set(r.caller.id, r.caller.name);
    return [
      { label: 'All Users', value: '' },
      ...Array.from(seen, ([value, label]) => ({ label, value })).sort((a, b) => a.label.localeCompare(b.label)),
    ];
  }, [rows]);

  const term = q.trim().toLowerCase();
  const filtered = rows.filter((r) =>
    (!outcome || r.outcome === outcome) &&
    (!userId || r.caller?.id === userId) &&
    inDateBounds(r.createdAt, range) &&
    (!term ||
      (r.lead?.businessName ?? '').toLowerCase().includes(term) ||
      (r.lead?.phone ?? '').toLowerCase().includes(term) ||
      (r.caller?.name ?? '').toLowerCase().includes(term)),
  );

  const columns = useMemo<ColumnDef<OutcomeRecord>[]>(() => [
    { key: 'when', header: 'When', required: true, render: (r) => new Date(r.createdAt).toLocaleString() },
    { key: 'lead', header: 'Lead', required: true, render: (r) => r.lead?.businessName ?? '—' },
    { key: 'caller', header: 'Caller', render: (r) => r.caller?.name ?? '—' },
    { key: 'phone', header: 'Phone', render: (r) => r.lead?.phone ?? '—' },
    {
      key: 'outcome',
      header: 'Outcome',
      render: (r) => {
        if (!r.outcome) return '—';
        const def = defBySlug.get(r.outcome);
        return <OutcomePill name={def?.name ?? r.outcome.replace(/_/g, ' ')} color={def?.color} />;
      },
    },
    {
      key: 'callback',
      header: 'Callback',
      render: (r) => r.callbackAt
        ? <span className="font-medium text-[#a8431f]">{new Date(r.callbackAt).toLocaleString()}</span>
        : '—',
    },
    {
      key: 'pin',
      header: 'Pinned',
      render: (r) => {
        const pinned = !!(r.lead?.callbackAt && !r.lead.callbackCompletedAt && new Date(r.lead.callbackAt) <= new Date());
        return pinned ? <span className="rounded-full bg-[#fbeeec] px-2 py-0.5 text-[11px] font-semibold text-[#a8431f]">Pinned</span> : '—';
      },
    },
  ], [defBySlug]);

  return (
    <div>
      <PageHead>
        <div className="flex flex-wrap items-center gap-2.5">
          <SearchInput value={q} onChange={setQ} placeholder="Search lead, caller, phone…" className="min-w-[220px]" />
          {isManager && <FilterSelect icon={User} value={userId} onChange={setUserId} options={userOpts} />}
          <FilterSelect icon={Filter} value={outcome} onChange={setOutcome} options={OUTCOME_OPTS} />
          <DateRangePicker value={range} onChange={setRange} />
        </div>
      </PageHead>

      <DataTable
        tableKey="outcomes"
        columns={columns}
        rows={filtered}
        getRowKey={(r) => r.id}
        title="Outcome Records"
        subtitle={`${filtered.length} shown`}
        loading={isLoading}
        emptyText="No outcome records match the current filters."
        selectionMode="row"
      />
    </div>
  );
}
