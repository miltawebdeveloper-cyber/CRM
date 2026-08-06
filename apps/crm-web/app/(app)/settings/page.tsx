'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { configApi } from '@/lib/crm';
import { PageHead, Avatar } from '@/components/page-head';
import { AuthenticationSettings } from '@/components/authentication-settings';
import { TrustedDevices } from '@/components/trusted-devices';
import { CallingModeSettings } from '@/components/calling-mode-settings';
import { DisplayPreferences } from '@/components/display-preferences';
import { useDisplaySettings } from '@/components/display-settings-provider';
import { LANGUAGES, timezoneLabel } from '@/lib/display-settings';

function Toggle({ on: initial }: { on: boolean }) {
  const [on, setOn] = useState(initial);
  return (
    <button onClick={() => setOn((v) => !v)} className={`relative h-6 w-[42px] shrink-0 rounded-full transition-colors ${on ? 'bg-primary' : 'bg-[var(--brand-line)]'}`}>
      <span className={`absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${on ? 'left-[21px]' : 'left-[3px]'}`} />
    </button>
  );
}

function Field({ label, value, type = 'text' }: { label: string; value?: string; type?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-semibold">{label}</span>
      <input type={type} defaultValue={value} className="rounded-[10px] border bg-background px-3 py-2.5 text-[13px] outline-none focus:border-primary" />
    </label>
  );
}

function Row({ t, d, on }: { t: string; d: string; on: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-3.5 last:border-0">
      <div><div className="text-[13px] font-semibold">{t}</div><div className="text-[12px] text-muted-foreground">{d}</div></div>
      <Toggle on={on} />
    </div>
  );
}

// Preferences sits second, right after Profile: it is the tab every role has a
// reason to open, and the only one whose settings change what every other screen
// looks like.
const TABS = ['Profile', 'Preferences', 'Notifications', 'Calling', 'Security', 'API & Keys'] as const;
type Tab = (typeof TABS)[number];

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('Profile');
  const { language } = useDisplaySettings();
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data, retry: false });
  const { data: cfg } = useQuery({ queryKey: ['config-status'], queryFn: configApi.status, retry: false });
  const name = me?.name ?? me?.email?.split('@')[0] ?? 'User';

  return (
    <div>

      <div className="mb-[18px] flex gap-1 overflow-x-auto border-b">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`whitespace-nowrap border-b-2 px-4 py-[11px] text-[13px] font-semibold ${tab === t ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-primary'}`}>{t}</button>
        ))}
      </div>

      {tab === 'Profile' && (
        <div className="max-w-[760px] rounded-2xl border bg-card p-[18px] shadow-sm">
          <div className="flex items-center gap-[18px]">
            <Avatar name={name} size="lg" />
            <div><div className="font-display text-[17px] font-semibold capitalize">{name}</div><div className="text-[12.5px] capitalize text-muted-foreground">{(me?.role ?? '').replace('_', ' ')}</div>
              <button className="mt-2 rounded-md border bg-card px-3 py-1.5 text-[12px] font-semibold hover:bg-muted">Change Photo</button></div>
          </div>
          <div className="mt-[22px] grid gap-3.5 sm:grid-cols-2">
            <Field label="Full Name" value={me?.name ?? ''} />
            <Field label="Email" value={me?.email ?? ''} />
            <Field label="Phone" value="" />
            {/* The time-zone control that used to sit here was a decorative
                EST/CST/MST/PST dropdown wired to nothing — and it listed LEAD
                zones, which are a different thing entirely. The real, saved
                setting lives on the Preferences tab. */}
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-semibold">Time Zone &amp; Language</span>
              <button
                onClick={() => setTab('Preferences')}
                className="rounded-[10px] border bg-background px-3 py-2.5 text-left text-[13px] hover:bg-muted"
              >
                {timezoneLabel()} · {LANGUAGES.find((l) => l.value === language)?.label ?? 'English'}
                <span className="ml-1 text-muted-foreground">— change in Preferences</span>
              </button>
            </label>
          </div>
          <div className="mt-[22px] flex justify-end gap-2.5"><button className="rounded-md border bg-card px-[15px] py-[9px] text-[12.5px] font-semibold hover:bg-muted">Cancel</button><button className="rounded-md bg-primary px-[15px] py-[9px] text-[12.5px] font-semibold text-primary-foreground">Save Changes</button></div>
        </div>
      )}

      {/* Every role: time zone and language are personal, not privileged. */}
      {tab === 'Preferences' && <DisplayPreferences />}

      {tab === 'Notifications' && (
        <div className="max-w-[760px] rounded-2xl border bg-card p-[18px] shadow-sm">
          {[['Follow-up reminders', 'Get notified when a callback is due', true], ['New lead assignments', 'Alert when leads are assigned to you', true], ['Deal closed', 'Celebrate when you close a deal', true], ['Team announcements', 'Updates from your team leader', true], ['Idle warnings', 'Reminder after 20 min of inactivity', false], ['Daily summary email', 'End-of-day performance recap', true], ['Desktop push', 'Browser notifications', false]].map((r) => <Row key={r[0] as string} t={r[0] as string} d={r[1] as string} on={r[2] as boolean} />)}
        </div>
      )}

      {tab === 'Calling' && (
        <div className="max-w-[760px] space-y-[18px]">
        {/* Admin-only: the CRM-wide calling on/off switch. */}
        {me?.role === 'admin' && <CallingModeSettings />}
        <div className="rounded-2xl border bg-card p-[18px] shadow-sm">
          {[['Auto next lead', 'Open the next lead automatically after a call ends', true], ['Auto-dialer', 'Automatically dial without manual start', false], ['Call recording', 'Record your outbound calls', true], ['Click-to-call', 'Dial by clicking a phone number anywhere', true]].map((r) => <Row key={r[0] as string} t={r[0] as string} d={r[1] as string} on={r[2] as boolean} />)}
          <div className="mt-[18px] grid gap-3.5 sm:grid-cols-2"><Field label="Caller ID" value="" /><label className="flex flex-col gap-1.5"><span className="text-[12px] font-semibold">Wrap-up time</span><select className="rounded-[10px] border bg-background px-3 py-2.5 text-[13px]"><option>15 seconds</option><option>30 seconds</option><option>60 seconds</option></select></label></div>
          <div className="mt-[22px] flex justify-end"><button className="rounded-md bg-primary px-[15px] py-[9px] text-[12.5px] font-semibold text-primary-foreground">Save Changes</button></div>
        </div>
        </div>
      )}

      {tab === 'Security' && (
        <div className="space-y-[18px]">
          <div className="max-w-[760px] space-y-[18px]">
            <div className="rounded-2xl border bg-card p-[18px] shadow-sm">
              <div className="grid gap-3.5 sm:grid-cols-2"><div className="sm:col-span-2"><Field label="Current Password" type="password" value="" /></div><Field label="New Password" type="password" /><Field label="Confirm Password" type="password" /></div>
              <div className="mt-[18px]"><Row t="Two-Factor Authentication" d="Add an extra layer of security with 2FA" on={true} /><Row t="Login alerts" d="Email me about new sign-ins" on={true} /></div>
              <div className="mt-[22px] flex justify-end"><button className="rounded-md bg-primary px-[15px] py-[9px] text-[12.5px] font-semibold text-primary-foreground">Update Password</button></div>
            </div>
            {/* Admin-only: the login OTP policy. */}
            {me?.role === 'admin' && <AuthenticationSettings />}
          </div>

          {/* Own devices for everyone; admins also get the all-users register. */}
          <TrustedDevices scope="mine" />
          {me?.role === 'admin' && <TrustedDevices scope="all" />}
        </div>
      )}

      {tab === 'API & Keys' && (
        <div className="max-w-[760px] rounded-2xl border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b px-[18px] py-4"><div><h3 className="font-display text-[14px] font-semibold">API Keys & Integrations</h3><div className="text-xs text-muted-foreground">Live status from your environment</div></div><button className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground"><Plus className="h-3.5 w-3.5" /> Generate Key</button></div>
          <div className="p-[18px]">
            {cfg && [['Database', cfg.database.provider, cfg.database.configured], ['Redis', 'Cache / queues', cfg.redis.configured], ['Calling Provider', cfg.calling.provider, cfg.calling.configured], ['AI Provider', `${cfg.ai.provider}${cfg.ai.model ? ` · ${cfg.ai.model}` : ''}`, cfg.ai.configured], ['Lead Sync (OpenPhone)', cfg.quo.sandbox ? 'Sandbox mode' : 'Live', cfg.quo.configured], ['Object Storage', cfg.storage.provider, cfg.storage.configured]].map((k) => (
              <div key={k[0] as string} className="flex items-center gap-3.5 border-b py-3.5 last:border-0">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><KeyRound className="h-4 w-4" /></div>
                <div className="flex-1"><div className="text-[13px] font-semibold">{k[0] as string}</div><div className="text-[11.5px] text-muted-foreground">{k[1] as string}</div></div>
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11px] font-semibold ${k[2] ? 'bg-[var(--brand-tint)] text-[var(--brand)]' : 'bg-muted text-muted-foreground'}`}><span className="h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor' }} />{k[2] ? 'Configured' : 'Not set'}</span>
              </div>
            ))}
            {!cfg && <p className="py-6 text-center text-sm text-muted-foreground">Loading status (admin role required)…</p>}
          </div>
        </div>
      )}
    </div>
  );
}
