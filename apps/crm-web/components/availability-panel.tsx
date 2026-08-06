'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Circle, Power, Phone, PhoneForwarded, Clock, Video, SquareKanban, ArrowRightLeft, X } from 'lucide-react';
import { availabilityApi, REASSIGN_LABEL, OFFLINE_REASONS, type ReassignType } from '@/lib/availability';
import { formatDateTime } from '@/lib/display-settings';

const TYPE_ICON: Record<ReassignType, typeof Phone> = {
  call: Phone,
  callback: PhoneForwarded,
  followup: Clock,
  zoom: Video,
  task: SquareKanban,
};
const fmt = (iso: string | null) =>
  iso ? formatDateTime(iso) : '—';

export function AvailabilityPanel() {
  const qc = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data: status } = useQuery({ queryKey: ['availability'], queryFn: availabilityApi.status, retry: false });
  const { data: inbox = [] } = useQuery({ queryKey: ['availability-inbox'], queryFn: availabilityApi.inbox, retry: false });

  const online = (status?.availability ?? 'online') === 'online';
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['availability'] });
    qc.invalidateQueries({ queryKey: ['availability-inbox'] });
    // The queue and follow-ups are NOT refreshed here any more: going offline is
    // purely a status change now, so it cannot have moved a single lead.
  };

  async function goOffline(reason: string) {
    setBusy(true);
    try { await availabilityApi.setOffline(reason); setPicking(false); refresh(); } finally { setBusy(false); }
  }
  async function goOnline() {
    setBusy(true);
    try { await availabilityApi.setOnline(); refresh(); } finally { setBusy(false); }
  }
  async function dismiss(id: string) {
    await availabilityApi.ack(id);
    qc.invalidateQueries({ queryKey: ['availability-inbox'] });
  }

  return (
    <div className="space-y-4">
      {/* Availability control */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border bg-card p-4 shadow-sm">
        <span className="inline-flex items-center gap-2 text-[12.5px] font-semibold">
          <Circle className={`h-2.5 w-2.5 ${online ? 'fill-[var(--brand-strong)] text-[var(--brand-strong)]' : 'fill-[var(--tone-red-fg)] text-[var(--tone-red-fg)]'}`} />
          {online ? 'Online' : `Offline${status?.reason ? ` · ${status.reason}` : ''}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {online ? (
            picking ? (
              <>
                {OFFLINE_REASONS.map((r) => (
                  <button key={r} disabled={busy} onClick={() => goOffline(r)} className="rounded-md border px-3 py-1.5 text-[12px] font-semibold hover:bg-muted disabled:opacity-50">{r}</button>
                ))}
                <button onClick={() => setPicking(false)} className="rounded-md p-1.5 hover:bg-muted"><X className="h-4 w-4" /></button>
              </>
            ) : (
              <button onClick={() => setPicking(true)} className="inline-flex items-center gap-2 rounded-md border border-[var(--tone-red-line)] px-3 py-1.5 text-[12px] font-semibold text-[var(--tone-red-fg)] hover:bg-[var(--tone-red-bg)]">
                <Power className="h-3.5 w-3.5" /> Mark Offline
              </button>
            )
          ) : (
            <button disabled={busy} onClick={goOnline} className="inline-flex items-center gap-2 rounded-md bg-[var(--brand-strong)] px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50">
              <Power className="h-3.5 w-3.5" /> Go Online
            </button>
          )}
        </div>
      </div>

      {/* Reassigned-to-me feed — history only. Automatic reassignment was removed,
          so nothing new lands here; the block self-hides once the feed is empty. */}
      {inbox.length > 0 && (
        <div className="rounded-2xl border bg-card shadow-sm">
          <div className="flex items-center gap-2 border-b px-[18px] py-3.5">
            <ArrowRightLeft className="h-4 w-4 text-[var(--tone-amber-fg)]" />
            <h3 className="font-display text-[14px] font-semibold">Reassigned to You</h3>
            <span className="ml-auto text-xs text-muted-foreground">{inbox.filter((i) => !i.acknowledged).length} new</span>
          </div>
          <div className="max-h-[420px] divide-y overflow-y-auto">
            {inbox.map((r) => {
              const Icon = TYPE_ICON[r.type];
              return (
                <div key={r.id} className={`flex items-center gap-3 px-[18px] py-3 ${r.acknowledged ? 'opacity-60' : 'bg-[#fdfaf2]'}`}>
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-[var(--tone-amber-bg)] text-[var(--tone-amber-fg)]"><Icon className="h-[18px] w-[18px]" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-semibold">
                      {REASSIGN_LABEL[r.type]} reassigned from {r.fromUserName}
                    </div>
                    <div className="truncate text-[11.5px] text-muted-foreground">
                      {r.clientName ?? '—'} · {fmt(r.scheduledAt)} · <span className="font-medium text-[var(--tone-red-fg-2)]">{r.reason}</span>
                    </div>
                  </div>
                  {!r.acknowledged && (
                    <button onClick={() => dismiss(r.id)} title="Dismiss" className="shrink-0 rounded-md border px-2.5 py-1 text-[11.5px] font-semibold hover:bg-muted">Got it</button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
