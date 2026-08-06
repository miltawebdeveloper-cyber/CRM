'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Headphones, Phone, Clock, Percent, Filter } from 'lucide-react';
import { productivityApi, formatDuration } from '@/lib/crm';
import { PageHead, Avatar } from '@/components/page-head';
import { StatusPill } from '@/components/status-pill';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { FilterSelect, SearchInput } from '@/components/filter-controls';

const PRESENCE_OPTS = [
  { label: 'All Statuses', value: '' },
  { label: 'On Call', value: 'On Call' },
  { label: 'Idle', value: 'Idle' },
];

export default function ManagerPage() {
  const { data: live } = useQuery({ queryKey: ['team-live'], queryFn: () => productivityApi.teamLive(), refetchInterval: 10_000 });
  const { data: callers = [] } = useQuery({ queryKey: ['productivity'], queryFn: () => productivityApi.perCaller(), refetchInterval: 10_000 });
  const [presence, setPresence] = useState('');
  const [q, setQ] = useState('');

  const statusOf = (id: string) => live?.team.find((t) => t.id === id)?.status ?? 'Idle';
  const onCall = live?.team.filter((t) => t.status === 'On Call').length ?? 0;
  const k = live?.kpis;

  const term = q.trim().toLowerCase();
  const shown = callers.filter(
    (c) =>
      (!presence || statusOf(c.id) === presence) &&
      (!term || c.name.toLowerCase().includes(term) || (c.email ?? '').toLowerCase().includes(term)),
  );

  return (
    <div>
      <PageHead>
        <SearchInput value={q} onChange={setQ} placeholder="Search caller…" className="min-w-[200px]" />
        <FilterSelect icon={Filter} value={presence} onChange={setPresence} options={PRESENCE_OPTS} />
        <StatusPill status="On Call" kind="presence" />
        <span className="text-[12.5px] font-semibold text-muted-foreground">{onCall} active now</span>
      </PageHead>

      <div className="mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        <KpiCard icon={Headphones} iconBg="var(--brand-tint-2)" iconColor="var(--brand-strong)" value={onCall} label="On Call" />
        <KpiCard icon={Phone} iconBg="var(--brand-tint)" iconColor="var(--brand)" value={k?.totalCallsToday ?? 0} label="Calls Today" />
        <KpiCard icon={Clock} iconBg="#e3f1ee" iconColor="#2f6f63" value={formatDuration(k?.totalTalkSecs ?? 0)} label="Talk Time Today" />
        <KpiCard icon={Percent} iconBg="#fdf1de" iconColor="#c98a18" value={`${k?.conversionRate ?? 0}%`} label="Conversion Rate" />
      </div>

      <div className="grid gap-[18px] md:grid-cols-2 xl:grid-cols-3">
        {shown.map((c) => {
          const status = statusOf(c.id);
          const talkH = (c.productiveSecs / 3600).toFixed(1);
          return (
            <div key={c.id} className="rounded-2xl border bg-card p-[18px] shadow-sm">
              <div className="mb-[14px] flex items-center gap-3">
                <Avatar name={c.name} size="lg" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-bold">{c.name}</div>
                  <div className="truncate text-[12px] text-muted-foreground">{c.email}</div>
                </div>
                <StatusPill status={status} kind="presence" />
              </div>
              <div className="grid grid-cols-2 gap-2.5 text-center">
                <div className="rounded-[10px] bg-background p-2.5"><div className="font-display text-[16px] font-semibold">{c.callsToday}</div><div className="text-[10.5px] text-muted-foreground">Calls</div></div>
                <div className="rounded-[10px] bg-background p-2.5"><div className="font-display text-[16px] font-semibold text-primary">{c.leadsCompleted}</div><div className="text-[10.5px] text-muted-foreground">Completed</div></div>
                <div className="rounded-[10px] bg-background p-2.5"><div className="font-display text-[16px] font-semibold">{talkH}h</div><div className="text-[10.5px] text-muted-foreground">Talk</div></div>
                <div className="rounded-[10px] bg-background p-2.5"><div className="font-display text-[16px] font-semibold">{c.conversionPct}%</div><div className="text-[10.5px] text-muted-foreground">Conversion</div></div>
              </div>
            </div>
          );
        })}
        {shown.length === 0 && <p className="text-sm text-muted-foreground">{callers.length === 0 ? 'Loading team…' : 'No callers match the current filters.'}</p>}
      </div>
    </div>
  );
}
