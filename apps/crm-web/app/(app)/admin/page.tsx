'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Users, Activity, Database, Import as ImportIcon, Download, Trash2, type LucideIcon } from 'lucide-react';
import { activitiesApi, metricsApi } from '@/lib/crm';
import { api } from '@/lib/api';
import { PageHead } from '@/components/page-head';
import { KpiCard, KpiGrid } from '@/components/dashboard/kpi-card';
import { EmailNotificationSettings } from '@/components/admin/email-notification-settings';
import { OutcomeManagement } from '@/components/admin/outcome-management';
import { CountryManagement } from '@/components/admin/country-management';
import { TimezoneManagement } from '@/components/admin/timezone-management';
import { leadOrViewer } from '@/lib/timezone';

/**
 * Every tile goes somewhere real.
 *
 * This page used to carry a "System Controls" panel — Lead auto-assignment,
 * Idle alerts, Call recording, Daily backups, Maintenance mode — whose switches
 * only flipped on screen: nothing saved them and nothing in the API acted on
 * them, so "Daily backups at 2 AM: on" promised backups the CRM does not take,
 * and "Maintenance mode" locked nobody out. It went, with the "Backup Now" tile
 * and the hard-coded "Uptime 99.98%" and "Security: Healthy" cards. Leads are
 * auto-distributed for real from the Assigned page. "Export Data" did nothing;
 * leads export, at any size, from Lead Library.
 */
const DM: { icon: LucideIcon; t: string; d: string; href: string }[] = [
  { icon: ImportIcon, t: 'Import Leads', d: 'Bulk CSV / Excel upload', href: '/import' },
  { icon: Download, t: 'Export Leads', d: 'CSV / Excel from Lead Library', href: '/lead-library' },
  // Was labelled "AI duplicate detection" and wired to nothing — a tile that
  // promised a feature and did not move when clicked. The screen behind it now
  // exists, and the description says what it actually does: an exact match on
  // phone, email or company domain, with nothing deleted until asked.
  { icon: Trash2, t: 'Purge Duplicates', d: 'Find repeated leads', href: '/duplicates' },
];

export default function AdminPage() {
  const { data: activities = [] } = useQuery({ queryKey: ['activities'], queryFn: activitiesApi.list, retry: false });
  const { data: users = [] } = useQuery<{ id: string; isActive: boolean }[]>({ queryKey: ['users'], queryFn: async () => (await api.get('/users')).data, retry: false });
  const { data: summary } = useQuery({ queryKey: ['metrics', 'summary'], queryFn: () => metricsApi.summary(), retry: false });
  const activeUsers = users.filter((u) => u.isActive).length;

  return (
    <div>

      <KpiGrid>
        <KpiCard icon={Users} iconBg="var(--brand-surface)" iconColor="var(--brand-on-surface)" value={activeUsers || '—'} label="Active Users" />
        <KpiCard icon={Database} iconBg="var(--tone-amber-bg-2)" iconColor="var(--tone-amber-fg)" value={(summary?.totalLeads ?? 0).toLocaleString()} label="Lead Records" />
      </KpiGrid>

      <div>
        <div className="rounded-2xl border bg-card shadow-sm">
          <div className="border-b px-[18px] py-4"><h3 className="font-display text-[14px] font-semibold">Activity Log</h3><div className="text-xs text-muted-foreground">Recent system events</div></div>
          <div className="px-[18px]">
            {activities.slice(0, 6).map((a) => (
              <div key={a.id} className="flex items-center gap-3 border-b py-[11px] last:border-0">
                <div className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] bg-[var(--brand-surface)] text-[var(--brand-on-surface)]"><Activity className="h-4 w-4" /></div>
                <div className="flex-1"><div className="text-[13px]"><b>{a.user?.name ?? 'System'}</b> {a.action.replace('_', ' ')} {a.lead?.businessName ?? ''} {a.newValue ? `→ ${a.newValue}` : ''}</div><div className="text-[11.5px] text-muted-foreground">{leadOrViewer(a.createdAt, a.lead, 'time')}</div></div>
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

      <div className="mt-[18px] grid gap-[18px] lg:grid-cols-2">
        <CountryManagement />
        <TimezoneManagement />
      </div>

      <div className="mt-[18px] rounded-2xl border bg-card shadow-sm">
        <div className="border-b px-[18px] py-4"><h3 className="font-display text-[14px] font-semibold">Data Management</h3></div>
        <div className="grid gap-3.5 p-[18px] sm:grid-cols-3">
          {DM.map((d) => {
            const tile = 'rounded-2xl border bg-card p-5 text-center transition-all hover:-translate-y-0.5 hover:shadow-md';
            const body = (
              <>
                <div className="mx-auto mb-3 grid h-[46px] w-[46px] place-items-center rounded-[12px] bg-[var(--brand-surface)] text-[var(--brand-on-surface)]"><d.icon className="h-[22px] w-[22px]" /></div>
                <div className="font-display text-[13px] font-bold">{d.t}</div>
                <div className="mt-0.5 text-[11.5px] text-muted-foreground">{d.d}</div>
              </>
            );
            // Links: prefetched, and they open in a new tab.
            return <Link key={d.t} href={d.href} className={tile}>{body}</Link>;
          })}
        </div>
      </div>
    </div>
  );
}
