'use client';

import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { RefreshCw, Download, PhoneCall, Target, Percent, Phone, CheckCircle2, DollarSign } from 'lucide-react';
import Link from 'next/link';
import { leadsApi, type Lead } from '@/lib/leads';
import { metricsApi, tasksApi, callsApi, communicationsApi, type Task, type Followup, type MissedCall } from '@/lib/crm';
import { AvailabilityPanel } from '@/components/availability-panel';
import { WidgetCard, type Column } from '@/components/dashboard/widget-card';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { AnimatedNumber } from '@/components/animated-number';
import { LiveIndicator } from '@/components/live-indicator';
import { StatusPill } from '@/components/status-pill';
import { DateFilter } from '@/components/filter-controls';
import { EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';
import { downloadCsv } from '@/lib/export';

const LIVE_MS = 15_000;

const PRI_STYLE: Record<string, string> = { high: 'text-[#a8431f]', medium: 'text-[#c98a18]', low: 'text-muted-foreground' };
const TASK_LABEL: Record<string, string> = { todo: 'To Do', in_progress: 'In Progress', review: 'Review', done: 'Done' };

const taskColumns: Column<Task>[] = [
  { key: 'title', header: 'Task' },
  { key: 'status', header: 'Status', cell: (r) => TASK_LABEL[r.status] ?? r.status },
  { key: 'priority', header: 'Priority', cell: (r) => <span className={`capitalize ${PRI_STYLE[r.priority] ?? ''}`}>{r.priority}</span> },
];
const fuColumns: Column<Followup>[] = [
  { key: 'when', header: 'When', cell: (r) => new Date(r.nextFollowupDate).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) },
  { key: 'lead', header: 'Company', cell: (r) => r.lead?.businessName ?? '—' },
  { key: 'note', header: 'Note', cell: (r) => <span className="text-muted-foreground">{r.noteText}</span> },
];
const leadColumns: Column<Lead>[] = [
  { key: 'businessName', header: 'Lead Name' },
  { key: 'city', header: 'Company', cell: (r) => `${r.city}, ${r.state}` },
  { key: 'email', header: 'Email', cell: (r) => r.email ?? '—' },
  { key: 'phone', header: 'Phone' },
];
const closedColumns: Column<Lead>[] = [
  { key: 'businessName', header: 'Business' },
  { key: 'city', header: 'Location', cell: (r) => `${r.city}, ${r.state}` },
  { key: 'status', header: 'Status', cell: (r) => <StatusPill status={r.status} /> },
];
const missedColumns: Column<MissedCall>[] = [
  { key: 'at', header: 'When', cell: (r) => new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) },
  { key: 'businessName', header: 'Customer', cell: (r) => <Link href={`/leads/${r.leadId}`} className="font-medium hover:underline">{r.businessName}</Link> },
  { key: 'phone', header: 'Phone' },
  { key: 'assignedTo', header: 'Assigned To', cell: (r) => r.assignedTo ?? '—' },
];

export default function DashboardPage() {
  const qc = useQueryClient();
  const [dateFilter, setDateFilter] = useState<DateFilterValue>(EMPTY_DATE_FILTER);

  const range = useMemo(() => {
    if (!dateFilter.from && !dateFilter.to) return {};
    return {
      from: dateFilter.from ? new Date(dateFilter.from).toISOString() : undefined,
      to: dateFilter.to ? new Date(dateFilter.to + 'T23:59:59.999Z').toISOString() : undefined,
    };
  }, [dateFilter]);

  const { data: leads = [] } = useQuery({ queryKey: ['leads', 'today'], queryFn: () => leadsApi.list(), retry: false, refetchInterval: LIVE_MS });
  const { data: tasks = [] } = useQuery({ queryKey: ['tasks'], queryFn: tasksApi.list, retry: false });
  const { data: followups = [] } = useQuery({ queryKey: ['followups'], queryFn: () => callsApi.followups(), retry: false });
  const { data: missed = [] } = useQuery({ queryKey: ['missed-calls'], queryFn: communicationsApi.missedCalls, retry: false, refetchInterval: LIVE_MS });
  const summaryQ = useQuery({ queryKey: ['metrics', 'summary', dateFilter], queryFn: () => metricsApi.summary(range), retry: false, refetchInterval: LIVE_MS, refetchOnWindowFocus: true });
  const s = summaryQ.data;

  function refreshNow() {
    qc.invalidateQueries({ queryKey: ['metrics', 'summary'] });
    qc.invalidateQueries({ queryKey: ['leads', 'today'] });
    qc.invalidateQueries({ queryKey: ['tasks'] });
    qc.invalidateQueries({ queryKey: ['followups'] });
  }

  const today = new Date().toDateString();
  const todaysLeads = leads.filter((l) => new Date(l.createdAt).toDateString() === today);
  const openTasks = tasks.filter((t) => t.status !== 'done');
  const recentClosed = leads.filter((l) => l.status === 'closed' || l.status === 'interested');
  const dateLabel = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div className="space-y-5">
      {/* Availability toggle + reassigned-work feed */}
      <AvailabilityPanel />

      {/* Page head */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[13px] text-muted-foreground">Live snapshot — {dateLabel}. Targets refresh nightly.</div>
          <div className="mt-2"><LiveIndicator updatedAt={summaryQ.dataUpdatedAt || Date.now()} fetching={summaryQ.isFetching} /></div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <DateFilter value={dateFilter} onChange={setDateFilter} />
          <button onClick={refreshNow} aria-label="Refresh" className="grid h-9 w-9 place-items-center rounded-md border bg-card text-muted-foreground hover:text-foreground">
            <RefreshCw className={`h-4 w-4 ${summaryQ.isFetching ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => downloadCsv('dashboard-snapshot', ['Metric', 'Value'], [
              ['Total Leads', s?.totalLeads ?? 0],
              ['Planned Leads', s?.plannedLeads ?? 0],
              ['Contacted', s?.contactedLeads ?? 0],
              ['Progress %', `${s?.progressPct ?? 0}%`],
              ['Closed Leads', s?.closedLeads ?? 0],
              ['Open Tasks', openTasks.length],
              ['Upcoming Follow-Ups', followups.length],
              ['Leads Added Today', todaysLeads.length],
            ])}
            className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[13px] font-semibold hover:bg-muted"
          >
            <Download className="h-4 w-4" /> Export
          </button>
          <Link href="/calling" className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[13px] font-semibold text-primary-foreground shadow-sm hover:opacity-90">
            <PhoneCall className="h-4 w-4" /> Start calling
          </Link>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        <KpiCard index={0} icon={Target} iconBg="#e7f0f8" iconColor="#2c5d8f" value={<AnimatedNumber value={s?.totalLeads ?? 0} />} label="Total Leads" trend="4.2%" trendDir="up" spark={[40, 42, 45, 43, 50, 55, 58, 62, 70]} sparkColor="#2c5d8f" />
        <KpiCard index={1} icon={PhoneCall} iconBg="#e3f1ee" iconColor="#2f6f63" value={<AnimatedNumber value={s?.contactedLeads ?? 0} />} label="Contacted" spark={[8, 12, 16, 20, 25, 30, 36, 42, 50]} sparkColor="#2f6f63" />
        <KpiCard index={2} icon={Percent} iconBg="#e4f2e4" iconColor="#317d34" value={<AnimatedNumber value={s?.progressPct ?? 0} decimals={2} suffix="%" />} label="Progress to Target" trend="0.4%" trendDir="up" spark={[6, 6.5, 7, 7.2, 7.8, 8, 8.2, 8.4, 8.56]} sparkColor="#317d34" />
        <KpiCard index={3} icon={CheckCircle2} iconBg="#e4f2e4" iconColor="#317d34" value={<AnimatedNumber value={s?.closedLeads ?? 0} />} label="Closed Leads" trend="8%" trendDir="up" spark={[10, 15, 18, 22, 25, 30, 33, 38, 41]} sparkColor="#317d34" />
        <KpiCard index={4} icon={Phone} iconBg="#e3f1ee" iconColor="#2f6f63" value={openTasks.length} label="Open Tasks" spark={[12, 18, 22, 30, 28, 35, 40, 46, 53]} sparkColor="#2f6f63" />
        <KpiCard index={5} icon={RefreshCw} iconBg="#fbf3e2" iconColor="#c98a18" value={followups.length} label="Follow-Ups" spark={[20, 22, 25, 28, 30, 29, 31, 33, 34]} sparkColor="#c98a18" />
        <KpiCard index={6} icon={Percent} iconBg="#d8eed9" iconColor="#266929" value={`${s?.progressPct ?? 0}%`} label="Conversion Rate" trend="0.4%" trendDir="up" spark={[6, 6.5, 7, 7.2, 7.8, 8, 8.2, 8.4, 8.56]} sparkColor="#2b732f" />
      </div>

      {/* Widget grid — all live */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.2 }} className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <WidgetCard title="My Open Tasks" columns={taskColumns} rows={openTasks} emptyMessage="No open tasks." />
        <WidgetCard title="Upcoming Follow-Ups" columns={fuColumns} rows={followups} emptyMessage="No follow-ups scheduled." />
        <WidgetCard title="Missed Calls" columns={missedColumns} rows={missed} emptyMessage="No missed calls." />
        <WidgetCard title="Today's Leads" columns={leadColumns} rows={todaysLeads} emptyMessage="No leads added today." />
        <WidgetCard title="Recently Closed & Interested" columns={closedColumns} rows={recentClosed} emptyMessage="No closed leads yet." />
      </motion.div>
    </div>
  );
}
