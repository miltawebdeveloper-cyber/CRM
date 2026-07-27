'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Calendar, Plus, Clock, RefreshCw, CheckCircle2, AlertTriangle, Phone, Filter, Pencil, CircleCheckBig, Users } from 'lucide-react';
import { callsApi, assignmentsApi, type Followup } from '@/lib/crm';
import { useCanCall } from '@/lib/use-can-call';
import { PageHead, Avatar } from '@/components/page-head';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { DateFilter, FilterSelect, SearchInput } from '@/components/filter-controls';
import { DataTable, type ColumnDef } from '@/components/data-table';
import { inDateBounds, EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';

const TIMEFRAME_OPTS = [
  { label: 'All Follow-Ups', value: '' },
  { label: 'Overdue', value: 'overdue' },
  { label: 'Due Today', value: 'today' },
  { label: 'This Week', value: 'week' },
];

function whenLabel(iso: string): { text: string; overdue: boolean; today: boolean } {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const overdue = d < now && !sameDay;
  const text = sameDay
    ? `Today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return { text, overdue, today: sameDay };
}

export default function FollowupsPage() {
  const router = useRouter();
  const [userId, setUserId] = useState(''); // '' = All Users (manager filter)
  const { data: allFus = [], isLoading } = useQuery({
    queryKey: ['followups', userId],
    queryFn: () => callsApi.followups(userId || undefined),
    retry: false,
  });
  // Caller list powering the User Filter (admin/TL-gated endpoint).
  const { data: summary } = useQuery({ queryKey: ['assignment-summary'], queryFn: assignmentsApi.summary, retry: false });
  const userOpts = useMemo(
    () => [{ label: 'All Users', value: '' }, ...(summary?.callers ?? []).map((c) => ({ label: c.name, value: c.id }))],
    [summary],
  );
  const [timeframe, setTimeframe] = useState('');
  const [created, setCreated] = useState<DateFilterValue>(EMPTY_DATE_FILTER);
  const [q, setQ] = useState('');
  // Refuse to dial before the API would reject the call (no assigned caller ID).
  const { dial, callingEnabled } = useCanCall();

  const now = new Date();
  const dueToday = allFus.filter((f) => new Date(f.nextFollowupDate).toDateString() === now.toDateString()).length;
  const overdue = allFus.filter((f) => { const d = new Date(f.nextFollowupDate); return d < now && d.toDateString() !== now.toDateString(); }).length;
  const thisWeek = allFus.filter((f) => { const d = new Date(f.nextFollowupDate); const diff = (d.getTime() - now.getTime()) / 86400000; return diff >= 0 && diff <= 7; }).length;

  const matchesTimeframe = (f: Followup) => {
    const d = new Date(f.nextFollowupDate);
    const sameDay = d.toDateString() === now.toDateString();
    if (timeframe === 'overdue') return d < now && !sameDay;
    if (timeframe === 'today') return sameDay;
    if (timeframe === 'week') { const diff = (d.getTime() - now.getTime()) / 86400000; return diff >= 0 && diff <= 7; }
    return true;
  };
  const term = q.trim().toLowerCase();
  const fus = allFus.filter(
    (f) =>
      matchesTimeframe(f) &&
      inDateBounds(f.nextFollowupDate, created) &&
      (!term ||
        (f.lead?.businessName ?? '').toLowerCase().includes(term) ||
        (f.lead?.phone ?? '').toLowerCase().includes(term) ||
        (f.noteText ?? '').toLowerCase().includes(term)),
  );

  async function mutateFollowup(kind: Followup['kind'], id: string, action: 'complete' | 'edit') {
    if (action === 'complete') {
      await callsApi.completeFollowup(kind, id);
      return;
    }
    const current = allFus.find((f) => f.kind === kind && f.id === id);
    if (!current) return;
    const next = window.prompt('New follow-up date/time (ISO or local datetime)', current.nextFollowupDate);
    if (next === null) return;
    const noteText = window.prompt('Follow-up note', current.noteText) ?? current.noteText;
    await callsApi.updateFollowup(kind, id, { followUpAt: next || null, noteText });
  }

  const columns = useMemo<ColumnDef<Followup>[]>(() => [
    {
      key: 'when', header: 'When', required: true,
      render: (f) => { const w = whenLabel(f.nextFollowupDate); return <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: w.overdue ? '#a8431f' : w.today ? '#c98a18' : '#a6c74d' }} /><b>{w.text}</b></div>; },
    },
    { key: 'company', header: 'Company', render: (f) => <div className="flex items-center gap-[10px]"><Avatar name={f.lead?.businessName ?? '—'} /><span className="font-semibold">{f.lead?.businessName ?? '—'}</span></div> },
    { key: 'note', header: 'Note', cellClassName: 'max-w-[280px] truncate text-muted-foreground', render: (f) => f.noteText },
    { key: 'phone', header: 'Phone', cellClassName: 'font-mono text-[12px]', render: (f) => f.lead?.phone ?? '—' },
    {
      key: 'actions',
      header: '',
      required: true,
      render: (f) => (
        <div className="flex items-center gap-2">
          {/* Hidden while calling is disabled — see the leads list. */}
          {callingEnabled && (
            <button onClick={() => { if (!f.lead) return router.push('/calling'); if (!dial(f.lead.phone)) return; router.push(`/calling?leadId=${f.lead.id}&autocall=1`); }} className="grid h-[30px] w-[30px] place-items-center rounded-lg border opacity-50 transition-opacity hover:bg-primary hover:text-primary-foreground group-hover:opacity-100" title="Call lead">
              <Phone className="h-[15px] w-[15px]" />
            </button>
          )}
          <button onClick={() => void mutateFollowup(f.kind, f.id, 'edit')} className="grid h-[30px] w-[30px] place-items-center rounded-lg border opacity-60 transition-opacity hover:bg-muted hover:opacity-100" title="Edit follow-up">
            <Pencil className="h-[15px] w-[15px]" />
          </button>
          <button onClick={() => void mutateFollowup(f.kind, f.id, 'complete')} className="grid h-[30px] w-[30px] place-items-center rounded-lg border opacity-60 transition-opacity hover:bg-primary hover:text-primary-foreground hover:opacity-100" title="Complete follow-up">
            <CircleCheckBig className="h-[15px] w-[15px]" />
          </button>
        </div>
      ),
    },
  ], [router, dial, callingEnabled]);

  return (
    <div>
      <PageHead>
        <button onClick={() => router.push('/calendar')} className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[13px] font-semibold hover:bg-muted"><Calendar className="h-4 w-4" /> Calendar</button>
        <button onClick={() => router.push('/calling')} className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[13px] font-semibold text-primary-foreground hover:opacity-90"><Plus className="h-4 w-4" /> Schedule</button>
      </PageHead>

      <div className="mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        <KpiCard icon={Clock} iconBg="#fbeeec" iconColor="#a8431f" value={dueToday} label="Due Today" />
        <KpiCard icon={RefreshCw} iconBg="#fbf3e2" iconColor="#c98a18" value={thisWeek} label="This Week" />
        <KpiCard icon={CheckCircle2} iconBg="#e4f2e4" iconColor="#317d34" value={fus.length} label="Total Scheduled" />
        <KpiCard icon={AlertTriangle} iconBg="#fbeeec" iconColor="#a8431f" value={overdue} label="Overdue" />
      </div>

      <DataTable
        tableKey="followups"
        columns={columns}
        rows={fus}
        getRowKey={(f) => f.id}
        title="Upcoming Follow-Ups"
        subtitle={`${fus.length} shown`}
        loading={isLoading}
        emptyText={allFus.length === 0 ? 'No follow-ups scheduled. Set a follow-up date when saving a call note.' : 'No follow-ups match the current filters.'}
        toolbar={
          <>
            <SearchInput value={q} onChange={setQ} placeholder="Search company, phone, note…" className="min-w-[220px]" />
            <FilterSelect icon={Users} value={userId} onChange={setUserId} options={userOpts} />
            <FilterSelect icon={Filter} value={timeframe} onChange={setTimeframe} options={TIMEFRAME_OPTS} />
            <DateFilter value={created} onChange={setCreated} />
          </>
        }
      />
    </div>
  );
}
