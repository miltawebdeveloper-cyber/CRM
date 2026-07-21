'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PhoneIncoming, PhoneOff, CalendarClock, History, ExternalLink, X } from 'lucide-react';
import { communicationsApi, type IncomingCall } from '@/lib/crm';
import { tokenStore } from '@/lib/api';
import { openOpenPhoneApp } from '@/lib/dialer';

/**
 * Global incoming-callback popup, shown centre-screen.
 *
 * Polls for the latest inbound call (last 60s) routed to the employee who
 * handled the customer. The CRM is a notification + redirection layer only:
 * "Open Call" hands off to OpenPhone, where the voice call is actually answered,
 * and "Dismiss" just closes. Nothing here answers, holds or controls the call.
 * The callback itself is logged by the call.* webhook handler (caller, customer,
 * timestamp and status), independently of whether this popup is acted on.
 */
export function IncomingCallPopup() {
  const [active, setActive] = useState<IncomingCall | null>(null);
  const dismissed = useRef<Set<string>>(new Set());

  const { data } = useQuery({
    queryKey: ['incoming-latest'],
    queryFn: communicationsApi.latestIncoming,
    // Poll fast so a ringing call pops almost instantly, and keep polling when the
    // tab is backgrounded — an agent working in another tab must still get the call.
    refetchInterval: 1000,
    refetchIntervalInBackground: true,
    enabled: typeof window !== 'undefined' && !!tokenStore.access,
    retry: false,
  });

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    // Show a new callback, and keep the live status (ringing → connected) fresh
    // on the one already showing.
    if (data && !dismissed.current.has(data.callId)) setActive(data);
    // Explicitly null = fetched and there's no live call any more. Clear it, so a
    // finished call can't leave a modal sitting over the whole CRM.
    else if (data === null) setActive(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [data]);

  const close = () => {
    if (active) dismissed.current.add(active.callId);
    setActive(null);
  };

  // Escape dismisses — the popup covers the screen, so there must be a way out
  // that doesn't involve hitting the redirect by mistake.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  if (!active) return null;

  // Attend: hand off to the calling platform, where the call is actually picked
  // up, then get the popup out of the way. Logged either way — a failure to
  // record must never stop the agent reaching the ringing call.
  const attend = () => {
    void communicationsApi.respondToCall(active.callId, 'attend').catch(() => {});
    openOpenPhoneApp();
    close();
  };

  // Decline: records the decision and closes the popup. It does NOT hang the
  // call up — OpenPhone exposes no call-control API — so the call keeps ringing
  // there until it's rejected in OpenPhone or times out to voicemail. The button
  // says so rather than implying the CRM rejected it.
  const decline = () => {
    void communicationsApi.respondToCall(active.callId, 'decline').catch(() => {});
    close();
  };
  // A returning customer with prior history reads as a callback, not a cold call.
  const isCallback = active.pendingCallback || !!active.lastOutcome || !!active.handledBy;
  const status = active.connected ? 'Connected' : isCallback ? 'Incoming callback' : 'Incoming call';
  // "Customer name" is the contact person; fall back to the company when unknown.
  const customerName = active.lead.contactName?.trim() || active.lead.businessName;
  const hasContact = !!active.lead.contactName?.trim();

  return (
    // Centre-screen. The backdrop is deliberately inert — a stray click must not
    // dismiss an incoming call; Dismiss and Escape are the ways out.
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="incoming-call-title"
        className="w-full max-w-[380px] overflow-hidden rounded-2xl border bg-card shadow-2xl"
      >
        <div className="flex items-center gap-2.5 bg-[#266929] px-4 py-3 text-white">
          <PhoneIncoming className="h-4 w-4 animate-pulse" />
          {/* Incoming call status */}
          <span className="text-[13px] font-semibold">{status}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={close}
            className="ml-auto grid h-7 w-7 place-items-center rounded-lg hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5">
          {/* Customer name · company · phone — the popup's core details. */}
          <div id="incoming-call-title" className="text-[19px] font-bold leading-tight">{customerName}</div>
          {hasContact && <div className="mt-0.5 text-[13px] font-medium text-muted-foreground">{active.lead.businessName}</div>}
          <div className="mt-1.5 font-mono text-[15px] tracking-wide">{active.lead.phone}</div>
          {(active.lead.city || active.lead.state) && (
            <div className="mt-0.5 text-[12.5px] text-muted-foreground">
              {[active.lead.city, active.lead.state].filter(Boolean).join(', ')}
            </div>
          )}

          {/* Recognition context: who handled this customer, last outcome, pending callback */}
          {(active.handledBy || active.lastOutcome || active.pendingCallback) && (
            <div className="mt-3 space-y-1 rounded-lg bg-muted/60 px-2.5 py-2 text-[11.5px] text-muted-foreground">
              {active.handledBy && (
                <div className="flex items-center gap-1.5">
                  <PhoneIncoming className="h-3 w-3 shrink-0" />
                  <span>Previously handled by <span className="font-semibold text-foreground">{active.handledBy}</span></span>
                </div>
              )}
              {active.lastOutcome && (
                <div className="flex items-center gap-1.5">
                  <History className="h-3 w-3 shrink-0" />
                  <span>Last outcome: <span className="font-semibold text-foreground">{active.lastOutcome}</span></span>
                </div>
              )}
              {active.pendingCallback && (
                <div className="flex items-center gap-1.5 font-semibold text-[#9e2b21]">
                  <CalendarClock className="h-3 w-3 shrink-0" />
                  <span>Had a callback pending</span>
                </div>
              )}
            </div>
          )}

          {/* Exactly two actions: go answer it, or decline it. */}
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              autoFocus
              onClick={attend}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-[#266929] px-3 py-2.5 text-[13px] font-semibold text-white hover:opacity-90"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Attend
            </button>
            <button
              type="button"
              onClick={decline}
              title="Logs the decline and closes this popup. OpenPhone provides no reject API, so the call must also be declined there."
              className="flex items-center justify-center gap-1.5 rounded-md border border-[#e8c9bf] bg-card px-4 py-2.5 text-[13px] font-semibold text-[#9e2b21] hover:bg-[#fbeeec]"
            >
              <PhoneOff className="h-3.5 w-3.5" /> Decline
            </button>
          </div>
          <p className="mt-2.5 text-[10.5px] leading-relaxed text-muted-foreground">
            Attend opens OpenPhone, where the call is picked up. Declining records it in the CRM but
            can&apos;t hang up the line — reject it in OpenPhone too, or it rings out to voicemail.
            The final status, recording and outcome sync back automatically.
          </p>
        </div>
      </div>
    </div>
  );
}
