'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { PhoneIncoming, X } from 'lucide-react';
import { communicationsApi, type IncomingCall } from '@/lib/crm';
import { tokenStore } from '@/lib/api';

/**
 * Global incoming-call popup. Polls for the latest inbound call (last 60s) and
 * auto-opens the lead record once Quo reports the call as connected.
 */
export function IncomingCallPopup() {
  const router = useRouter();
  const [active, setActive] = useState<IncomingCall | null>(null);
  const dismissed = useRef<Set<string>>(new Set());
  const autoOpened = useRef<Set<string>>(new Set());

  const { data } = useQuery({
    queryKey: ['incoming-latest'],
    queryFn: communicationsApi.latestIncoming,
    refetchInterval: 3000,
    enabled: typeof window !== 'undefined' && !!tokenStore.access,
    retry: false,
  });

  useEffect(() => {
    if (data && !dismissed.current.has(data.callId)) setActive(data);
  }, [data]);

  // Auto-open the lead record when the inbound call connects.
  useEffect(() => {
    if (!active?.connected || autoOpened.current.has(active.callId)) return;
    autoOpened.current.add(active.callId);
    router.push(`/leads/${active.lead.id}`);
    dismissed.current.add(active.callId);
    setActive(null);
  }, [active, router]);

  if (!active) return null;
  const close = () => { dismissed.current.add(active.callId); setActive(null); };

  return (
    <div className="fixed bottom-5 right-5 z-50 w-[320px] overflow-hidden rounded-2xl border bg-card shadow-2xl">
      <div className="flex items-center gap-2.5 bg-[#266929] px-4 py-3 text-white">
        <PhoneIncoming className="h-4 w-4 animate-pulse" />
        <span className="text-[13px] font-semibold">{active.connected ? 'Call connected' : 'Incoming call'}</span>
        <button onClick={close} className="ml-auto grid h-7 w-7 place-items-center rounded-lg hover:bg-white/10"><X className="h-4 w-4" /></button>
      </div>
      <div className="p-4">
        <div className="text-[15px] font-bold">{active.lead.businessName}</div>
        <div className="font-mono text-[12.5px] text-muted-foreground">{active.lead.phone}</div>
        <div className="mt-0.5 text-[12.5px] text-muted-foreground">{active.lead.city}, {active.lead.state}</div>
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => { router.push(`/leads/${active.lead.id}`); close(); }}
            className="flex-1 rounded-md bg-primary px-3 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90"
          >
            Open record
          </button>
          <button onClick={close} className="rounded-md border bg-card px-3 py-2 text-[13px] font-semibold hover:bg-muted">Dismiss</button>
        </div>
      </div>
    </div>
  );
}
