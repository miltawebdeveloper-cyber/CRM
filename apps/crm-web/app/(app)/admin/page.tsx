'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Users, Activity, Database, ShieldCheck, Upload, Download, Trash2 } from 'lucide-react';
import { activitiesApi, metricsApi } from '@/lib/crm';
import { api } from '@/lib/api';
import { PageHead } from '@/components/page-head';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { EmailNotificationSettings } from '@/components/admin/email-notification-settings';
import { OutcomeManagement } from '@/components/admin/outcome-management';

function Toggle({ on: initial }: { on: boolean }) {
  const [on, setOn] = useState(initial);
  return (
    <button onClick={() => setOn((v) => !v)} className={`relative h-6 w-[42px] shrink-0 rounded-full transition-colors ${on ? 'bg-primary' : 'bg-[#bbd3bc]'}`}>
      <span className={`absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${on ? 'left-[21px]' : 'left-[3px]'}`} />
    </button>
  );
}

const CONTROLS: [string, string, boolean][] = [
  ['Lead auto-assignment', 'Distribute new leads to callers automatically', true],
  ['Idle alerts', 'Notify supervisor after 20 min idle', true],
  ['Call recording', 'Record all outbound calls', true],
  ['Daily backups', 'Automatic database backup at 2 AM EST', true],
  ['Maintenance mode', 'Temporarily disable access for non-admins', false],
];
const DM: { icon: typeof Upload; t: string; d: string; href?: string }[] = [
  { icon: Upload, t: 'Import Leads', d: 'Bulk CSV / Excel upload', href: '/import' },
  { icon: Download, t: 'Export Data', d: 'Download full database' },
  { icon: Database, t: 'Backup Now', d: 'Manual database snapshot' },
  { icon: Trash2, t: 'Purge Duplicates', d: 'AI duplicate detection' },
];

export default function AdminPage() {
  const router = useRouter();
  const { data: activities = [] } = useQuery({ queryKey: ['activities'], queryFn: activitiesApi.list, retry: false });
  const { data: users = [] } = useQuery<{ id: string; isActive: boolean }[]>({ queryKey: ['users'], queryFn: async () => (await api.get('/users')).data, retry: false });
  const { data: summary } = useQuery({ queryKey: ['metrics', 'summary'], queryFn: () => metricsApi.summary(), retry: false });
  const activeUsers = users.filter((u) => u.isActive).length;

  return (
    <div>

      <div className="mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        <KpiCard icon={Users} iconBg="#d8eed9" iconColor="#266929" value={activeUsers || '—'} label="Active Users" />
        <KpiCard icon={Activity} iconBg="#dff0ec" iconColor="#2f6f63" value="99.98%" label="Uptime (30d)" />
        <KpiCard icon={Database} iconBg="#fdecdc" iconColor="#c98a18" value={(summary?.totalLeads ?? 0).toLocaleString()} label="Lead Records" />
        <KpiCard icon={ShieldCheck} iconBg="#d8eed9" iconColor="#266929" value="Healthy" label="Security Status" />
      </div>

      <div className="grid gap-[18px] lg:grid-cols-2">
        <div className="rounded-2xl border bg-card shadow-sm">
          <div className="border-b px-[18px] py-4"><h3 className="font-display text-[15px] font-semibold">System Controls</h3></div>
          <div className="px-[18px]">
            {CONTROLS.map(([t, d, on]) => (
              <div key={t} className="flex items-center justify-between gap-4 border-b py-3.5 last:border-0">
                <div><div className="text-[14px] font-semibold">{t}</div><div className="text-[12.5px] text-muted-foreground">{d}</div></div>
                <Toggle on={on} />
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border bg-card shadow-sm">
          <div className="border-b px-[18px] py-4"><h3 className="font-display text-[15px] font-semibold">Activity Log</h3><div className="text-xs text-muted-foreground">Recent system events</div></div>
          <div className="px-[18px]">
            {activities.slice(0, 6).map((a) => (
              <div key={a.id} className="flex items-center gap-3 border-b py-[11px] last:border-0">
                <div className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] bg-[#d8eed9] text-[#266929]"><Activity className="h-4 w-4" /></div>
                <div className="flex-1"><div className="text-[13.5px]"><b>{a.user?.name ?? 'System'}</b> {a.action.replace('_', ' ')} {a.lead?.businessName ?? ''} {a.newValue ? `→ ${a.newValue}` : ''}</div><div className="text-[12px] text-muted-foreground">{new Date(a.createdAt).toLocaleTimeString()}</div></div>
              </div>
            ))}
            {activities.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No events yet.</p>}
          </div>
        </div>
      </div>

      <div className="mt-[18px] grid gap-[18px] lg:grid-cols-2">
        <EmailNotificationSettings />
        <OutcomeManagement />
      </div>

      <div className="mt-[18px] rounded-2xl border bg-card shadow-sm">
        <div className="border-b px-[18px] py-4"><h3 className="font-display text-[15px] font-semibold">Data Management</h3></div>
        <div className="grid gap-3.5 p-[18px] sm:grid-cols-2 lg:grid-cols-4">
          {DM.map((d) => (
            <button key={d.t} onClick={() => d.href && router.push(d.href)} className="rounded-2xl border bg-card p-5 text-center transition-all hover:-translate-y-0.5 hover:shadow-md">
              <div className="mx-auto mb-3 grid h-[46px] w-[46px] place-items-center rounded-[12px] bg-[#d8eed9] text-[#266929]"><d.icon className="h-[22px] w-[22px]" /></div>
              <div className="font-display text-[14px] font-bold">{d.t}</div>
              <div className="mt-0.5 text-[12px] text-muted-foreground">{d.d}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
