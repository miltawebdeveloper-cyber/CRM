'use client';

import { useState, useMemo } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Upload, PhoneCall, Target, Percent, Phone, PhoneMissed, CheckCircle2, Hourglass, Users, UserPlus, TrendingUp, Video, ChevronDown, ArrowRight, BellRing, CalendarCheck, AlarmClock, PhoneOff, AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { leadsApi, type Lead } from '@/lib/leads';
import { metricsApi, tasksApi, callsApi, communicationsApi, productivityApi, type Task, type Followup, type MissedCall, type DailySummaryRow } from '@/lib/crm';
import { AvailabilityPanel } from '@/components/availability-panel';
import { WidgetCard, type Column } from '@/components/dashboard/widget-card';
import { KpiCard, KpiGrid } from '@/components/dashboard/kpi-card';
import { LeadFunnel } from '@/components/dashboard/lead-funnel';
import { TrendChart } from '@/components/dashboard/trend-chart';
import { kpiDelta } from '@/lib/kpi-delta';
import { AnimatedNumber } from '@/components/animated-number';
import { LiveIndicator } from '@/components/live-indicator';
import { StatusPill } from '@/components/status-pill';
import { CallbackStatusPill } from '@/components/callback-status-pill';
import { callbackStatus, callbacksApi, type DueCallback } from '@/lib/callbacks';
import { formatScheduleInLeadZone, leadDateTime } from '@/lib/timezone';
import { DateFilter } from '@/components/filter-controls';
import { EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';
import { businessDate } from '@/lib/business-day';
import { downloadCsv } from '@/lib/export';
import { api } from '@/lib/api';
import { dashboardLinks } from '@/lib/dashboard-links';
import { usePersistedState } from '@/lib/use-persisted-state';
import { formatDateLong, formatDateTime } from '@/lib/display-settings';

const LIVE_MS = 15_000;

/** Rows a dashboard widget shows. It is a glance, not a list — and asking for
 *  only these keeps the live refresh cheap enough to run every 15 seconds. */
const WIDGET_ROWS = 10;

const PRI_STYLE: Record<string, string> = { high: 'text-[var(--tone-red-fg-2)]', medium: 'text-[var(--tone-amber-fg)]', low: 'text-muted-foreground' };
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
  { key: 'phone', header: 'Phone', cell: (r) => <span className="font-mono text-[11.5px]">{r.phone}</span> },
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
/** Today per rep — the manager's leaderboard, most calls first. */
const teamColumns: Column<DailySummaryRow>[] = [
  { key: 'name', header: 'Rep' },
  { key: 'callsMade', header: 'Calls', className: 'text-right tabular-nums' },
  { key: 'connected', header: 'Connected', className: 'text-right tabular-nums' },
  { key: 'callbacks', header: 'Callbacks', className: 'text-right tabular-nums' },
  { key: 'deals', header: 'Deals', className: 'text-right tabular-nums' },
];
const missedColumns: Column<MissedCall>[] = [
  { key: 'at', header: 'When', cell: (r) => leadDateTime(r.at, r.timezone) },
  { key: 'businessName', header: 'Customer', cell: (r) => <Link href={`/leads/${r.leadId}`} className="font-medium hover:underline">{r.businessName}</Link> },
  { key: 'phone', header: 'Phone' },
  { key: 'assignedTo', header: 'Assigned To', cell: (r) => r.assignedTo ?? '—' },
];

/**
 * Leads against the plan — the targets set on the Targets page.
 *
 * The API has always returned this (planned leads and progress to target); it
 * only ever reached the CSV export. Organisation-wide only: targets are set
 * per territory, not per rep, so an employee's own book measured against the
 * whole plan would be a meaningless percentage.
 */
function TargetProgress({ total, planned, pct, href }: { total: number; planned: number; pct: number; href?: string }) {
  if (planned <= 0) {
    return (
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed bg-card px-4 py-2.5 text-[12.5px] text-muted-foreground">
        <span>No lead target set yet — set one to track progress against plan.</span>
        {href && (
          <Link href={href} className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
            Set targets <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
    );
  }
  const width = Math.min(100, Math.max(0, pct));
  return (
    <div className="mt-3 rounded-xl border bg-card px-4 py-3 shadow-sm">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-[12.5px]">
        <span className="font-semibold">Progress to target</span>
        <span className="text-muted-foreground">
          <span className="font-semibold tabular-nums text-foreground">{total.toLocaleString()}</span> of{' '}
          <span className="tabular-nums">{planned.toLocaleString()}</span> planned leads ·{' '}
          <span className="font-semibold tabular-nums text-foreground">{pct}%</span>
          {href && (
            <Link href={href} className="ml-3 inline-flex items-center gap-1 font-semibold text-primary hover:underline">
              Targets <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          )}
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Progress to target"
        aria-valuenow={Math.round(width)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const qc = useQueryClient();
  const [dateFilter, setDateFilter] = useState<DateFilterValue>(EMPTY_DATE_FILTER);

  // `yyyy-mm-dd`, exactly as the picker produces it and as Lead Management sends
  // it. It used to be widened to a full ISO instant here — `new Date(from)` and
  // a `T23:59:59.999Z` suffix — which the API then read as an Invalid Date and
  // every card came back wrong. The API resolves a bare date to the whole local
  // day at its end, so there is nothing for the client to compute.
  const range = useMemo(() => {
    if (!dateFilter.from && !dateFilter.to) return {};
    return { from: dateFilter.from || undefined, to: dateFilter.to || undefined };
  }, [dateFilter]);

  // Two small widgets, two small queries.
  //
  // Both used to be filtered out of one `leadsApi.list()` — the entire lead
  // book, every column, re-fetched on the live interval. On a 50,000-lead book
  // that is a megabyte or so of JSON every tick to render two lists of ten. The
  // filters belong in the query, and the queries are capped at what the widgets
  // can show.
  // The BUSINESS date, which is what the API reads `createdFrom/To` against.
  // `toISOString()` gave the UTC date, a day off for most of the Indian evening.
  const todayIso = useMemo(() => businessDate(), []);
  // A page rather than a list: the widget shows ten rows but says how many
  // there really are — its footer used to read "10" on a day that added 200.
  const { data: todaysLeadsPage } = useQuery({
    queryKey: ['leads', 'today', todayIso, 'page'],
    queryFn: () => leadsApi.page({ createdFrom: todayIso, createdTo: todayIso, pageSize: WIDGET_ROWS, sortBy: 'createdAt', sortDir: 'desc' }),
    retry: false,
    refetchInterval: LIVE_MS,
  });
  const todaysLeads = todaysLeadsPage?.rows ?? [];
  const { data: recentClosedPage } = useQuery({
    queryKey: ['leads', 'recent-closed', 'page'],
    // `closed: true` is the Closed Leads scope (status = closed). "Interested"
    // is a separate status, so the widget asks for each and shows them together
    // — which is what the old client-side `closed || interested` filter meant.
    queryFn: async () => {
      const [closed, interested] = await Promise.all([
        leadsApi.page({ closed: true, pageSize: WIDGET_ROWS, sortBy: 'closedAt', sortDir: 'desc' }),
        leadsApi.page({ status: 'interested', pageSize: WIDGET_ROWS, sortBy: 'createdAt', sortDir: 'desc' }),
      ]);
      return { rows: [...closed.rows, ...interested.rows].slice(0, WIDGET_ROWS), total: closed.total + interested.total };
    },
    retry: false,
  });
  const recentClosed = recentClosedPage?.rows ?? [];
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
  const summaryQ = useQuery({
    queryKey: ['metrics', 'summary', dateFilter],
    // With a full range, the previous period of the same length comes back
    // too — the ▲/▼ on the cards. Without one there's nothing to compare.
    queryFn: () => metricsApi.summary(range.from && range.to ? { ...range, compare: true } : range),
    retry: false,
    refetchInterval: LIVE_MS,
    refetchOnWindowFocus: true,
    // Changing the date range used to drop every card to 0 until the new
    // figures arrived. The previous ones stay instead, dimmed while they are
    // stale — no flash, no jump.
    placeholderData: keepPreviousData,
  });
  const s = summaryQ.data;
  // The API reports which scope it answered in; the cards are labelled from that
  // rather than from a role the client decides, so the wording can never claim a
  // scope the figures don't have.
  const mine = s?.scope === 'personal';
  const card = (title: string) => (mine ? `My ${title}` : title);

  // ▲/▼ against the period just before (lib/kpi-delta). Only on figures that
  // describe the period — new leads, contacts, conversions, calls — not on
  // states such as Unassigned or Balance, which a period doesn't change.
  const prev = s?.previous ?? null;
  const delta = (current: number | undefined, before: number | undefined, opts: { upIsGood?: boolean; kind?: 'pct' | 'pts' } = {}) =>
    prev ? kpiDelta(current ?? 0, before ?? 0, { ...opts, days: prev.days }) : null;

  // The trend follows the dashboard's range, or shows the last 14 days.
  const trendQ = useQuery({
    queryKey: ['metrics', 'trend', range],
    queryFn: ({ signal }) => metricsApi.trend(range.from && range.to ? range : undefined, signal),
    retry: false,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

  // Where each card and list opens — see lib/dashboard-links. The role decides
  // which pages may be linked; the date range travels with lead-list links.
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data, retry: false });
  const links = useMemo(() => dashboardLinks({ role: me?.role, dateFilter, today: todayIso }), [me?.role, dateFilter, todayIso]);
  // The less-used cards fold into "More metrics", remembered per browser.
  const [moreOpen, setMoreOpen] = usePersistedState('dashboard:more-metrics', false);

  function refreshNow() {
    qc.invalidateQueries({ queryKey: ['metrics', 'summary'] });
    qc.invalidateQueries({ queryKey: ['leads', 'today'] });
    qc.invalidateQueries({ queryKey: ['tasks'] });
    qc.invalidateQueries({ queryKey: ['followups'] });
  }

  const openTasks = tasks.filter((t) => t.status !== 'done');
  const dateLabel = formatDateLong(new Date());

  /**
   * The dashboard per role.
   *
   * An employee opens it to run their day, so they get "My day" first: what is
   * due now, what is due today, what is late, who has never been reached, and
   * how many calls they have made. A manager opens it to run the floor, so they
   * get the leads still waiting for an owner and a leaderboard of today per
   * rep. The cards, funnel, trend and lists below are shared — scoped by the
   * API to the reader either way.
   */
  // Employee — the follow-up chips on their own book (the same counts Lead
  // Management's chips show), and today's calls.
  const myBookQ = useQuery({
    queryKey: ['leads', 'summary', 'my-day'],
    queryFn: ({ signal }) => leadsApi.summary({ closed: false, assigned: 'assigned' }, signal),
    enabled: mine,
    retry: false,
    refetchInterval: LIVE_MS,
  });
  const myTodayQ = useQuery({
    queryKey: ['metrics', 'summary', 'today', todayIso],
    queryFn: ({ signal }) => metricsApi.summary({ from: todayIso, to: todayIso }, signal),
    enabled: mine,
    retry: false,
    refetchInterval: LIVE_MS,
  });
  const dueNow = todaysCallbacks.filter((c) => c.status === 'due').length;
  // Manager — the unassigned pool right now (not the cards' date range), and today per rep.
  const poolQ = useQuery({
    queryKey: ['leads', 'summary', 'unassigned-pool'],
    queryFn: ({ signal }) => leadsApi.summary({ closed: false, assigned: 'unassigned' }, signal),
    enabled: !!s && !mine,
    retry: false,
    refetchInterval: LIVE_MS,
  });
  const teamQ = useQuery({
    queryKey: ['productivity', 'daily-summary'],
    queryFn: productivityApi.dailySummary,
    enabled: !!s && !mine,
    retry: false,
    refetchInterval: 30_000,
  });
  const team = useMemo(
    () => [...(teamQ.data ?? [])].sort((a, b) => b.callsMade - a.callsMade || b.connected - a.connected || a.name.localeCompare(b.name)),
    [teamQ.data],
  );
  const pool = poolQ.data?.totalLeads ?? 0;

  return (
    <div className="space-y-5">
      {/* Availability toggle + reassigned-work feed */}
      <AvailabilityPanel />

      {/* Page head */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          {/* Says which half of the page the date filter moves. It scopes the
              CARDS only — the widgets below are today's work and a live feed by
              definition, so a historical range has nothing to say to "Today's
              Callbacks" or "Missed Calls". Unlabelled, a filtered page looked
              like one period and was showing two. */}
          <div className="text-[12.5px] text-muted-foreground">
            {dateFilter.from || dateFilter.to
              ? `Cards show the selected date range${prev ? `, with ▲/▼ against the ${prev.days} day${prev.days === 1 ? '' : 's'} before` : ''}. The lists below stay live.`
              : `Live snapshot — ${dateLabel}. Targets refresh nightly.`}
          </div>
          <div className="mt-2"><LiveIndicator updatedAt={summaryQ.dataUpdatedAt} fetching={summaryQ.isFetching} /></div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <DateFilter value={dateFilter} onChange={setDateFilter} iconOnly />
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
              ...(mine ? [] : [['Unassigned Leads', s?.unassignedLeads ?? 0] as [string, number]]),
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
              // "Leads Added Today" used to be exported here from the widget's
              // rows. That query asks for `pageSize: WIDGET_ROWS`, so the figure
              // could never exceed 10 — a spreadsheet reporting 10 on a day that
              // added two hundred. A capped list is fine to look at and not fine
              // to count, and there is no card behind this one to take the real
              // total from.
            ])}
            className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[12.5px] font-semibold hover:bg-muted"
          >
            <Upload className="h-4 w-4" /> Export
          </button>
          <Link href="/calling" className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[12.5px] font-semibold text-primary-foreground shadow-sm hover:opacity-90">
            <PhoneCall className="h-4 w-4" /> Start calling
          </Link>
        </div>
      </div>

      {/* ── My day (employees) ── today's work, each tile opening its list. */}
      {mine && (
        <section>
          <h2 className="mb-2 text-[11.5px] font-semibold uppercase tracking-[.08em] text-muted-foreground">My day</h2>
          <KpiGrid bottom={false}>
            <KpiCard icon={BellRing} iconBg="var(--tone-red-bg)" iconColor="var(--tone-red-fg-2)" value={dueNow.toLocaleString()} label="Callbacks due now" href={links.widgets.callbacks} />
            <KpiCard icon={CalendarCheck} iconBg="var(--tone-blue-bg)" iconColor="var(--tone-blue-fg)" value={(myBookQ.data?.chips?.followUpToday ?? 0).toLocaleString()} label="Follow-ups today" href={links.today.followUpToday} />
            <KpiCard icon={AlarmClock} iconBg="var(--tone-amber-bg)" iconColor="var(--tone-amber-fg)" value={(myBookQ.data?.chips?.followUpOverdue ?? 0).toLocaleString()} label="Overdue follow-ups" href={links.today.followUpOverdue} />
            <KpiCard icon={PhoneOff} iconBg="var(--brand-surface)" iconColor="var(--brand-on-surface)" value={(myBookQ.data?.chips?.neverContacted ?? 0).toLocaleString()} label="Never contacted" href={links.today.neverContacted} />
            <KpiCard
              icon={Phone}
              iconBg="var(--tone-teal-bg)"
              iconColor="var(--tone-teal-fg)"
              value={(myTodayQ.data?.totalCalls ?? 0).toLocaleString()}
              label={`Calls today · ${(myTodayQ.data?.connectedCalls ?? 0).toLocaleString()} connected`}
              href={links.calls}
            />
          </KpiGrid>
        </section>
      )}

      {/* ── Unassigned pool (managers) ── shown only when there's work waiting
          for an owner; the count is now, whatever range the cards are on. */}
      {!mine && pool > 0 && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--tone-amber-line)] bg-[var(--tone-amber-bg)] px-4 py-2.5 text-[12.5px]">
          <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--tone-amber-fg-strong)]" aria-hidden />
          <span className="flex-1 text-[var(--tone-amber-fg-strong)]">
            <b className="font-semibold">{pool.toLocaleString()}</b> lead{pool === 1 ? ' is' : 's are'} waiting to be assigned.
          </span>
          {links.today.unassignedPool && (
            <Link href={links.today.unassignedPool} className="inline-flex items-center gap-1 font-semibold text-[var(--tone-amber-fg-strong)] hover:underline">
              Assign them <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          )}
        </div>
      )}

      {/* ── Lead cards ──
          Labels follow the scope the API reports rather than a role read from
          the client: an employee sees "My …" because the figures behind the
          cards are their own book, and an admin sees the plain title because
          theirs are the organisation's. Nothing here chooses the scope — asking
          the client to would make the label and the number two separate claims. */}
      <section>
        <h2 className="mb-2 text-[11.5px] font-semibold uppercase tracking-[.08em] text-muted-foreground">
          {mine ? 'My Leads' : 'Leads — all employees'}
        </h2>
        <KpiGrid bottom={false}>
          <KpiCard index={0} icon={Target} iconBg="var(--tone-blue-bg)" iconColor="var(--tone-blue-fg)" value={<AnimatedNumber value={s?.totalLeads ?? 0} />} label={card('Total Leads')} href={links.totalLeads} delta={delta(s?.totalLeads, prev?.totalLeads)} />
          {/* The rest of the book. Without it Total 471 sat beside Assigned 181
              with no account of the other 290 — which reads as a number the
              dashboard has lost rather than work not yet handed out. An employee
              holds only assigned leads, so the card would always be 0 for them. */}
          {!mine && (
            <KpiCard index={1} icon={UserPlus} iconBg="var(--tone-amber-bg)" iconColor="var(--tone-amber-fg)" value={<AnimatedNumber value={s?.unassignedLeads ?? 0} />} label="Unassigned Leads" href={links.unassignedLeads} />
          )}
          <KpiCard index={2} icon={Users} iconBg="var(--tone-blue-bg)" iconColor="var(--tone-blue-fg)" value={<AnimatedNumber value={s?.assignedLeads ?? 0} />} label={card('Assigned Leads')} href={links.assignedLeads} />
          {/* Everything from here down is a cut of ASSIGNED, so no card can
              exceed the row above it. They used to be counted across the whole
              book while Contacted was counted inside Assigned, which let an
              admin see more Converted leads than Contacted ones. */}
          <KpiCard index={3} icon={PhoneCall} iconBg="var(--tone-teal-bg)" iconColor="var(--tone-teal-fg)" value={<AnimatedNumber value={s?.contactedLeads ?? 0} />} label={card('Contacted Leads')} href={links.contactedLeads} delta={delta(s?.contactedLeads, prev?.contactedLeads)} />
          {/* Assigned minus contacted — the leads still owed a first conversation.
              This replaced a "Pending Leads" card that measured total minus
              contacted: for an admin that swept in every UNASSIGNED lead, so the
              card counted work nobody had been given as work someone was late on. */}
          <KpiCard index={4} icon={Hourglass} iconBg="var(--tone-amber-bg)" iconColor="var(--tone-amber-fg)" value={<AnimatedNumber value={s?.balanceLeads ?? 0} />} label={card('Balance Leads')} href={links.balanceLeads} />
          <KpiCard index={5} icon={RefreshCw} iconBg="var(--tone-amber-bg)" iconColor="var(--tone-amber-fg)" value={<AnimatedNumber value={s?.followUpLeads ?? 0} />} label={card('Follow-up Leads')} href={links.followUpLeads} />
          <KpiCard index={6} icon={TrendingUp} iconBg="var(--brand-surface-2)" iconColor="var(--brand-on-surface)" value={<AnimatedNumber value={s?.convertedLeads ?? 0} />} label={card('Converted Leads')} delta={delta(s?.convertedLeads, prev?.convertedLeads)} />
          <KpiCard index={7} icon={CheckCircle2} iconBg="var(--brand-surface-2)" iconColor="var(--brand-on-surface)" value={<AnimatedNumber value={s?.closedLeads ?? 0} />} label={card('Onboarding Leads')} href={links.onboardingLeads} delta={delta(s?.closedLeads, prev?.closedLeads)} />
        </KpiGrid>
        {!mine && (
          <TargetProgress total={s?.totalLeads ?? 0} planned={s?.plannedLeads ?? 0} pct={s?.targetProgressPct ?? 0} href={links.targets} />
        )}
        {/* Where leads stall. An employee's book IS their assigned leads, so
            their funnel starts there; a manager's starts at the whole book. */}
        <LeadFunnel
          dimmed={summaryQ.isPlaceholderData}
          stages={[
            ...(mine ? [] : [{ key: 'total', label: 'Total leads', value: s?.totalLeads ?? 0, href: links.totalLeads }]),
            { key: 'assigned', label: 'Assigned', value: s?.assignedLeads ?? 0, href: links.assignedLeads },
            { key: 'contacted', label: 'Contacted', value: s?.contactedLeads ?? 0, href: links.contactedLeads },
            // Interested or onboarding — no single list shows exactly that.
            { key: 'converted', label: 'Converted', value: s?.convertedLeads ?? 0 },
            { key: 'onboarding', label: 'Onboarding', value: s?.closedLeads ?? 0, href: links.onboardingLeads },
          ]}
        />
      </section>

      {/* ── Call cards ── same scope, same rules as the Calls Made dashboard. */}
      <section>
        <h2 className="mb-2 text-[11.5px] font-semibold uppercase tracking-[.08em] text-muted-foreground">
          {mine ? 'My Calls' : 'Calls — all employees'}
        </h2>
        <KpiGrid bottom={false}>
          <KpiCard index={0} icon={Phone} iconBg="var(--tone-blue-bg)" iconColor="var(--tone-blue-fg)" value={<AnimatedNumber value={s?.totalCalls ?? 0} />} label={mine ? 'My Total Calls' : 'Total Calls Made'} href={links.calls} delta={delta(s?.totalCalls, prev?.totalCalls)} />
          <KpiCard index={1} icon={PhoneCall} iconBg="var(--tone-teal-bg)" iconColor="var(--tone-teal-fg)" value={<AnimatedNumber value={s?.connectedCalls ?? 0} />} label={card('Connected Calls')} href={links.calls} delta={delta(s?.connectedCalls, prev?.connectedCalls)} />
          <KpiCard index={2} icon={PhoneMissed} iconBg="var(--tone-red-bg)" iconColor="var(--tone-red-fg-2)" value={<AnimatedNumber value={s?.missedCalls ?? 0} />} label={card('Missed Calls')} href={links.missedCalls} delta={delta(s?.missedCalls, prev?.missedCalls, { upIsGood: false })} />
          <KpiCard index={5} icon={Percent} iconBg="var(--brand-surface)" iconColor="var(--brand-on-surface)" value={<AnimatedNumber value={s?.conversionPct ?? 0} decimals={1} suffix="%" />} label="Conversion Rate" delta={delta(s?.conversionPct, prev?.conversionPct, { kind: 'pts' })} />
        </KpiGrid>
      </section>

      {/* ── Trend ── calls and leads first reached per day, over the dashboard's
          range or the last 14 days. Same scope as the cards. */}
      <section>
        <h2 className="mb-2 text-[11.5px] font-semibold uppercase tracking-[.08em] text-muted-foreground">
          {mine ? 'My activity' : 'Activity — all employees'} · {range.from && range.to ? 'selected range, by day' : 'last 14 days'}
        </h2>
        <TrendChart days={trendQ.data?.days ?? []} dimmed={trendQ.isPlaceholderData} />
      </section>

      {/* ── More metrics ── the less-used cards, folded away so the ones above
          stand out. Open or closed is remembered per browser. They are still in
          the CSV export either way. */}
      <section>
        <button
          type="button"
          onClick={() => setMoreOpen(!moreOpen)}
          aria-expanded={moreOpen}
          className="mb-2 inline-flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[.08em] text-muted-foreground hover:text-foreground"
        >
          More metrics
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${moreOpen ? 'rotate-180' : ''}`} />
        </button>
        {moreOpen && (
          <KpiGrid bottom={false}>
            {/* Only meaningful across a team, so it is absent from an employee's
                dashboard rather than shown as a hollow "1 per employee". */}
            {!mine && s?.avgLeadsPerEmployee !== null && (
              <KpiCard index={8} icon={Users} iconBg="var(--brand-surface)" iconColor="var(--brand-on-surface)" value={<AnimatedNumber value={s?.avgLeadsPerEmployee ?? 0} decimals={1} />} label="Avg Leads / Employee" href={links.perEmployee} />
            )}
            <KpiCard index={3} icon={Video} iconBg="var(--tone-blue-bg)" iconColor="var(--tone-blue-fg)" value={<AnimatedNumber value={s?.scheduledCalls ?? 0} />} label={card('Scheduled Calls')} href={links.meetings} />
            <KpiCard index={4} icon={RefreshCw} iconBg="var(--tone-amber-bg)" iconColor="var(--tone-amber-fg)" value={<AnimatedNumber value={s?.callbackCalls ?? 0} />} label={card('Callback Calls')} href={links.callbacks} />
          </KpiGrid>
        )}
      </section>

      {/* Widget grid — all live */}
      {/* Rendered at once. It faded in after a 0.2s delay, so the widgets — the
          live part of the page — arrived half a second after the dashboard did. */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        {!mine && (
          <div className="min-w-0 xl:col-span-2">
            <WidgetCard title="Team today" columns={teamColumns} rows={team} emptyMessage="No active employees." href={links.teamToday} />
          </div>
        )}
        <WidgetCard
          title="Today's Callbacks"
          columns={callbackColumns}
          rows={todaysCallbacks}
          emptyMessage="No callbacks due today."
          href={links.widgets.callbacks}
        />
        <WidgetCard title="My Open Tasks" columns={taskColumns} rows={openTasks} emptyMessage="No open tasks." href={links.widgets.tasks} />
        <WidgetCard title="Upcoming Follow-Ups" columns={fuColumns} rows={followups} emptyMessage="No follow-ups scheduled." href={links.widgets.followUps} />
        <WidgetCard title="Missed Calls" columns={missedColumns} rows={missed} emptyMessage="No missed calls." href={links.widgets.missedCalls} />
        <WidgetCard title="Today's Leads" columns={leadColumns} rows={todaysLeads} total={todaysLeadsPage?.total} emptyMessage="No leads added today." href={links.widgets.todaysLeads} />
        <WidgetCard title="Recently Closed & Interested" columns={closedColumns} rows={recentClosed} total={recentClosedPage?.total} emptyMessage="No closed leads yet." href={links.widgets.closed} />
      </div>
    </div>
  );
}
