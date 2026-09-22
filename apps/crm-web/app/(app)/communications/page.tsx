'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Clock, MessageSquare, Phone } from 'lucide-react';
import { communicationsApi, formatDuration } from '@/lib/crm';
import { PageHead } from '@/components/page-head';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { DateFilter } from '@/components/filter-controls';
import type { DateFilterValue } from '@/lib/date-filters';

type Period = 'today' | 'week' | 'month' | 'all';

// The picker (same one Lead Management uses) also offers a specific calendar
// day and a Year/custom range — this API only buckets by today/week/month/
// all, so a picked day maps to "today" and Year/custom collapse to "all",
// the broadest bucket it has.
const toPeriod = (mode: DateFilterValue['mode']): Period => {
  if (mode === 'day') return 'today';
  if (mode === 'week' || mode === 'month' || mode === 'all') return mode;
  return 'all';
};

export default function CommunicationsPage() {
  const [dateFilter, setDateFilter] = useState<DateFilterValue>({ mode: 'week', from: '', to: '' });
  const period = toPeriod(dateFilter.mode);
  const { data, isError } = useQuery({
    queryKey: ['comm-analytics', period],
    queryFn: () => communicationsApi.analytics(period),
    retry: false,
  });

  const c = data?.calls;
  const m = data?.messages;

  return (
    <div>
      <PageHead>
        <DateFilter value={dateFilter} onChange={setDateFilter} iconOnly />
      </PageHead>

      {isError && (
        <div className="mb-5 rounded-md bg-[var(--tone-red-bg)] px-4 py-3 text-sm text-[var(--tone-red-fg-2)]">
          Communication analytics are available to admins and team leaders.
        </div>
      )}

      <div className="mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
        <KpiCard icon={Phone} iconBg="var(--brand-surface)" iconColor="var(--brand-on-surface)" value={c?.total ?? 0} label="Total Calls" />
        <KpiCard icon={PhoneIncoming} iconBg="var(--tone-blue-bg)" iconColor="var(--tone-blue-fg)" value={c?.inbound ?? 0} label="Inbound" />
        <KpiCard icon={PhoneOutgoing} iconBg="var(--brand-surface-2)" iconColor="var(--brand-on-surface)" value={c?.outbound ?? 0} label="Outbound" />
        <KpiCard icon={PhoneMissed} iconBg="var(--tone-red-bg)" iconColor="var(--tone-red-fg-2)" value={c?.missed ?? 0} label="Missed" />
        <KpiCard icon={Clock} iconBg="var(--tone-teal-bg)" iconColor="var(--tone-teal-fg)" value={formatDuration(c?.avgDurationSecs ?? 0)} label="Avg Call Time" />
        <KpiCard icon={Clock} iconBg="var(--tone-amber-bg)" iconColor="var(--tone-amber-fg)" value={formatDuration(c?.totalTalkSecs ?? 0)} label="Total Talk Time" />
        <KpiCard icon={MessageSquare} iconBg="var(--brand-surface)" iconColor="var(--brand-on-surface)" value={m?.total ?? 0} label="SMS Total" />
        <KpiCard icon={MessageSquare} iconBg="var(--tone-teal-bg-2)" iconColor="var(--tone-teal-fg)" value={`${m?.inbound ?? 0} / ${m?.outbound ?? 0}`} label="SMS In / Out" />
      </div>

      <div className="rounded-2xl border bg-card p-[18px] shadow-sm">
        <h3 className="mb-4 font-display text-[14px] font-semibold">Activity over time</h3>
        <div className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data?.series ?? []} margin={{ top: 5, right: 12, bottom: 5, left: -10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--brand-edge)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d: string) => d.slice(5)} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="calls" name="Calls" stroke="var(--brand-mid)" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="messages" name="SMS" stroke="var(--tone-blue-fg)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
