'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Calendar, Plus, Clock, RefreshCw, CheckCircle2, AlertTriangle, Bell, Phone, Filter, Pencil, CircleCheckBig, Users } from 'lucide-react';
import { callsApi, assignmentsApi, type Followup } from '@/lib/crm';
import { api } from '@/lib/api';
import { useCanCall } from '@/lib/use-can-call';
import { PageHead, Avatar } from '@/components/page-head';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { DateFilter, FilterSelect, SearchInput } from '@/components/filter-controls';
import { DataTable, type ColumnDef } from '@/components/data-table';
import { inDateBounds, EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';
import { dayInLeadZone, formatScheduleInLeadZone } from '@/lib/timezone';
import { callbackStatus, CALLBACK_STATUS_STYLE } from '@/lib/callbacks';
import { CallbackStatusPill } from '@/components/callback-status-pill';
import { pushToast } from '@/lib/toast';

const TIMEFRAME_OPTS = [
  { label: 'All Follow-Ups', value: '' },
  { label: 'Overdue', value: 'overdue' },
  { label: 'Due Now', value: 'due' },
  { label: 'Due Today', value: 'today' },
  { label: 'This Week', value: 'week' },
];

/**
 * A follow-up's due time, stated on the CUSTOMER's clock with the zone named —
 * the same time the rep agreed with them and the same one the reminder emails
 * quote. "Today" is likewise their today: a follow-up can already be tomorrow
 * for the customer while it is still tonight for the rep.
 */
function whenLabel(iso: string, tz?: string | null): { text: string; today: boolean } {
  const now = new Date();
  return { text: formatScheduleInLeadZone(iso, tz), today: dayInLeadZone(iso, tz) === dayInLeadZone(now, tz) };
}

export default function FollowupsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [userId, setUserId] = useState(''); // '' = All Users (manager filter)
  const { data: allFus = [], isLoading, isFetching, isPlaceholderData } = useQuery({
    queryKey: ['followups', userId],
    queryFn: () => callsApi.followups(userId || undefined),
    retry: false,
    // The employee filter is part of the key, so switching rep would otherwise
    // empty the table for the length of a request. Hold the rows and swap them.
    placeholderData: keepPreviousData,
  });
  const isRefreshing = isFetching || isPlaceholderData;
  // Whose follow-ups this page is showing. The API decides: a manager sees the
  // whole floor and may narrow to one rep, an employee sees their own and cannot
  // widen it. The role only tells the page which controls are worth drawing.
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data, retry: false });
  const isManager = me?.role === 'admin' || me?.role === 'team_leader';
  // Caller list powering the User Filter (admin/TL-gated endpoint). Not fetched
  // for an employee: it would 403, and the filter it feeds narrows a list that
  // is already narrowed to them — one dead option under a heading promising
  // otherwise.
  const { data: summary } = useQuery({
    queryKey: ['assignment-summary'],
    queryFn: assignmentsApi.summary,
    enabled: isManager,
    retry: false,
  });
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
  // "Due today" is asked on the customer's calendar, the same way the row's label
  // reads it — otherwise a follow-up shows as "Today" in the table while the Due
  // Today card refuses to count it.
  const isDueToday = (f: Followup) =>
    dayInLeadZone(f.nextFollowupDate, f.lead?.timezone) === dayInLeadZone(now, f.lead?.timezone);
  const withinDays = (f: Followup, days: number) => {
    const diff = (new Date(f.nextFollowupDate).getTime() - now.getTime()) / 86400000;
    return diff >= 0 && diff <= days;
  };
  // Overdue is the shared definition — more than an hour past the scheduled
  // time — not "past, but only if it isn't today". The old rule left a follow-up
  // that was five hours late this morning counted as merely Due Today here while
  // the reminder engine had already e-mailed it as missed.
  const statusOf = (f: Followup) => callbackStatus(f.nextFollowupDate, f.completedAt, now);
  const dueToday = allFus.filter(isDueToday).length;
  const dueNow = allFus.filter((f) => statusOf(f) === 'due').length;
  const overdue = allFus.filter((f) => statusOf(f) === 'overdue').length;
  const thisWeek = allFus.filter((f) => withinDays(f, 7)).length;

  const matchesTimeframe = (f: Followup) => {
    if (timeframe === 'overdue') return statusOf(f) === 'overdue';
    if (timeframe === 'due') return statusOf(f) === 'due';
    if (timeframe === 'today') return isDueToday(f);
    if (timeframe === 'week') return withinDays(f, 7);
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

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['followups'] });
    qc.invalidateQueries({ queryKey: ['callbacks'] });
  };

  async function mutateFollowup(kind: Followup['kind'], id: string, action: 'complete' | 'edit') {
    const current = allFus.find((f) => f.kind === kind && f.id === id);
    try {
      if (action === 'complete') {
        await callsApi.completeFollowup(kind, id);
        pushToast('success', 'Follow-up marked complete.');
        refresh();
        return;
      }
      if (!current) return;
      // The typed time is read in the LEAD's zone by the API, so the prompt says
      // whose clock it is. Rescheduling from the reminder popup gets the proper
      // dual-zone picker; this is the quick path from the list.
      const zone = current.lead?.timezone;
      const next = window.prompt(
        `New follow-up date/time in the lead's time zone${zone ? ` (${zone})` : ''} — e.g. 2026-08-05T10:00`,
        current.nextFollowupDate,
      );
      if (next === null) return;
      const noteText = window.prompt('Follow-up note', current.noteText) ?? current.noteText;
      await callsApi.updateFollowup(kind, id, { followUpAt: next || null, noteText });
      pushToast('success', 'Follow-up updated.');
      refresh();
    } catch (e: unknown) {
      // The API refuses a time already gone in the lead's zone, and a lead with
      // no zone at all. Both are worth showing verbatim — they tell the rep what
      // to do — where before this threw into the console and looked like nothing
      // happened.
      const msg = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
      pushToast('error', (Array.isArray(msg) ? msg[0] : msg) ?? 'Could not update that follow-up.');
    }
  }

  const columns = useMemo<ColumnDef<Followup>[]>(() => [
    {
      key: 'when', header: 'When', required: true,
      render: (f) => {
        const w = whenLabel(f.nextFollowupDate, f.lead?.timezone);
        // The dot now reads from the shared status rather than a local
        // overdue/today guess, so this table and the Dashboard, Calendar and
        // reminder popup can't describe the same appointment differently.
        const s = callbackStatus(f.nextFollowupDate, f.completedAt) ?? 'upcoming';
        return (
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ background: CALLBACK_STATUS_STYLE[s].dot }} />
            <b>{w.text}</b>
          </div>
        );
      },
    },
    {
      key: 'status', header: 'Status',
      render: (f) => <CallbackStatusPill status={callbackStatus(f.nextFollowupDate, f.completedAt)} />,
    },
    { key: 'company', header: 'Company', render: (f) => <div className="flex items-center gap-[10px]"><Avatar name={f.lead?.businessName ?? '—'} /><span className="font-semibold">{f.lead?.businessName ?? '—'}</span></div> },
    { key: 'note', header: 'Note', cellClassName: 'max-w-[280px] truncate text-muted-foreground', render: (f) => f.noteText },
    { key: 'phone', header: 'Phone', cellClassName: 'font-mono text-[11.5px]', render: (f) => f.lead?.phone ?? '—' },
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
        <button onClick={() => router.push('/calendar')} className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[12.5px] font-semibold hover:bg-muted"><Calendar className="h-4 w-4" /> Calendar</button>
        <button onClick={() => router.push('/calling')} className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[12.5px] font-semibold text-primary-foreground hover:opacity-90"><Plus className="h-4 w-4" /> Schedule</button>
      </PageHead>

      <div className="mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        {/* "Due Now" is the one a rep should act on this minute — the hour-long
            window between the scheduled time and the callback counting as
            missed. It had no card, so it was invisible until it was already
            overdue. */}
        <KpiCard icon={Bell} iconBg="var(--tone-amber-bg)" iconColor="var(--tone-amber-fg)" value={dueNow} label="Due Now" />
        <KpiCard icon={Clock} iconBg="var(--tone-red-bg)" iconColor="var(--tone-red-fg-2)" value={dueToday} label="Due Today" />
        <KpiCard icon={RefreshCw} iconBg="var(--tone-amber-bg)" iconColor="var(--tone-amber-fg)" value={thisWeek} label="This Week" />
        <KpiCard icon={CheckCircle2} iconBg="var(--brand-surface-2)" iconColor="var(--brand-on-surface)" value={fus.length} label="Total Scheduled" />
        <KpiCard icon={AlertTriangle} iconBg="var(--tone-red-bg)" iconColor="var(--tone-red-fg-2)" value={overdue} label="Overdue" />
      </div>

      <DataTable
        tableKey="followups"
        columns={columns}
        rows={fus}
        getRowKey={(f) => f.id}
        title="Upcoming Follow-Ups"
        subtitle={`${fus.length} shown`}
        loading={isLoading}
        refreshing={isRefreshing}
        emptyText={allFus.length === 0 ? 'No follow-ups scheduled. Set a follow-up date when saving a call note.' : 'No follow-ups match the current filters.'}
        toolbar={
          <>
            <SearchInput value={q} onChange={setQ} placeholder="Search company, phone, note…" className="min-w-[220px]" />
            {isManager && <FilterSelect icon={Users} value={userId} onChange={setUserId} options={userOpts} />}
            <FilterSelect icon={Filter} value={timeframe} onChange={setTimeframe} options={TIMEFRAME_OPTS} />
            <DateFilter value={created} onChange={setCreated} />
          </>
        }
      />
    </div>
  );
}
