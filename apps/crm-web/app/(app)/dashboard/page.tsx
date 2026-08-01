'use client';

import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { RefreshCw, Download, PhoneCall, Target, Percent, Phone, PhoneMissed, CheckCircle2, Hourglass, Users, TrendingUp, Video } from 'lucide-react';
import Link from 'next/link';
import { leadsApi, type Lead } from '@/lib/leads';
import { metricsApi, tasksApi, callsApi, communicationsApi, type Task, type Followup, type MissedCall } from '@/lib/crm';
import { AvailabilityPanel } from '@/components/availability-panel';
import { WidgetCard, type Column } from '@/components/dashboard/widget-card';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { LeadProgress } from '@/components/dashboard/lead-progress';
import { AnimatedNumber } from '@/components/animated-number';
import { LiveIndicator } from '@/components/live-indicator';
import { StatusPill } from '@/components/status-pill';
import { CallbackStatusPill } from '@/components/callback-status-pill';
import { callbackStatus, callbacksApi, type DueCallback } from '@/lib/callbacks';
import { formatScheduleInLeadZone } from '@/lib/timezone';
import { DateFilter } from '@/components/filter-controls';
import { EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';
import { downloadCsv } from '@/lib/export';
import { formatDateLong, formatDateTime } from '@/lib/display-settings';

const LIVE_MS = 15_000;

/** Rows a dashboard widget shows. It is a glance, not a list — and asking for
 *  only these keeps the live refresh cheap enough to run every 15 seconds. */
const WIDGET_ROWS = 10;

const PRI_STYLE: Record<string, string> = { high: 'text-[#a8431f]', medium: 'text-[#c98a18]', low: 'text-muted-foreground' };
const TASK_LABEL: Record<string, string> = { todo: 'To Do', in_progress: 'In Progress', review: 'Review', done: 'Done' };

const taskColumns: Column<Task>[] = [
  { key: 'title', header: 'Task' },
  { key: 'status', header: 'Status', cell: (r) => TASK_LABEL[r.status] ?? r.status },
  { key: 'priority', header: 'Priority', cell: (r) => <span className={`capitalize ${PRI_STYLE[r.priority] ?? ''}`}>{r.priority}</span> },
];
const fuColumns: Column<Followup>[] = [
  {
    key: 'when',
    header: 'When',
    // In the CUSTOMER's zone with the zone named. This cell used to run the
    // instant through `toLocaleString` with no zone at all, which renders it on
    // the REP's clock — so the dashboard quietly disagreed with the Follow-ups
    // page, the reminder e-mail and the time the customer was actually promised.
    cell: (r) => formatScheduleInLeadZone(r.nextFollowupDate, r.lead?.timezone),
  },
  { key: 'lead', header: 'Company', cell: (r) => r.lead?.businessName ?? '—' },
  { key: 'status', header: 'Status', cell: (r) => <CallbackStatusPill status={callbackStatus(r.nextFollowupDate, r.completedAt)} /> },
  { key: 'note', header: 'Note', cell: (r) => <span className="text-muted-foreground">{r.noteText}</span> },
];

/** Today's callbacks — the customer's today, with the zone spelled out. */
const callbackColumns: Column<DueCallback>[] = [
  { key: 'when', header: 'Scheduled', cell: (r) => r.callbackAtLabel },
  { key: 'lead', header: 'Company', cell: (r) => r.businessName },
  { key: 'phone', header: 'Phone', cell: (r) => <span className="font-mono text-[12px]">{r.phone}</span> },
  { key: 'status', header: 'Status', cell: (r) => <CallbackStatusPill status={r.status} /> },
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
  { key: 'at', header: 'When', cell: (r) => formatDateTime(r.at) },
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

  // Two small widgets, two small queries.
  //
  // Both used to be filtered out of one `leadsApi.list()` — the entire lead
  // book, every column, re-fetched on the live interval. On a 50,000-lead book
  // that is a megabyte or so of JSON every tick to render two lists of ten. The
  // filters belong in the query, and the queries are capped at what the widgets
  // can show.
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const { data: todaysLeads = [] } = useQuery({
    queryKey: ['leads', 'today', todayIso],
    queryFn: () => leadsApi.list({ createdFrom: todayIso, createdTo: todayIso, pageSize: WIDGET_ROWS, sortBy: 'createdAt', sortDir: 'desc' }),
    retry: false,
    refetchInterval: LIVE_MS,
  });
  const { data: recentClosed = [] } = useQuery({
    queryKey: ['leads', 'recent-closed'],
    // `closed: true` is the Closed Leads scope (status = closed). "Interested"
    // is a separate status, so the widget asks for each and shows them together
    // — which is what the old client-side `closed || interested` filter meant.
    queryFn: async () => {
      const [closed, interested] = await Promise.all([
        leadsApi.list({ closed: true, pageSize: WIDGET_ROWS, sortBy: 'closedAt', sortDir: 'desc' }),
        leadsApi.list({ status: 'interested', pageSize: WIDGET_ROWS, sortBy: 'createdAt', sortDir: 'desc' }),
      ]);
      return [...closed, ...interested].slice(0, WIDGET_ROWS);
    },
    retry: false,
  });
  const { data: tasks = [] } = useQuery({ queryKey: ['tasks'], queryFn: tasksApi.list, retry: false });
  const { data: followups = [] } = useQuery({ queryKey: ['followups'], queryFn: () => callsApi.followups(), retry: false });
  // Today's callbacks on the customer's calendar, plus anything still overdue —
  // the same feed the reminder popup reads, so the dashboard count and the
  // interruption can never disagree about what is outstanding.
  const { data: todaysCallbacks = [] } = useQuery({
    queryKey: ['callbacks', 'today'],
    queryFn: callbacksApi.today,
    retry: false,
    refetchInterval: LIVE_MS,
  });
  const { data: missed = [] } = useQuery({ queryKey: ['missed-calls'], queryFn: () => communicationsApi.missedCalls(), retry: false, refetchInterval: LIVE_MS });
  const summaryQ = useQuery({ queryKey: ['metrics', 'summary', dateFilter], queryFn: () => metricsApi.summary(range), retry: false, refetchInterval: LIVE_MS, refetchOnWindowFocus: true });
  const s = summaryQ.data;
  // The API reports which scope it answered in; the cards are labelled from that
  // rather than from a role the client decides, so the wording can never claim a
  // scope the figures don't have.
  const mine = s?.scope === 'personal';
  const card = (title: string) => (mine ? `My ${title}` : title);

  function refreshNow() {
    qc.invalidateQueries({ queryKey: ['metrics', 'summary'] });
    qc.invalidateQueries({ queryKey: ['leads', 'today'] });
    qc.invalidateQueries({ queryKey: ['tasks'] });
    qc.invalidateQueries({ queryKey: ['followups'] });
  }

  const openTasks = tasks.filter((t) => t.status !== 'done');
  const dateLabel = formatDateLong(new Date());

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
            // Exports exactly what the cards show, under the same labels and the
            // same scope, so a spreadsheet handed on can't imply org-wide figures
            // when it holds one employee's.
            onClick={() => downloadCsv(`dashboard-${mine ? 'my' : 'organization'}-snapshot`, ['Metric', 'Value'], [
              ['Scope', mine ? 'My data only' : 'All employees'],
              [card('Total Leads'), s?.totalLeads ?? 0],
              [card('Assigned Leads'), s?.assignedLeads ?? 0],
              [card('Contacted Leads'), s?.contactedLeads ?? 0],
              [card('Balance Leads'), s?.balanceLeads ?? 0],
              ['Progress (Contacted / Assigned)', `${s?.progressPct ?? 0}%`],
              [card('Follow-up Leads'), s?.followUpLeads ?? 0],
              [card('Converted Leads'), s?.convertedLeads ?? 0],
              // Named to match the sidebar and the module it links to. The
              // underlying metric is unchanged — still leads with status
              // `closed`; only what we call them moved on.
              [card('Onboarding Leads'), s?.closedLeads ?? 0],
              ...(mine ? [] : [['Avg Leads / Employee', s?.avgLeadsPerEmployee ?? 0] as [string, number]]),
              [mine ? 'My Total Calls' : 'Total Calls Made', s?.totalCalls ?? 0],
              [card('Connected Calls'), s?.connectedCalls ?? 0],
              [card('Missed Calls'), s?.missedCalls ?? 0],
              [card('Scheduled Calls'), s?.scheduledCalls ?? 0],
              [card('Callback Calls'), s?.callbackCalls ?? 0],
              ['Conversion Rate', `${s?.conversionPct ?? 0}%`],
              ['Planned Leads', s?.plannedLeads ?? 0],
              ['Progress to Target', `${s?.targetProgressPct ?? 0}%`],
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

      {/* ── Lead cards ──
          Labels follow the scope the API reports rather than a role read from
          the client: an employee sees "My …" because the figures behind the
          cards are their own book, and an admin sees the plain title because
          theirs are the organisation's. Nothing here chooses the scope — asking
          the client to would make the label and the number two separate claims. */}
      <section>
        <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[.08em] text-muted-foreground">
          {mine ? 'My Leads' : 'Leads — all employees'}
        </h2>
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
          <KpiCard index={0} icon={Target} iconBg="#e7f0f8" iconColor="#2c5d8f" value={<AnimatedNumber value={s?.totalLeads ?? 0} />} label={card('Total Leads')} />
          <KpiCard index={1} icon={Users} iconBg="#e7f0f8" iconColor="#2c5d8f" value={<AnimatedNumber value={s?.assignedLeads ?? 0} />} label={card('Assigned Leads')} />
          <KpiCard index={2} icon={PhoneCall} iconBg="#e3f1ee" iconColor="#2f6f63" value={<AnimatedNumber value={s?.contactedLeads ?? 0} />} label={card('Contacted Leads')} />
          {/* Assigned minus contacted — the leads still owed a first conversation.
              This replaced a "Pending Leads" card that measured total minus
              contacted: for an admin that swept in every UNASSIGNED lead, so the
              card counted work nobody had been given as work someone was late on. */}
          <KpiCard index={3} icon={Hourglass} iconBg="#fbf3e2" iconColor="#c98a18" value={<AnimatedNumber value={s?.balanceLeads ?? 0} />} label={card('Balance Leads')} />
          <KpiCard index={4} icon={RefreshCw} iconBg="#fbf3e2" iconColor="#c98a18" value={<AnimatedNumber value={s?.followUpLeads ?? 0} />} label={card('Follow-up Leads')} />
          <KpiCard index={5} icon={TrendingUp} iconBg="#e4f2e4" iconColor="#317d34" value={<AnimatedNumber value={s?.convertedLeads ?? 0} />} label={card('Converted Leads')} />
          <KpiCard index={6} icon={CheckCircle2} iconBg="#e4f2e4" iconColor="#317d34" value={<AnimatedNumber value={s?.closedLeads ?? 0} />} label={card('Onboarding Leads')} />
          {/* Only meaningful across a team, so it is absent from an employee's
              dashboard rather than shown as a hollow "1 per employee". */}
          {!mine && s?.avgLeadsPerEmployee !== null && (
            <KpiCard index={7} icon={Users} iconBg="#d8eed9" iconColor="#266929" value={<AnimatedNumber value={s?.avgLeadsPerEmployee ?? 0} decimals={1} />} label="Avg Leads / Employee" />
          )}
        </div>
        {/* Contacted out of assigned — the same three numbers as the cards above,
            so the bar can only ever move when one of them does. */}
        <div className="mt-4">
          <LeadProgress
            contacted={s?.contactedLeads ?? 0}
            assigned={s?.assignedLeads ?? 0}
            pct={s?.progressPct}
            label={mine ? 'My Progress' : 'Progress'}
          />
        </div>
      </section>

      {/* ── Call cards ── same scope, same rules as the Calls Made dashboard. */}
      <section>
        <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[.08em] text-muted-foreground">
          {mine ? 'My Calls' : 'Calls — all employees'}
        </h2>
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
          <KpiCard index={0} icon={Phone} iconBg="#e7f0f8" iconColor="#2c5d8f" value={<AnimatedNumber value={s?.totalCalls ?? 0} />} label={mine ? 'My Total Calls' : 'Total Calls Made'} />
          <KpiCard index={1} icon={PhoneCall} iconBg="#e3f1ee" iconColor="#2f6f63" value={<AnimatedNumber value={s?.connectedCalls ?? 0} />} label={card('Connected Calls')} />
          <KpiCard index={2} icon={PhoneMissed} iconBg="#fbeeec" iconColor="#a8431f" value={<AnimatedNumber value={s?.missedCalls ?? 0} />} label={card('Missed Calls')} />
          <KpiCard index={3} icon={Video} iconBg="#e7f0f8" iconColor="#2c5d8f" value={<AnimatedNumber value={s?.scheduledCalls ?? 0} />} label={card('Scheduled Calls')} />
          <KpiCard index={4} icon={RefreshCw} iconBg="#fbf3e2" iconColor="#c98a18" value={<AnimatedNumber value={s?.callbackCalls ?? 0} />} label={card('Callback Calls')} />
          <KpiCard index={5} icon={Percent} iconBg="#d8eed9" iconColor="#266929" value={<AnimatedNumber value={s?.conversionPct ?? 0} decimals={1} suffix="%" />} label="Conversion Rate" />
        </div>
      </section>

      {/* Widget grid — all live */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.2 }} className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <WidgetCard
          title="Today's Callbacks"
          columns={callbackColumns}
          rows={todaysCallbacks}
          emptyMessage="No callbacks due today."
        />
        <WidgetCard title="My Open Tasks" columns={taskColumns} rows={openTasks} emptyMessage="No open tasks." />
        <WidgetCard title="Upcoming Follow-Ups" columns={fuColumns} rows={followups} emptyMessage="No follow-ups scheduled." />
        <WidgetCard title="Missed Calls" columns={missedColumns} rows={missed} emptyMessage="No missed calls." />
        <WidgetCard title="Today's Leads" columns={leadColumns} rows={todaysLeads} emptyMessage="No leads added today." />
        <WidgetCard title="Recently Closed & Interested" columns={closedColumns} rows={recentClosed} emptyMessage="No closed leads yet." />
      </motion.div>
    </div>
  );
}
