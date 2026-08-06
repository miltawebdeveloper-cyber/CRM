'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { GitBranch, DollarSign, Percent, Clock, MapPin, Building2 } from 'lucide-react';
import { leadsApi, type Lead } from '@/lib/leads';
import { PageHead, Avatar } from '@/components/page-head';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { Segmented } from '@/components/segmented';
import { StatusPill } from '@/components/status-pill';
import { DateFilter, FilterSelect, SearchInput, optionsFrom } from '@/components/filter-controls';
import { DataTable, type ColumnDef } from '@/components/data-table';
import { inDateBounds, EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';

type View = 'board' | 'list';
const VIEWS = [{ label: 'Board', value: 'board' as View }, { label: 'List', value: 'list' as View }];

const STAGES: { key: Lead['status']; name: string; color: string }[] = [
  { key: 'new', name: 'New', color: '#2c5d8f' },
  { key: 'in_progress', name: 'In Progress', color: '#c98a18' },
  { key: 'contacted', name: 'Contacted', color: '#2f6f63' },
  { key: 'interested', name: 'Interested', color: 'var(--brand-lime-deep)' },
  { key: 'closed', name: 'Closed Won', color: 'var(--brand-strong)' },
  { key: 'rejected', name: 'Rejected', color: '#a8431f' },
];

export default function PipelinePage() {
  const router = useRouter();
  const [view, setView] = useState<View>('board');
  const [tz, setTz] = useState('');
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [created, setCreated] = useState<DateFilterValue>(EMPTY_DATE_FILTER);
  const [q, setQ] = useState('');
  const qc = useQueryClient();
  // The board groups the whole book by stage, so it reads in bulk. The limit is
  // explicit: the API's default page is 50 now, and inheriting it would quietly
  // reduce the board to fifty leads. It still gains the narrower projection and
  // the indexes behind the query.
  const { data: allLeads = [] } = useQuery({ queryKey: ['leads', 'pipeline'], queryFn: () => leadsApi.list({ limit: 1000 }) });

  // Soft-delete selected leads (own leads only for employees, enforced server-side).
  const removeLeads = useMutation({
    mutationFn: async (rows: Lead[]) => { for (const l of rows) await leadsApi.remove(l.id); },
    meta: { successMessage: 'Lead(s) deleted' },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leads'] }),
  });

  // Timezone → State → City: each level's options narrow to the picks above it.
  const tzOpts = optionsFrom(allLeads.map((l) => l.timezone), 'All Timezones');
  const stateOpts = optionsFrom(
    allLeads.filter((l) => !tz || l.timezone === tz).map((l) => l.state),
    'All States',
  );
  const cityOpts = optionsFrom(
    allLeads.filter((l) => (!tz || l.timezone === tz) && (!state || l.state === state)).map((l) => l.city),
    'All Cities',
  );

  const term = q.trim().toLowerCase();
  const leads = allLeads.filter(
    (l) =>
      (!tz || l.timezone === tz) &&
      (!state || l.state === state) &&
      (!city || l.city === city) &&
      inDateBounds(l.createdAt, created) &&
      (!term ||
        l.businessName.toLowerCase().includes(term) ||
        l.city.toLowerCase().includes(term) ||
        l.state.toLowerCase().includes(term)),
  );
  const openDeals = leads.filter((l) => l.status !== 'closed' && l.status !== 'rejected').length;

  const columns = useMemo<ColumnDef<Lead>[]>(() => [
    { key: 'deal', header: 'Deal', required: true, render: (d) => <div className="flex items-center gap-[10px]"><Avatar name={d.businessName} /><span className="font-semibold">{d.businessName}</span></div> },
    { key: 'location', header: 'Location', render: (d) => `${d.city}, ${d.state}` },
    { key: 'timezone', header: 'Timezone', render: (d) => <span className="rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-semibold">{d.timezone}</span> },
    { key: 'stage', header: 'Stage', render: (d) => <StatusPill status={d.status} /> },
  ], []);

  return (
    <div>
      <PageHead>
        <SearchInput value={q} onChange={setQ} placeholder="Search deal or location…" className="min-w-[220px]" />
        <FilterSelect icon={Clock} value={tz} onChange={(v) => { setTz(v); setState(''); setCity(''); }} options={tzOpts} />
        <FilterSelect icon={MapPin} value={state} onChange={(v) => { setState(v); setCity(''); }} options={stateOpts} />
        <FilterSelect icon={Building2} value={city} onChange={setCity} options={cityOpts} />
        <DateFilter value={created} onChange={setCreated} />
        <Segmented options={VIEWS} value={view} onChange={setView} />
      </PageHead>

      <div className="mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        <KpiCard icon={GitBranch} iconBg="var(--brand-tint)" iconColor="var(--brand)" value={openDeals} label="Open Deals" />
        <KpiCard icon={DollarSign} iconBg="var(--brand-tint-2)" iconColor="var(--brand-strong)" value="$284K" label="Weighted Value" />
        <KpiCard icon={Percent} iconBg="#fdf1de" iconColor="#c98a18" value="22%" label="Win Rate" />
        <KpiCard icon={Clock} iconBg="#e3f1ee" iconColor="#2f6f63" value="14 days" label="Avg Cycle" />
      </div>

      {view === 'board' ? (
        <div className="grid auto-cols-[minmax(220px,1fr)] grid-flow-col gap-[14px] overflow-x-auto pb-2">
          {STAGES.map((stage) => {
            const deals = leads.filter((l) => l.status === stage.key);
            return (
              <div key={stage.key} className="min-h-[300px] rounded-2xl border bg-background p-3">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[12px] font-bold"><span className="h-[9px] w-[9px] rounded-[3px]" style={{ background: stage.color }} />{stage.name}</div>
                  <span className="rounded-full border bg-card px-2 py-px text-[10.5px] font-bold text-muted-foreground">{deals.length}</span>
                </div>
                {deals.slice(0, 8).map((d) => (
                  <div
                    key={d.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${d.businessName}`}
                    onClick={() => router.push(`/leads/${d.id}`)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); router.push(`/leads/${d.id}`); } }}
                    className="mb-[9px] cursor-pointer rounded-[11px] border bg-card p-3 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    <div className="text-[12.5px] font-semibold">{d.businessName}</div>
                    <div className="my-1.5 font-display text-[14px] font-semibold text-primary">{d.city}, {d.state}</div>
                    <div className="flex items-center justify-between text-[10.5px] text-muted-foreground"><span>{d.timezone}</span><Avatar name={d.businessName} /></div>
                  </div>
                ))}
                {deals.length === 0 && <div className="p-2 text-center text-[11.5px] text-muted-foreground">No deals</div>}
              </div>
            );
          })}
        </div>
      ) : (
        <DataTable
          tableKey="pipeline-list"
          columns={columns}
          rows={leads}
          getRowKey={(d) => d.id}
          emptyText="No deals."
          onRowClick={(d) => router.push(`/leads/${d.id}`)}
          onDeleteSelected={(rows) => removeLeads.mutateAsync(rows)}
          deleteConfirm={(rows) => `Delete ${rows.length} lead${rows.length > 1 ? 's' : ''}? (History is kept.)`}
        />
      )}
    </div>
  );
}
