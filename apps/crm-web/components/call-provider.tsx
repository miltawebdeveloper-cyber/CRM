'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, PhoneOff, X, Loader2, Check } from 'lucide-react';
import { communicationsApi, callsApi, outcomesApi, type CallPhase, type Outcome } from '@/lib/crm';

/** Minimal lead shape the Call button needs — any caller can pass this. */
export interface CallLead {
  id: string;
  businessName: string;
  phone: string;
  city?: string;
  state?: string;
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
  connected: { label: 'Connected', bg: '#266929', fg: '#fff', pulse: false },
  on_hold: { label: 'On Hold', bg: '#2c5d8f', fg: '#fff', pulse: false },
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
      // Cockpit model: Quo/OpenPhone has no dial API, so hand the number to the
      // agent's OpenPhone dialer via a tel: link — the widget stays in the CRM
      // as the live monitor.
      if (res.tel && typeof window !== 'undefined') {
        const a = document.createElement('a');
        a.href = res.tel;
        a.click();
      }
    },
  });

  const placeCall = (lead: CallLead) => { if (!active) place.mutate(lead); };

  const placeByNumber = useMutation({
    mutationFn: (phone: string) => communicationsApi.startCallByPhone(phone),
    onSuccess: (res) => {
      setActive({ callId: res.callId, lead: res.lead, identity: { callerName: res.callerName, from: res.from } });
      setEnding(false);
      // The QUO dial pad is opened at the click site (DialPad) so the browser
      // doesn't block a tel: handoff fired from this async callback.
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
      if (active) {
        qc.invalidateQueries({ queryKey: ['lead', active.lead.id, 'timeline'] });
        qc.invalidateQueries({ queryKey: ['lead', active.lead.id] });
      }
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['caller-dashboard'] });
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
          canSave={!!outcome && (!needsCallback || !!callbackAt)}
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
        <span className="text-[13px] font-semibold">{props.ending ? 'Wrap up call' : p.label}</span>
        <button onClick={props.onClose} className="ml-auto grid h-7 w-7 place-items-center rounded-lg hover:bg-white/10">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="p-4">
        <div className="text-[15px] font-bold">{props.lead.businessName}</div>
        <div className="font-mono text-[12.5px] text-muted-foreground">{props.lead.phone}</div>
        {(props.lead.city || props.lead.state) && (
          <div className="mt-0.5 text-[12.5px] text-muted-foreground">{[props.lead.city, props.lead.state].filter(Boolean).join(', ')}</div>
        )}
        {props.identity?.from && (
          // The identity the customer sees — so the agent dials from the right line.
          <div className="mt-2 flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-[11.5px] text-muted-foreground">
            <Phone className="h-3 w-3" />
            <span>Calling as <span className="font-semibold text-foreground">{props.identity.callerName}</span> · <span className="font-mono">{props.identity.from}</span></span>
          </div>
        )}

        {!props.ending ? (
          <>
            {/* In-call controls — mute/hold live in the OpenPhone dialer, not here. */}
            <div className="mt-3.5 flex items-center">
              <button
                onClick={props.onEndCall}
                className="ml-auto inline-flex items-center gap-2 rounded-full bg-[#9e2b21] px-5 py-2.5 text-[13px] font-semibold text-white hover:opacity-90"
              >
                <PhoneOff className="h-4 w-4" /> End Call
              </button>
            </div>
            <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
              Live status updates automatically. Audio, mute, and hold run through your OpenPhone dialer; this stays your control panel.
            </p>
          </>
        ) : (
          <>
            {/* Disposition / wrap-up */}
            <div className="mt-3 text-[12px] font-semibold text-muted-foreground">Duration {fmt(props.durationSecs)} · pick an outcome</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {props.outcomes.map((o) => (
                <button
                  key={o.slug}
                  onClick={() => props.onOutcome(o.slug)}
                  className={`rounded-full border px-2.5 py-[5px] text-[12px] font-semibold ${props.outcome === o.slug ? 'text-white' : 'bg-card hover:bg-muted'}`}
                  style={props.outcome === o.slug ? { background: o.color, borderColor: o.color } : { color: o.color }}
                >
                  {o.name}
                </button>
              ))}
            </div>

            {props.needsCallback && (
              <label className="mt-3 block space-y-1 text-[12px]">
                <span className="font-semibold">Callback date &amp; time</span>
                <input
                  type="datetime-local"
                  value={props.callbackAt}
                  onChange={(e) => props.onCallbackAt(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                />
              </label>
            )}

            <textarea
              value={props.notes}
              onChange={(e) => props.onNotes(e.target.value)}
              placeholder="Call notes (optional)…"
              rows={2}
              className="mt-3 w-full resize-none rounded-md border bg-background px-3 py-2 text-sm"
            />

            <div className="mt-3 flex items-center justify-end gap-2">
              <button onClick={props.onClose} className="rounded-md border bg-card px-3 py-2 text-[13px] font-semibold hover:bg-muted">Discard</button>
              <button
                onClick={props.onSave}
                disabled={!props.canSave || props.saving}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground disabled:opacity-50"
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
