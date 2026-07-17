'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Clock, MessageSquare, Phone } from 'lucide-react';
import { communicationsApi, formatDuration } from '@/lib/crm';
import { PageHead } from '@/components/page-head';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { Segmented } from '@/components/segmented';

type Period = 'today' | 'week' | 'month' | 'all';
const PERIODS = [
  { label: 'Today', value: 'today' as Period },
  { label: 'Week', value: 'week' as Period },
  { label: 'Month', value: 'month' as Period },
  { label: 'All', value: 'all' as Period },
];

export default function CommunicationsPage() {
  const [period, setPeriod] = useState<Period>('week');
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
        <Segmented options={PERIODS} value={period} onChange={setPeriod} />
      </PageHead>

      {isError && (
        <div className="mb-5 rounded-md bg-[#fbeeec] px-4 py-3 text-sm text-[#a8431f]">
          Communication analytics are available to admins and team leaders.
        </div>
      )}

      <div className="mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
        <KpiCard icon={Phone} iconBg="#d8eed9" iconColor="#266929" value={c?.total ?? 0} label="Total Calls" />
        <KpiCard icon={PhoneIncoming} iconBg="#e7f0f8" iconColor="#2c5d8f" value={c?.inbound ?? 0} label="Inbound" />
        <KpiCard icon={PhoneOutgoing} iconBg="#e4f2e4" iconColor="#317d34" value={c?.outbound ?? 0} label="Outbound" />
        <KpiCard icon={PhoneMissed} iconBg="#fbeeec" iconColor="#a8431f" value={c?.missed ?? 0} label="Missed" />
        <KpiCard icon={Clock} iconBg="#e3f1ee" iconColor="#2f6f63" value={formatDuration(c?.avgDurationSecs ?? 0)} label="Avg Call Time" />
        <KpiCard icon={Clock} iconBg="#fbf3e2" iconColor="#c98a18" value={formatDuration(c?.totalTalkSecs ?? 0)} label="Total Talk Time" />
        <KpiCard icon={MessageSquare} iconBg="#d8eed9" iconColor="#266929" value={m?.total ?? 0} label="SMS Total" />
        <KpiCard icon={MessageSquare} iconBg="#dff0ec" iconColor="#2f6f63" value={`${m?.inbound ?? 0} / ${m?.outbound ?? 0}`} label="SMS In / Out" />
      </div>

      <div className="rounded-2xl border bg-card p-[18px] shadow-sm">
        <h3 className="mb-4 font-display text-[15px] font-semibold">Activity over time</h3>
        <div className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data?.series ?? []} margin={{ top: 5, right: 12, bottom: 5, left: -10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#d8e8d9" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d: string) => d.slice(5)} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="calls" name="Calls" stroke="#2b732f" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="messages" name="SMS" stroke="#2c5d8f" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
