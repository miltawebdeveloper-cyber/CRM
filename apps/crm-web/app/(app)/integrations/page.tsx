'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Phone, Mic, Users, CheckCircle2, KeyRound, RefreshCw, Play, Download, X, Filter } from 'lucide-react';
import { configApi, openphoneApi, integrationsApi } from '@/lib/crm';
import { PageHead, Avatar } from '@/components/page-head';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { DataTable, type ColumnDef } from '@/components/data-table';
import { FilterSelect } from '@/components/filter-controls';

type SyncRow = (typeof SYNC)[number];

const BASE_INTEGRATIONS = [
  { nm: 'OpenPhone', logo: 'OP', bg: '#5b5bd6', ds: 'Cloud calling, SMS, call recording & contact/lead sync. Primary dialer for the sales team.', connected: false, meta: 'Not connected' },
  { nm: 'Twilio', logo: 'TW', bg: '#f22f46', ds: 'Programmable voice API for auto-dialer and call queue routing.', connected: false, meta: 'Configure TWILIO_* in .env' },
  { nm: 'Aircall', logo: 'AC', bg: '#00b388', ds: 'Call center platform with live monitoring and analytics.', connected: false, meta: 'Not connected' },
  { nm: 'RingCentral', logo: 'RC', bg: '#0684bc', ds: 'Enterprise cloud communications and team messaging.', connected: false, meta: 'Not connected' },
  { nm: 'JustCall', logo: 'JC', bg: '#1a6dff', ds: 'Sales dialer with SMS automation and CRM sync.', connected: false, meta: 'Not connected' },
  { nm: 'Dialpad', logo: 'DP', bg: '#7c52ff', ds: 'AI business phone with real-time transcription.', connected: false, meta: 'Not connected' },
];
const SYNC = [
  ['10:42 AM', 'Frank Delgado', 'Brightline Tax', 'OpenPhone', '4m 25s', true],
  ['10:38 AM', 'Della Marsh', 'Summit Bookkeeping', 'OpenPhone', '2m 10s', true],
  ['10:31 AM', 'Lena Cho', 'Cedar CPA Group', 'Twilio', '6m 02s', true],
  ['10:24 AM', 'Chris Vaughn', 'Harbor Financial', 'OpenPhone', '1m 48s', false],
] as const;
const RECS = [
  ['Brightline Tax', 'Frank Delgado', '4m 25s', 'Today 10:42 AM', 'Closed Deal'],
  ['Cedar CPA Group', 'Lena Cho', '6m 02s', 'Today 10:31 AM', 'Interested'],
  ['Summit Bookkeeping', 'Della Marsh', '2m 10s', 'Today 10:38 AM', 'Callback'],
] as const;

const TABS = ['Connections', 'Call Sync', 'Recordings', 'Contact Sync'] as const;
type Tab = (typeof TABS)[number];

export default function IntegrationsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('Connections');
  const [syncStatus, setSyncStatus] = useState('');
  const [connectOpen, setConnectOpen] = useState(false);
  const { data: cfg } = useQuery({ queryKey: ['config-status'], queryFn: configApi.status, retry: false });
  const { data: intg } = useQuery({ queryKey: ['integrations-status'], queryFn: integrationsApi.status, retry: false });
  // Live OpenPhone probe (lists workspace numbers) for the connected number count.
  const { data: op } = useQuery({ queryKey: ['openphone-status'], queryFn: openphoneApi.status, retry: false });

  // Connection state reflects DB-stored credentials applied at runtime.
  const INTEGRATIONS = BASE_INTEGRATIONS.map((i) => {
    if (i.nm === 'Twilio') {
      const on = cfg?.calling.configured ?? false;
      return { ...i, connected: on, meta: on ? 'Connected · live credentials' : i.meta };
    }
    if (i.nm === 'OpenPhone') {
      const on = intg?.openphone.configured ?? false;
      return {
        ...i,
        connected: on,
        meta: on ? `Connected · ${op?.phoneNumbers.length ?? 0} number(s)` : 'Sandbox mode · click Connect to add your API key',
      };
    }
    return i;
  });
  const activeConnections = INTEGRATIONS.filter((i) => i.connected).length;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['integrations-status'] });
    qc.invalidateQueries({ queryKey: ['config-status'] });
    qc.invalidateQueries({ queryKey: ['openphone-status'] });
  };
  const disconnect = useMutation({
    mutationFn: () => integrationsApi.disconnect('openphone'),
    onSuccess: refresh,
  });

  const syncColumns = useMemo<ColumnDef<SyncRow>[]>(() => [
    { key: 'time', header: 'Time', required: true, cellClassName: 'font-mono text-[12px]', render: (r) => r[0] },
    { key: 'caller', header: 'Caller', render: (r) => <div className="flex items-center gap-[10px]"><Avatar name={r[1]} /><span className="font-semibold">{r[1]}</span></div> },
    { key: 'lead', header: 'Lead', render: (r) => r[2] },
    { key: 'source', header: 'Source', render: (r) => <span className="rounded bg-muted px-2 py-0.5 text-[11.5px] font-semibold">{r[3]}</span> },
    { key: 'duration', header: 'Duration', cellClassName: 'font-mono', render: (r) => r[4] },
    { key: 'status', header: 'Status', render: (r) => r[5] ? <span className="inline-flex items-center gap-1.5 rounded-full bg-[#d8eed9] px-2.5 py-[3px] text-[11.5px] font-semibold text-[#266929]"><span className="h-1.5 w-1.5 rounded-full bg-[#266929]" /> Synced</span> : <span className="inline-flex items-center gap-1.5 rounded-full bg-[#e7f0f8] px-2.5 py-[3px] text-[11.5px] font-semibold text-[#2c5d8f]"><span className="h-1.5 w-1.5 rounded-full bg-[#2c5d8f]" /> Syncing…</span> },
  ], []);
  const syncRows = (SYNC as unknown as SyncRow[]).filter((r) => !syncStatus || (syncStatus === 'synced' ? !!r[5] : !r[5]));

  return (
    <div>
      <PageHead>
        <button className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[13px] font-semibold hover:bg-muted"><KeyRound className="h-4 w-4" /> API Keys</button>
      </PageHead>

      <div className="mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        <KpiCard icon={Phone} iconBg="#d8eed9" iconColor="#266929" value="1,284" label="Calls Synced (30d)" trend="9%" trendDir="up" />
        <KpiCard icon={Mic} iconBg="#fdecdc" iconColor="#c98a18" value="1,201" label="Recordings Stored" />
        <KpiCard icon={Users} iconBg="#dff0ec" iconColor="#2f6f63" value="2,940" label="Contacts Synced" />
        <KpiCard icon={CheckCircle2} iconBg="#d8eed9" iconColor="#266929" value={activeConnections} label="Active Connections" />
      </div>

      <div className="mb-[18px] flex gap-1 overflow-x-auto border-b">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`whitespace-nowrap border-b-2 px-4 py-[11px] text-[13.5px] font-semibold ${tab === t ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-primary'}`}>{t}</button>
        ))}
      </div>

      {tab === 'Connections' && (
        <div className="grid gap-3.5 md:grid-cols-2">
          {INTEGRATIONS.map((i) => (
            <div key={i.nm} className="flex items-start gap-3.5 rounded-2xl border bg-card p-[18px] shadow-sm">
              <div className="grid h-[46px] w-[46px] shrink-0 place-items-center rounded-[12px] font-display font-bold text-white" style={{ background: i.bg }}>{i.logo}</div>
              <div className="flex-1">
                <div className="flex items-center gap-2 font-bold">{i.nm} {i.connected && <span className="inline-flex items-center gap-1.5 rounded-full bg-[#d8eed9] px-2 py-px text-[11px] font-semibold text-[#266929]"><span className="h-1.5 w-1.5 rounded-full bg-[#266929]" /> Connected</span>}</div>
                <div className="mt-0.5 max-w-[46ch] text-[12.5px] text-muted-foreground">{i.ds}</div>
                <div className="mt-[7px] text-[12px] text-muted-foreground">{i.meta}</div>
              </div>
              {i.nm === 'OpenPhone' ? (
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <button
                    onClick={() => setConnectOpen(true)}
                    className={`rounded-md px-[15px] py-[9px] text-[13px] font-semibold ${i.connected ? 'border bg-card hover:bg-muted' : 'bg-primary text-primary-foreground'}`}
                  >
                    {i.connected ? 'Manage' : 'Connect'}
                  </button>
                  {i.connected && (
                    <button
                      onClick={() => disconnect.mutate()}
                      disabled={disconnect.isPending}
                      className="text-[11.5px] font-semibold text-[#9e2b21] hover:underline disabled:opacity-50"
                    >
                      Disconnect
                    </button>
                  )}
                </div>
              ) : (
                <button className={`shrink-0 rounded-md px-[15px] py-[9px] text-[13px] font-semibold ${i.connected ? 'border bg-card hover:bg-muted' : 'bg-primary text-primary-foreground'}`}>{i.connected ? 'Manage' : 'Connect'}</button>
              )}
            </div>
          ))}
        </div>
      )}

      {connectOpen && (
        <ConnectModal
          hint={intg?.openphone.apiKeyHint ?? null}
          baseUrl={intg?.openphone.baseUrl ?? ''}
          onClose={() => setConnectOpen(false)}
          onSaved={() => { refresh(); setConnectOpen(false); }}
        />
      )}

      {tab === 'Call Sync' && (
        <DataTable
          tableKey="integrations-callsync"
          columns={syncColumns}
          rows={syncRows}
          getRowKey={(r) => r[0]}
          title="Call Sync Dashboard"
          subtitle="Live sync from connected dialers"
          emptyText="No synced calls."
          toolbar={
            <>
              <FilterSelect
                icon={Filter}
                value={syncStatus}
                onChange={setSyncStatus}
                options={[
                  { label: 'All Statuses', value: '' },
                  { label: 'Synced', value: 'synced' },
                  { label: 'Syncing', value: 'syncing' },
                ]}
              />
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#d8eed9] px-2.5 py-[3px] text-[11.5px] font-semibold text-[#266929]"><span className="h-1.5 w-1.5 rounded-full bg-[#266929]" /> Auto-sync on</span>
            </>
          }
        />
      )}

      {tab === 'Recordings' && (
        <div className="rounded-2xl border bg-card shadow-sm">
          <div className="border-b px-[18px] py-4"><h3 className="font-display text-[15px] font-semibold">Call Recording Management</h3><div className="text-xs text-muted-foreground">Access-controlled — Admin &amp; Team Leader only</div></div>
          <div className="p-[18px]">
            {RECS.map((r) => (
              <div key={r[0]} className="flex items-center gap-3.5 border-b py-3.5 last:border-0">
                <button className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"><Play className="ml-0.5 h-4 w-4" /></button>
                <div className="flex-1">
                  <div className="text-[13.5px] font-semibold">{r[0]} <span className="text-[12px] text-muted-foreground">· {r[1]}</span></div>
                  <div className="mt-1.5 flex h-[26px] items-center gap-0.5">{Array.from({ length: 42 }).map((_, i) => <i key={i} className="flex-1 rounded-[2px] bg-[#a6c74d]" style={{ height: `${20 + ((i * 37) % 80)}%` }} />)}</div>
                </div>
                <div className="shrink-0 text-right"><div className="font-mono text-[13px] font-semibold">{r[2]}</div><div className="text-[12px] text-muted-foreground">{r[3]}</div></div>
                <span className="rounded bg-muted px-2 py-0.5 text-[11.5px] font-semibold">{r[4]}</span>
                <button className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted"><Download className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'Contact Sync' && (
        <div className="rounded-2xl border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b px-[18px] py-4"><div><h3 className="font-display text-[15px] font-semibold">Contact Sync</h3><div className="text-xs text-muted-foreground">Two-way sync between CRM and platforms</div></div><button className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[13px] font-semibold text-primary-foreground"><RefreshCw className="h-4 w-4" /> Sync Now</button></div>
          <div className="p-[18px]">
            <div className="grid grid-cols-2 gap-[18px] border-b pb-5 sm:grid-cols-4">
              {[['2,940', 'Total Contacts'], ['2,940', 'In Sync'], ['0', 'Conflicts'], ['2 min ago', 'Last Sync']].map(([v, l]) => <div key={l}><div className="font-display text-[24px] font-semibold">{v}</div><div className="text-[12px] text-muted-foreground">{l}</div></div>)}
            </div>
            <div className="flex items-center justify-center gap-[30px] py-3.5">
              <div className="text-center"><div className="mx-auto mb-2.5 grid h-[58px] w-[58px] place-items-center rounded-[15px] bg-[#266929] font-display text-[17px] font-bold text-white">CRM</div><b className="block text-[14px]">Ranger CRM</b><span className="text-[12px] text-muted-foreground">2,940 contacts</span></div>
              <div className="text-center text-[#2b732f]"><RefreshCw className="mx-auto mb-1 h-[30px] w-[30px]" /><span className="text-[12px] text-muted-foreground">Two-way · auto</span></div>
              <div className="text-center"><div className="mx-auto mb-2.5 grid h-[58px] w-[58px] place-items-center rounded-[15px] font-display text-[17px] font-bold text-white" style={{ background: '#5b5bd6' }}>OP</div><b className="block text-[14px]">OpenPhone</b><span className="text-[12px] text-muted-foreground">2,940 contacts</span></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectModal({
  hint,
  baseUrl,
  onClose,
  onSaved,
}: {
  hint: string | null;
  baseUrl: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [url, setUrl] = useState(baseUrl || 'https://api.openphone.com/v1');
  const [webhookSecret, setWebhookSecret] = useState('');

  const save = useMutation({
    mutationFn: () => integrationsApi.connectOpenPhone(apiKey, url, webhookSecret || undefined),
    onSuccess: (res: { connected?: boolean; error?: string | null }) => {
      // OpenPhone returns a live probe result; only close if it actually connected.
      if (res && res.connected === false) return;
      onSaved();
    },
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border bg-card p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-display text-[16px] font-semibold">Connect OpenPhone</h3>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); save.mutate(); }}
          className="space-y-3"
        >
          <label className="block space-y-1 text-sm">
            <span className="font-medium">API Key</span>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required placeholder={hint ? `Saved (${hint}) — enter to replace` : 'Paste API key'} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">API Base URL <span className="text-muted-foreground">(optional)</span></span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Webhook Secret <span className="text-muted-foreground">(optional)</span></span>
            <input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder="For verifying inbound webhooks" className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          </label>

          {save.isError && <p className="text-[13px] text-[#9e2b21]">Could not save. Check the credentials and try again.</p>}
          {save.isSuccess && (save.data as { connected?: boolean })?.connected === false && (
            <p className="text-[13px] text-[#9e2b21]">Saved, but OpenPhone rejected the key: {(save.data as { error?: string }).error ?? 'verification failed'}.</p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="rounded-md border bg-card px-4 py-2 text-[13px] font-semibold hover:bg-muted">Cancel</button>
            <button type="submit" disabled={save.isPending} className="rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground disabled:opacity-60">
              {save.isPending ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </form>
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          Stored securely on the server (admin only). The key is never shown again — only a masked hint.
        </p>
      </div>
    </div>
  );
}
