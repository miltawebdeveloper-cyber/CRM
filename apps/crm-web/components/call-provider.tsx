'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, PhoneOff, X, Loader2, Check, ExternalLink } from 'lucide-react';
import { communicationsApi, callsApi, outcomesApi, type CallPhase, type Outcome } from '@/lib/crm';
import { launchQuoCall } from '@/lib/dialer';
import { invalidateCallActivity } from '@/lib/sync';
import { CallbackScheduler, callbackInputError } from '@/components/callback-scheduler';

/** Minimal lead shape the Call button needs — any caller can pass this. */
export interface CallLead {
  id: string;
  businessName: string;
  phone: string;
  city?: string;
  state?: string;
  /**
   * The customer's zone. Required for the wrap-up callback picker: without it
   * the widget was showing a bare `datetime-local`, which every rep reads as
   * their OWN local time while the API stores it as the customer's. Optional on
   * the type because callers who never wrap up a callback don't need it; the
   * picker asks for one when it's missing.
   */
  timezone?: string | null;
}

/** The caller identity the customer sees — the agent's own name + assigned line. */
interface CallIdentity {
  callerName?: string;
  from?: string;
}

interface CallContextValue {
  /** Initiate a call to a known lead. Opens the docked call widget. */
  placeCall: (lead: CallLead) => void;
  /** Initiate a call to a typed number (dial pad). Opens the docked call widget. */
  placeCallNumber: (phone: string) => void;
  /** Whether a call is currently active (for disabling duplicate Call buttons). */
  active: boolean;
}

const CallContext = createContext<CallContextValue | null>(null);

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error('useCall must be used within <CallProvider>');
  return ctx;
}

const PHASES: Record<CallPhase, { label: string; bg: string; fg: string; pulse: boolean }> = {
  initiated: { label: 'Calling…', bg: '#8a6d1f', fg: '#fff', pulse: true },
  ringing: { label: 'Ringing…', bg: '#8a6d1f', fg: '#fff', pulse: true },
  connected: { label: 'Connected', bg: 'var(--brand)', fg: '#fff', pulse: false },
  on_hold: { label: 'On Hold', bg: 'var(--tone-blue-fg)', fg: '#fff', pulse: false },
  ended: { label: 'Call ended', bg: '#5b5b5b', fg: '#fff', pulse: false },
};

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export function CallProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [active, setActive] = useState<{ callId: string; lead: CallLead; identity?: CallIdentity } | null>(null);
  const [ending, setEnding] = useState(false);
  const [finalDuration, setFinalDuration] = useState(0);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [callbackAt, setCallbackAt] = useState('');

  const reset = () => {
    setActive(null); setEnding(false); setFinalDuration(0);
    setOutcome(null); setNotes(''); setCallbackAt('');
  };

  const place = useMutation({
    mutationFn: (lead: CallLead) => communicationsApi.startCall(lead.id),
    onSuccess: (res, lead) => {
      setActive({ callId: res.callId, lead, identity: { callerName: res.callerName, from: res.from } });
      setEnding(false);
      // The Quo app is launched at the click site, not here: a custom scheme
      // handed over from an async callback is dropped by the browser. This
      // callback only opens the widget that monitors and wraps up the call.
    },
  });

  /**
   * Log + monitor a call to a known lead. The caller is responsible for having
   * already launched the Quo app inside the click (see `useCanCall().dial`) —
   * this is the CRM-side half of that handoff.
   */
  const placeCall = (lead: CallLead) => { if (!active) place.mutate(lead); };

  const placeByNumber = useMutation({
    mutationFn: (phone: string) => communicationsApi.startCallByPhone(phone),
    onSuccess: (res) => {
      setActive({ callId: res.callId, lead: res.lead, identity: { callerName: res.callerName, from: res.from } });
      setEnding(false);
      // The Quo app is opened at the click site (DialPad) so the browser doesn't
      // drop an app handoff fired from this async callback.
    },
  });
  const placeCallNumber = (phone: string) => { if (!active) placeByNumber.mutate(phone); };

  // Poll live state ~1s while the call is active and not yet in disposition.
  const { data: state } = useQuery({
    queryKey: ['call-state', active?.callId],
    queryFn: () => communicationsApi.callState(active!.callId),
    enabled: !!active && !ending,
    refetchInterval: (q) => (q.state.data?.phase === 'ended' ? false : 1000),
    retry: false,
  });

  const { data: outcomes = [] } = useQuery<Outcome[]>({
    queryKey: ['outcomes'], queryFn: outcomesApi.list, enabled: ending, retry: false,
  });
  const chosen = outcomes.find((o) => o.slug === outcome);
  const needsCallback = chosen?.schedulesCallback ?? false;

  const save = useMutation({
    mutationFn: async () => {
      if (!active || !outcome) return;
      await callsApi.end(active.callId, outcome, finalDuration, callbackAt || undefined);
      if (notes.trim()) await callsApi.addNote(active.callId, notes.trim(), callbackAt || undefined, callbackAt || undefined);
    },
    meta: { successMessage: 'Call logged' },
    onSuccess: () => {
      // A call logged from the docked widget is the same event as one logged from
      // the Calling Panel, so it refreshes the same modules. It used to name four
      // keys, one of which — `caller-dashboard` — was not a key anything reads
      // (the queue's cards are `caller-dash`), so the KPI cards never moved after
      // a dial-pad call. See lib/sync.ts.
      invalidateCallActivity(qc);
      reset();
    },
  });

  const phase: CallPhase = ending
    ? 'ended'
    : (place.isPending || placeByNumber.isPending) && !state
      ? 'initiated'
      : state?.phase ?? 'initiated';

  // No live timer during the call — only capture the final duration on end, for
  // the wrap-up screen and the timeline time log.
  const beginEnd = () => { setFinalDuration(state?.durationSecs ?? finalDuration); setEnding(true); };

  const value = useMemo<CallContextValue>(() => ({ placeCall, placeCallNumber, active: !!active }), [active]);

  return (
    <CallContext.Provider value={value}>
      {children}
      {active && (
        <CallWidget
          lead={active.lead}
          identity={active.identity}
          phase={phase}
          durationSecs={ending ? finalDuration : 0}
          ending={ending}
          outcomes={outcomes}
          outcome={outcome}
          onOutcome={setOutcome}
          needsCallback={needsCallback}
          callbackAt={callbackAt}
          onCallbackAt={setCallbackAt}
          notes={notes}
          onNotes={setNotes}
          onEndCall={beginEnd}
          onSave={() => save.mutate()}
          saving={save.isPending}
          // A typed date is not the same as a bookable one — the scheduler owns
          // that judgement so the button and the server agree.
          canSave={!!outcome && (!needsCallback || !callbackInputError(callbackAt, active.lead.timezone))}
          onClose={reset}
        />
      )}
    </CallContext.Provider>
  );
}

function CallWidget(props: {
  lead: CallLead;
  identity?: CallIdentity;
  phase: CallPhase;
  durationSecs: number;
  ending: boolean;
  outcomes: Outcome[];
  outcome: string | null;
  onOutcome: (s: string) => void;
  needsCallback: boolean;
  callbackAt: string;
  onCallbackAt: (v: string) => void;
  notes: string;
  onNotes: (v: string) => void;
  onEndCall: () => void;
  onSave: () => void;
  saving: boolean;
  canSave: boolean;
  onClose: () => void;
}) {
  const p = PHASES[props.phase];

  return (
    <div className="fixed bottom-5 right-5 z-[60] w-[340px] overflow-hidden rounded-2xl border bg-card shadow-2xl">
      {/* Status header — no live timer during the call; only the phase label. */}
      <div className="flex items-center gap-2.5 px-4 py-3" style={{ background: p.bg, color: p.fg }}>
        <Phone className={`h-4 w-4 ${p.pulse ? 'animate-pulse' : ''}`} />
        <span className="text-[12.5px] font-semibold">{props.ending ? 'Wrap up call' : p.label}</span>
        <button onClick={props.onClose} className="ml-auto grid h-7 w-7 place-items-center rounded-lg hover:bg-white/10">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="p-4">
        <div className="text-[14px] font-bold">{props.lead.businessName}</div>
        <div className="font-mono text-[12px] text-muted-foreground">{props.lead.phone}</div>
        {(props.lead.city || props.lead.state) && (
          <div className="mt-0.5 text-[12px] text-muted-foreground">{[props.lead.city, props.lead.state].filter(Boolean).join(', ')}</div>
        )}
        {props.identity?.from && (
          // The identity the customer sees — so the agent dials from the right line.
          <div className="mt-2 flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
            <Phone className="h-3 w-3" />
            <span>Calling as <span className="font-semibold text-foreground">{props.identity.callerName}</span> · <span className="font-mono">{props.identity.from}</span></span>
          </div>
        )}

        {!props.ending ? (
          <>
            {/* In-call controls — mute/hold live in the Quo app, not here. */}
            <div className="mt-3.5 flex items-center gap-2">
              {/* A browser cannot tell whether the OS actually handed the call to
                  the Quo app, so rather than guess, make a miss recoverable: one
                  click re-sends the same number. It works because it runs inside a
                  real gesture, which is the condition the handoff needs. */}
              <button
                onClick={() => launchQuoCall(props.lead.phone, props.identity?.from)}
                title="Send this number to the Quo app again"
                className="inline-flex items-center gap-1.5 rounded-full border px-3 py-2 text-[12px] font-semibold hover:bg-muted"
              >
                <ExternalLink className="h-3.5 w-3.5" /> Open in Quo
              </button>
              <button
                onClick={props.onEndCall}
                className="ml-auto inline-flex items-center gap-2 rounded-full bg-[var(--tone-red-fg)] px-5 py-2.5 text-[12.5px] font-semibold text-white hover:opacity-90"
              >
                <PhoneOff className="h-4 w-4" /> End Call
              </button>
            </div>
            <p className="mt-2.5 text-[10.5px] leading-relaxed text-muted-foreground">
              Live status updates automatically. Audio, mute, and hold run through the Quo app; this stays your control
              panel. If Quo didn&apos;t come to the front, use <b>Open in Quo</b>.
            </p>
          </>
        ) : (
          <>
            {/* Disposition / wrap-up */}
            <div className="mt-3 text-[11.5px] font-semibold text-muted-foreground">Duration {fmt(props.durationSecs)} · pick an outcome</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {props.outcomes.map((o) => (
                <button
                  key={o.slug}
                  onClick={() => props.onOutcome(o.slug)}
                  className={`rounded-full border px-2.5 py-[5px] text-[11.5px] font-semibold ${props.outcome === o.slug ? 'text-white' : 'bg-card hover:bg-muted'}`}
                  style={props.outcome === o.slug ? { background: o.color, borderColor: o.color } : { color: o.color }}
                >
                  {o.name}
                </button>
              ))}
            </div>

            {props.needsCallback && (
              // The same picker the Calling Panel uses: entered on the
              // customer's clock, shown on both clocks, and refused if the lead
              // has no zone or the time has already gone there.
              <CallbackScheduler
                className="mt-3"
                leadId={props.lead.id}
                timezone={props.lead.timezone}
                value={props.callbackAt}
                onChange={props.onCallbackAt}
              />
            )}

            <textarea
              value={props.notes}
              onChange={(e) => props.onNotes(e.target.value)}
              placeholder="Call notes (optional)…"
              rows={2}
              className="mt-3 w-full resize-none rounded-md border bg-background px-3 py-2 text-sm"
            />

            <div className="mt-3 flex items-center justify-end gap-2">
              <button onClick={props.onClose} className="rounded-md border bg-card px-3 py-2 text-[12.5px] font-semibold hover:bg-muted">Discard</button>
              <button
                onClick={props.onSave}
                disabled={!props.canSave || props.saving}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-[12.5px] font-semibold text-primary-foreground disabled:opacity-50"
              >
                {props.saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {props.saving ? 'Saving…' : 'Save & Close'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
