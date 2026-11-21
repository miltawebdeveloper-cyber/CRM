'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, X } from 'lucide-react';
import { configApi, openphoneApi, integrationsApi } from '@/lib/crm';
import { KpiCard, KpiGrid } from '@/components/dashboard/kpi-card';

/**
 * The calling platforms the CRM actually connects to.
 *
 * This page used to be mostly sample data: "1,284 calls synced ▲9%", "1,201
 * recordings", "2,940 contacts", a Call Sync table, a Recordings list and a
 * Contact Sync panel of invented calls and people ("Frank Delgado · Brightline
 * Tax"), with Play, Download, Sync Now and API Keys buttons that did nothing,
 * and Connect buttons for Aircall, RingCentral, JustCall and Dialpad, which the
 * CRM has no integration for. All of that went. What is left is real: OpenPhone
 * (connect, manage, disconnect) and Twilio (status from its environment
 * settings). Real calls and recordings live in Communications.
 */

const BASE_INTEGRATIONS = [
  { nm: 'OpenPhone', logo: 'OP', bg: '#5b5bd6', ds: 'Cloud calling, SMS, call recording & contact/lead sync. Primary dialer for the sales team.', connected: false, meta: 'Not connected' },
  { nm: 'Twilio', logo: 'TW', bg: '#f22f46', ds: 'Programmable voice API for auto-dialer and call queue routing.', connected: false, meta: 'Configure TWILIO_* in .env' },
];

export default function IntegrationsPage() {
  const qc = useQueryClient();
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

  return (
    <div>
      <KpiGrid>
        <KpiCard icon={CheckCircle2} iconBg="var(--brand-surface)" iconColor="var(--brand-on-surface)" value={activeConnections} label="Active Connections" />
      </KpiGrid>

      {/* No tabs: Call Sync, Recordings and Contact Sync were sample data. */}
      <div className="grid gap-3.5 md:grid-cols-2">
        {INTEGRATIONS.map((i) => (
          <div key={i.nm} className="flex items-start gap-3.5 rounded-2xl border bg-card p-[18px] shadow-sm">
            <div className="grid h-[46px] w-[46px] shrink-0 place-items-center rounded-[12px] font-display font-bold text-white" style={{ background: i.bg }}>{i.logo}</div>
            <div className="flex-1">
              <div className="flex items-center gap-2 font-bold">{i.nm} {i.connected && <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--brand-surface)] px-2 py-px text-[10.5px] font-semibold text-[var(--brand-on-surface)]"><span className="h-1.5 w-1.5 rounded-full bg-[var(--brand)]" /> Connected</span>}</div>
              <div className="mt-0.5 max-w-[46ch] text-[12px] text-muted-foreground">{i.ds}</div>
              <div className="mt-[7px] text-[11.5px] text-muted-foreground">{i.meta}</div>
            </div>
            {i.nm === 'OpenPhone' ? (
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <button
                  onClick={() => setConnectOpen(true)}
                  className={`rounded-md px-[15px] py-[9px] text-[12.5px] font-semibold ${i.connected ? 'border bg-card hover:bg-muted' : 'bg-primary text-primary-foreground'}`}
                >
                  {i.connected ? 'Manage' : 'Connect'}
                </button>
                {i.connected && (
                  <button
                    onClick={() => disconnect.mutate()}
                    disabled={disconnect.isPending}
                    className="text-[11px] font-semibold text-[var(--tone-red-fg)] hover:underline disabled:opacity-50"
                  >
                    Disconnect
                  </button>
                )}
              </div>
            ) : null /* Twilio is set up in the server's environment, not here — its status line says so. */}
          </div>
        ))}
      </div>

      {connectOpen && (
        <ConnectModal
          hint={intg?.openphone.apiKeyHint ?? null}
          baseUrl={intg?.openphone.baseUrl ?? ''}
          onClose={() => setConnectOpen(false)}
          onSaved={() => { refresh(); setConnectOpen(false); }}
        />
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
          <h3 className="font-display text-[15px] font-semibold">Connect OpenPhone</h3>
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

          {save.isError && <p className="text-[12.5px] text-[var(--tone-red-fg)]">Could not save. Check the credentials and try again.</p>}
          {save.isSuccess && (save.data as { connected?: boolean })?.connected === false && (
            <p className="text-[12.5px] text-[var(--tone-red-fg)]">Saved, but OpenPhone rejected the key: {(save.data as { error?: string }).error ?? 'verification failed'}.</p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="rounded-md border bg-card px-4 py-2 text-[12.5px] font-semibold hover:bg-muted">Cancel</button>
            <button type="submit" disabled={save.isPending} className="rounded-md bg-primary px-4 py-2 text-[12.5px] font-semibold text-primary-foreground disabled:opacity-60">
              {save.isPending ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </form>
        <p className="mt-3 text-[10.5px] leading-relaxed text-muted-foreground">
          Stored securely on the server (admin only). The key is never shown again — only a masked hint.
        </p>
      </div>
    </div>
  );
}
