'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, Check, Target, CheckCircle2, Clock, Percent, Video, ExternalLink } from 'lucide-react';
import { callsApi, communicationsApi, outcomesApi, formatDuration, type CallPhase } from '@/lib/crm';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';
import { zoomApi } from '@/lib/zoom';
import { leadsApi, type Lead } from '@/lib/leads';
import { CallsMade } from '@/components/calls-made';
import { CallsAnalytics } from '@/components/calls-analytics';
import { CallRecordings } from '@/components/call-recordings';
import { SmsHistory } from '@/components/sms-history';
import { PageTabs } from '@/components/page-tabs';
import { PageHead, Avatar } from '@/components/page-head';
import { StatusPill } from '@/components/status-pill';
import { OutcomePill } from '@/components/outcome-pill';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { DialPad } from '@/components/dial-pad';
import { useCall } from '@/components/call-provider';

// True when an ISO timestamp falls on the current calendar day.
function isToday(iso: string | null | undefined): boolean {
  if (!iso) return false;
  return new Date(iso).toDateString() === new Date().toDateString();
}

/** Pull the API's message out of an axios error, with a usable fallback. */
function apiError(err: unknown, fallback: string): string {
  const m = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (Array.isArray(m)) return String(m[0]);
  return typeof m === 'string' && m ? m : fallback;
}

// Live-call phase → the label shown on the call card, matching the docked widget.
const PHASE_LABEL: Record<CallPhase, string> = {
  initiated: 'Calling…',
  ringing: 'Ringing…',
  connected: 'Connected',
  on_hold: 'On Hold',
  ended: 'Call ended',
};

export default function CallingPage() {
  const qc = useQueryClient();
  // Which view is showing. The dialer's state lives here, so switching tabs and
  // back doesn't disturb an in-progress call.
  const [tab, setTab] = useState<'panel' | 'made' | 'analytics' | 'recordings' | 'sms'>('panel');
  const [active, setActive] = useState<{ callId: string; lead: Lead; startedAt: number; from?: string; callerName?: string } | null>(null);
  const [live, setLive] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [note, setNote] = useState('');
  const [outcome, setOutcome] = useState<string | null>(null);
  const [callbackAt, setCallbackAt] = useState('');
  // Zoom scheduling prompt (shown when the chosen outcome schedules a Zoom meeting).
  const [zoomAt, setZoomAt] = useState('');
  const [zoomDuration, setZoomDuration] = useState(30);
  const [zoomParticipants, setZoomParticipants] = useState('');
  const [zoomJoinUrl, setZoomJoinUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [autoCall, setAutoCall] = useState(false);
  const autoFired = useRef(false);
  // A call placed from the dial pad runs in the global docked widget, not this
  // panel. Knowing about it is what stops the two flows starting a second call
  // over the top of the first.
  const { active: widgetCall } = useCall();

  // Managers get the team-wide Calls Made view plus its per-employee filter;
  // employees see only their own calls (enforced by the API regardless).
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data, retry: false });
  const isManager = me?.role === 'admin' || me?.role === 'team_leader';

  const { data: dash } = useQuery({ queryKey: ['caller-dash'], queryFn: callsApi.dashboard });
  const { data: leads = [] } = useQuery({ queryKey: ['caller-leads'], queryFn: callsApi.myLeads });
  const { data: outcomes = [] } = useQuery({ queryKey: ['outcomes-config'], queryFn: outcomesApi.list });
  // Zoom meetings scheduled for today — pinned at the top of the Call Panel.
  const { data: zoomDue = [] } = useQuery({ queryKey: ['zoom-due'], queryFn: zoomApi.due });

  // Live call phase for the on-panel card, polled ~1s while the call is live — so
  // the green-button flow shows Ringing → Connected like the docked dial-pad widget,
  // rather than a static label. Real phases come from call.* webhooks; without a live
  // provider getCallState simulates them from elapsed time.
  const { data: callState } = useQuery({
    queryKey: ['call-state', active?.callId],
    queryFn: () => communicationsApi.callState(active!.callId),
    enabled: !!active && live,
    refetchInterval: (q) => (q.state.data?.phase === 'ended' ? false : 1000),
    retry: false,
  });
  const livePhase: CallPhase = callState?.phase ?? 'initiated';

  // If the provider reports the call ended (e.g. the customer hung up), move straight
  // to wrap-up with the real carrier duration instead of waiting for a manual End.
  useEffect(() => {
    if (!live || !active || callState?.phase !== 'ended') return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setElapsed(callState.durationSecs || Math.floor((Date.now() - active.startedAt) / 1000));
    setLive(false);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [live, active, callState]);

  // Resolve an outcome slug to its configured display name + color.
  const outcomeMeta = (slug: string | null | undefined) => outcomes.find((o) => o.slug === slug);

  // The selected outcome drives whether a callback / Zoom meeting must be scheduled.
  const selectedOutcome = outcomes.find((o) => o.slug === outcome);
  const schedules = selectedOutcome?.schedulesCallback ?? false;
  const schedulesZoom = selectedOutcome?.schedulesZoom ?? false;

  // Deep-link: /calling?leadId=… selects a specific record (from Lead Management,
  // the queue, or pinned callbacks). ?autocall=1 also opens the QUO dial pad
  // immediately, giving a single-click call from anywhere in the CRM.
  useEffect(() => {
    // Client-only: read the deep-link params after mount to stay SSR-safe.
    /* eslint-disable react-hooks/set-state-in-effect */
    const params = new URLSearchParams(window.location.search);
    const id = params.get('leadId');
    if (id) setSelectedId(id);
    if (params.get('autocall') === '1') setAutoCall(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  // A selected lead may live outside this caller's assigned queue (e.g. a team
  // lead calling from another agent's lead in Lead Management) — fetch it directly.
  const { data: selectedLead } = useQuery({
    queryKey: ['lead', selectedId],
    queryFn: () => leadsApi.get(selectedId!),
    enabled: !!selectedId,
  });

  // User may call ANY record: an explicit selection wins, else the next open lead.
  const current =
    active?.lead ??
    (selectedId ? leads.find((l) => l.id === selectedId) ?? selectedLead : undefined) ??
    leads.find((l) => l.status !== 'closed' && l.status !== 'rejected') ??
    leads[0];

  // No live timer during the call: we don't tick a running clock while `live`.
  // The total duration is computed once, from `startedAt`, when the call ends.

  function resetZoom() {
    setZoomAt('');
    setZoomDuration(30);
    setZoomParticipants('');
    setZoomJoinUrl('');
  }

  // openDialer: open the QUO dial pad via the tel: link. Only do this when called
  // from a real user click (the green Call button) — browsers block tel: opened
  // from an effect. The autocall path passes false because the dialer was already
  // opened at the originating click in Lead Management.
  async function startCall(openDialer = true) {
    if (!current) return;
    setBusy(true);
    try {
      // QUO/OpenPhone exposes no dial API, so placing the call is an app-handoff:
      // log the call, then hand the lead's number to the QUO dial pad. On desktop
      // this opens QUO only when it's set as the default calling app; on mobile the
      // QUO app handles it. QUO routes/queues + places the call, and call.* webhooks
      // sync status back to this record. The API rejects the call if the agent has
      // no assigned caller ID, so the customer never sees another employee's identity.
      const res = await communicationsApi.startCall(current.id);
      setActive({ callId: res.callId, lead: current, startedAt: Date.now(), from: res.from, callerName: res.callerName });
      setLive(true);
      setElapsed(0);
      setNote('');
      setOutcome(null);
      setCallbackAt('');
      resetZoom();
      if (openDialer && res.tel && typeof window !== 'undefined') {
        const a = document.createElement('a');
        a.href = res.tel;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } catch (err) {
      // Most common: no caller ID assigned to this rep — surface the API's guidance
      // instead of failing silently.
      toast.error(apiError(err, 'Could not start the call.'));
    } finally {
      setBusy(false);
    }
  }

  // Arrived from a Call button elsewhere (?autocall=1): open the QUO dial pad
  // automatically once the *intended* lead has resolved — fire exactly once.
  // Require current.id === selectedId so a queue fallback never auto-dials the
  // wrong number (e.g. when the lead isn't in this caller's assigned list).
  useEffect(() => {
    if (autoCall && current && current.id === selectedId && !active && !busy && !autoFired.current) {
      autoFired.current = true;
      void startCall(false); // dialer already opened at the originating click
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCall, current, selectedId, active, busy]);

  async function saveAndNext() {
    if (!active || !outcome) return;
    if (schedules && !callbackAt) return;
    if (schedulesZoom && !zoomAt) return;
    setBusy(true);
    try {
      // `elapsed` is only stamped by the End Call button, so saving a still-live
      // call would have logged a 0s duration. Derive it from the start instead —
      // saving ends the call either way, so the elapsed time IS the duration.
      const durationSecs = live ? Math.max(0, Math.round((Date.now() - active.startedAt) / 1000)) : elapsed;
      await callsApi.end(active.callId, outcome, durationSecs, callbackAt || undefined);
      if (note.trim()) await callsApi.addNote(active.callId, note.trim(), callbackAt || undefined, callbackAt || undefined);
      // Selecting a Zoom outcome auto-creates the meeting in the Zoom dashboard.
      if (schedulesZoom && zoomAt) {
        await zoomApi.create({
          leadId: active.lead.id,
          scheduledAt: new Date(zoomAt).toISOString(),
          durationMins: zoomDuration,
          participants: zoomParticipants || undefined,
          joinUrl: zoomJoinUrl || undefined,
          reason: note.trim() || undefined,
        });
      }
      setActive(null);
      setLive(false);
      setElapsed(0);
      setNote('');
      setOutcome(null);
      setCallbackAt('');
      resetZoom();
      setSelectedId(null); // advance to the next open lead after completing this one
      qc.invalidateQueries({ queryKey: ['caller-dash'] });
      qc.invalidateQueries({ queryKey: ['caller-leads'] });
      qc.invalidateQueries({ queryKey: ['zoom-due'] });
      qc.invalidateQueries({ queryKey: ['zoom'] });
      // An outcome can close the lead, moving it out of Lead Management and
      // into Closed Leads — refresh both lists so the move shows up at once.
      qc.invalidateQueries({ queryKey: ['leads'] });
    } catch (err) {
      // Report it rather than just un-busying the button. The resets above are
      // inside the try, so a failure leaves the call open with the outcome, notes
      // and callback still filled in — the agent can simply press save again.
      toast.error(apiError(err, 'Could not save the call. Your notes are still here — try again.'));
    } finally {
      setBusy(false);
    }
  }

  const remaining = leads.filter((l) => l.status !== 'closed' && l.status !== 'rejected').length;

  return (
    <div>
      <PageHead>
        {tab === 'panel' && <StatusPill status={live ? 'On Call' : 'Idle'} kind="presence" />}
      </PageHead>

      {/* View switch — sits beside the page title in the topbar. All three views
          live on this page; the dialer keeps its state while you look at the
          history or the analytics. */}
      <PageTabs>
        <div className="inline-flex rounded-md bg-muted/60 p-[2px]">
          {/* Recordings and SMS are open to everyone, matching the API's rule: a
              manager sees the whole team's, an employee sees only their own. */}
          {(([['panel', 'Calling Panel'], ['made', 'Calls Made'], ['analytics', 'Analytics'],
             ['recordings', 'Call Recordings'],
             ['sms', 'SMS']] as const)).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`whitespace-nowrap rounded-[5px] px-2.5 py-[3px] text-[11.5px] font-semibold transition-colors ${tab === k ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-background hover:text-foreground'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </PageTabs>

      {tab === 'made' && <CallsMade isManager={isManager} />}
      {tab === 'analytics' && <CallsAnalytics isManager={isManager} />}
      {tab === 'recordings' && <CallRecordings />}
      {tab === 'sms' && <SmsHistory />}

      {tab === 'panel' && (
      <>
      {/* KPIs */}
      <div className="mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
        <KpiCard icon={Target} iconBg="#d8eed9" iconColor="#266929" value={dash?.assignedLeads ?? 0} label="Assigned Leads" />
        <KpiCard icon={CheckCircle2} iconBg="#e4f2e4" iconColor="#317d34" value={dash?.callsCompleted ?? 0} label="Calls Completed" />
        <KpiCard icon={Clock} iconBg="#fbf3e2" iconColor="#c98a18" value={dash?.pendingLeads ?? 0} label="Pending" />
        <KpiCard icon={Phone} iconBg="#e3f1ee" iconColor="#2f6f63" value={formatDuration(dash?.productiveSecs ?? 0)} label="Productive Time" />
        <KpiCard icon={Percent} iconBg="#e7f0f8" iconColor="#2c5d8f" value={formatDuration(dash?.avgCallSecs ?? 0)} label="Avg Call" />
      </div>

      <div className="grid gap-[18px] lg:grid-cols-[1fr_360px]">
        {/* Left: call card + notes */}
        <div className="space-y-[18px]">
          <div className="relative overflow-hidden rounded-[22px] p-6 text-white shadow-md" style={{ background: 'linear-gradient(165deg,#163618,#112712)' }}>
            <svg className="pointer-events-none absolute inset-0 opacity-[.13]" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
              <g fill="none" stroke="#a6c15c" strokeWidth="1">
                <path d="M-50 80 Q150 30 350 90 T780 80" /><path d="M-50 160 Q180 100 360 180 T800 160" />
                <path d="M-50 250 Q160 190 380 270 T820 250" /><path d="M-50 340 Q200 280 400 360 T840 340" />
              </g>
            </svg>
            <div className="relative z-[2]">
              {current ? (
                <>
                  <div className="mb-[18px] flex items-center gap-[14px]">
                    <Avatar name={current.businessName} size="lg" />
                    <div>
                      <div className="font-display text-[20px] font-semibold">{current.businessName}</div>
                      <div className="text-[13px] text-[#a6c74d]">{current.leadId}</div>
                    </div>
                  </div>
                  <div className="mb-1 font-mono text-[15px] tracking-[.02em] text-[#d8eed9]">{current.phone}</div>
                  {/* Caller identity the customer will see. During a call it's the
                      identity the API stamped on this call; otherwise the rep's own
                      assigned line. An unassigned rep is warned they can't call yet. */}
                  {(() => {
                    const callerName = active?.callerName ?? me?.name;
                    const from = active?.from ?? me?.openphoneNumber;
                    return from ? (
                      <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[11.5px] text-[#d8eed9]">
                        <Phone className="h-3 w-3" />
                        <span>Calling as <span className="font-semibold text-white">{callerName}</span> · <span className="font-mono">{from}</span></span>
                      </div>
                    ) : (
                      <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-[#9e2b21]/90 px-2.5 py-1 text-[11.5px] font-medium text-white">
                        <Phone className="h-3 w-3" />
                        No caller ID assigned — ask an admin to set your OpenPhone number before calling.
                      </div>
                    );
                  })()}
                  <div className="my-[18px] flex flex-wrap gap-5">
                    <div><div className="text-[11px] uppercase tracking-[.1em] text-[#7e9933]">Location</div><div className="mt-0.5 font-display text-[16px] font-semibold">{current.city}, {current.state}</div></div>
                    <div><div className="text-[11px] uppercase tracking-[.1em] text-[#7e9933]">Timezone</div><div className="mt-0.5 font-display text-[16px] font-semibold">{current.timezone}</div></div>
                    <div><div className="text-[11px] uppercase tracking-[.1em] text-[#7e9933]">Status</div><div className="mt-0.5 font-display text-[16px] font-semibold capitalize">{current.status.replace('_', ' ')}</div></div>
                  </div>
                  {/* No live timer during the call — but the live phase (Calling →
                      Ringing → Connected) is shown while live, then only the final
                      duration once ended. */}
                  <div className="my-2 text-center">
                    {live ? (
                      <div className={`font-display text-[26px] font-semibold text-[#d0e29c] ${livePhase === 'initiated' || livePhase === 'ringing' ? 'animate-pulse' : ''}`}>
                        {PHASE_LABEL[livePhase]}
                      </div>
                    ) : active ? (
                      <>
                        <div className="text-[11px] uppercase tracking-[.1em] text-[#7e9933]">Call Duration</div>
                        <div className="font-mono text-[42px] font-semibold text-[#d0e29c]">
                          {String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}
                        </div>
                      </>
                    ) : (
                      <div className="font-mono text-[42px] font-semibold text-white/70">00:00</div>
                    )}
                  </div>
                  <div className="flex flex-wrap justify-center gap-2.5">
                    {!live ? (
                      <button onClick={() => startCall(true)} disabled={busy || widgetCall || (!!me && !me.openphoneNumber)} title={widgetCall ? 'Finish the dial-pad call first' : me && !me.openphoneNumber ? 'No caller ID assigned to your account' : 'Start call'} className="grid h-16 w-16 place-items-center rounded-[20px] bg-[#317d34] text-white shadow-[0_8px_20px_rgba(63,122,50,.5)] disabled:opacity-60">
                        <Phone className="h-[26px] w-[26px]" />
                      </button>
                    ) : (
                      // Mute/hold live in the OpenPhone dialer (the CRM can't control
                      // the audio), so the panel offers only End Call — the one control
                      // it can honour by closing out and logging the call.
                      <button onClick={() => { if (active) setElapsed(Math.floor((Date.now() - active.startedAt) / 1000)); setLive(false); }} title="End call" className="grid h-16 w-16 place-items-center rounded-[20px] bg-[#9e2b21] text-white shadow-[0_8px_20px_rgba(158,43,33,.5)]">
                        <Phone className="h-[26px] w-[26px] rotate-[135deg]" />
                      </button>
                    )}
                  </div>
                  {live && (
                    <p className="mt-2.5 text-center text-[11px] leading-relaxed text-[#a6c74d]">
                      Mute, hold &amp; audio are in your OpenPhone dialer — call status updates here automatically.
                    </p>
                  )}
                </>
              ) : (
                <div className="py-10 text-center text-[#a6c74d]">No leads assigned to you.</div>
              )}
            </div>
          </div>

          {/* Notes */}
          <div className="rounded-2xl border bg-card shadow-sm">
            <div className="border-b px-[18px] py-4"><h3 className="font-display text-[15px] font-semibold">Call Notes</h3><div className="text-xs text-muted-foreground">Saved automatically with outcome</div></div>
            <div className="p-[18px]">
              <div className="mb-1.5 text-[11px] uppercase tracking-[.08em] text-muted-foreground">Outcome</div>
              <div className="mb-3.5 flex flex-wrap gap-2">
                {outcomes.map((o) => {
                  const sel = outcome === o.slug;
                  return (
                    <button
                      key={o.id}
                      onClick={() => setOutcome(o.slug)}
                      className="rounded-full border-[1.5px] px-[13px] py-[7px] text-[12.5px] font-semibold transition-colors"
                      style={
                        sel
                          ? { borderColor: o.color, background: o.color, color: '#fff' }
                          : { borderColor: `${o.color}66`, color: o.color }
                      }
                    >
                      {o.name}
                    </button>
                  );
                })}
              </div>
              {schedules && (
                <div className="mb-3 grid gap-2 sm:grid-cols-2">
                  <label className="space-y-1 text-sm">
                    <span className="font-medium">Callback Date</span>
                    <input
                      type="date"
                      value={callbackAt ? callbackAt.slice(0, 10) : ''}
                      onChange={(e) => setCallbackAt(`${e.target.value}T${callbackAt ? callbackAt.slice(11, 16) : '09:00'}`)}
                      className="w-full rounded-md border bg-background px-3 py-2"
                      required
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="font-medium">Callback Time</span>
                    <input
                      type="time"
                      value={callbackAt ? callbackAt.slice(11, 16) : ''}
                      onChange={(e) => setCallbackAt(`${callbackAt ? callbackAt.slice(0, 10) : new Date().toISOString().slice(0, 10)}T${e.target.value}`)}
                      className="w-full rounded-md border bg-background px-3 py-2"
                      required
                    />
                  </label>
                </div>
              )}
              {schedulesZoom && (
                <div className="mb-3 rounded-lg border border-[#bcd9ff] bg-[#f2f8ff] p-3">
                  <div className="mb-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-[#1f5fae]">
                    <Video className="h-4 w-4" /> Schedule Zoom Meeting
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="space-y-1 text-sm">
                      <span className="font-medium">Date &amp; time</span>
                      <input type="datetime-local" value={zoomAt} onChange={(e) => setZoomAt(e.target.value)} className="w-full rounded-md border bg-background px-3 py-2" required />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="font-medium">Duration (min)</span>
                      <input type="number" min={5} max={480} value={zoomDuration} onChange={(e) => setZoomDuration(Number(e.target.value))} className="w-full rounded-md border bg-background px-3 py-2" />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="font-medium">Participants</span>
                      <input value={zoomParticipants} onChange={(e) => setZoomParticipants(e.target.value)} placeholder="names / emails" className="w-full rounded-md border bg-background px-3 py-2" />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="font-medium">Zoom link</span>
                      <input value={zoomJoinUrl} onChange={(e) => setZoomJoinUrl(e.target.value)} placeholder="https://zoom.us/j/…" className="w-full rounded-md border bg-background px-3 py-2" />
                    </label>
                  </div>
                  <p className="mt-1.5 text-[11px] text-[#1f5fae]">Saved to the Zoom dashboard and pinned in the Call Panel at the scheduled time.</p>
                </div>
              )}
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="e.g. Client requested callback tomorrow at 4 PM. Interested in bookkeeping. Send pricing email."
                className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm"
              />
              {/* The follow-up quick-picker that used to sit here was inert — it had
                  no state binding, so every selection was silently discarded. Callbacks
                  are scheduled by the date/time fields above, which the chosen outcome
                  requires, so there is one real path rather than a decorative second one. */}
              <div className="mt-3 flex items-center gap-2.5">
                <button onClick={saveAndNext} disabled={!active || !outcome || busy || (schedules && !callbackAt) || (schedulesZoom && !zoomAt)} className="ml-auto inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[13px] font-semibold text-primary-foreground disabled:opacity-50">
                  <Check className="h-4 w-4" /> Save &amp; next lead
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right: dial pad + queue */}
        <div className="space-y-[18px]">
          {/* Dial pad — call any number directly from the CRM (live status in the docked
              widget). Blocked while THIS panel has a call in flight: the two run separate
              call flows, so without this an agent could start a second call mid-call. */}
          <DialPad disabled={!!active} />
          {/* Pinned Zoom meetings due today — a pending action like a callback */}
          {zoomDue.length > 0 && (
            <div className="overflow-hidden rounded-2xl border border-[#bcd9ff] bg-[#f2f8ff] shadow-sm">
              <div className="flex items-center justify-between border-b border-[#d6e8ff] px-[18px] py-3">
                <h3 className="flex items-center gap-2 font-display text-[15px] font-semibold text-[#1f5fae]"><Video className="h-4 w-4" /> Zoom Meetings Today</h3>
                <Link href="/zoom" className="text-xs font-semibold text-[#2D8CFF] hover:underline">Manage</Link>
              </div>
              <div className="space-y-2 p-[14px]">
                {zoomDue.map((m) => (
                  <div key={m.id} className="flex items-center gap-[11px] rounded-[11px] border border-[#d6e8ff] bg-card p-3">
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] bg-[#e7f0fb] text-[#2D8CFF]"><Video className="h-[18px] w-[18px]" /></div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold">{m.lead?.businessName ?? 'Client'}</div>
                      <div className="truncate text-[11.5px] text-muted-foreground">
                        {new Date(m.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {m.durationMins} min
                        {m.status === 'in_progress' ? ' · live' : ''}
                      </div>
                    </div>
                    {m.joinUrl ? (
                      <a href={m.joinUrl} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[#2D8CFF] px-2.5 py-1.5 text-[12px] font-semibold text-white">
                        <ExternalLink className="h-3.5 w-3.5" /> Join
                      </a>
                    ) : (
                      <Link href="/zoom" className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[#bcd9ff] px-2.5 py-1.5 text-[12px] font-semibold text-[#1f5fae]">Open</Link>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-2xl border bg-card shadow-sm">
            <div className="border-b px-[18px] py-4"><h3 className="font-display text-[15px] font-semibold">Your Queue</h3><div className="text-xs text-muted-foreground">{remaining} remaining</div></div>
            <div className="max-h-[560px] overflow-y-auto p-[18px]">
              {leads.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No leads assigned.</p>}
              {leads.map((q, i) => {
                const closed = q.status === 'closed' || q.status === 'rejected';
                const pinned = !q.callbackCompletedAt && isToday(q.callbackAt);
                // Call state derived from today's most recent call on this lead.
                const activeCall = !!q.lastCallAt && !q.lastCallEndedAt;
                const completedToday = !!q.lastCallEndedAt;
                const isCurrent = current?.id === q.id && !closed;
                const done = closed || completedToday;
                const meta = outcomeMeta(q.lastOutcome);
                return (
                  <div
                    key={q.id}
                    onClick={() => { if (!live && !closed) setSelectedId(q.id); }}
                    className={`mb-[9px] flex items-center gap-[11px] rounded-[11px] border p-3 ${isCurrent ? 'border-[#2b732f] bg-muted shadow-[inset_3px_0_0_#266929]' : 'hover:bg-muted/50'} ${!live && !closed ? 'cursor-pointer' : ''} ${pinned ? 'border-[#e8c9bf] bg-[#fdf6f4]' : ''} ${completedToday && !pinned ? 'opacity-70' : ''}`}
                  >
                    <div className="grid h-6 w-6 shrink-0 place-items-center rounded-[7px] bg-[#d8eed9] text-[11px] font-bold text-[#266929]">{done ? '✓' : i + 1}</div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold">{q.businessName}</div>
                      <div className="truncate font-mono text-[11.5px] text-muted-foreground">{q.phone}</div>
                    </div>
                    {pinned ? (
                      <span className="shrink-0 rounded-full bg-[#9e2b21] px-2 py-[3px] text-[10px] font-semibold uppercase tracking-wide text-white">Callback today</span>
                    ) : (isCurrent || activeCall) ? (
                      <StatusPill status="in_progress" />
                    ) : completedToday && q.lastOutcome ? (
                      <OutcomePill name={meta?.name ?? q.lastOutcome} color={meta?.color} />
                    ) : closed ? (
                      <StatusPill status={q.status} />
                    ) : (
                      <span className="text-[11px] text-muted-foreground">{q.timezone}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex gap-[14px] rounded-2xl border bg-card p-[18px] text-center shadow-sm">
            <div className="flex-1"><div className="font-display text-[20px] font-semibold text-primary">{dash?.callsCompleted ?? 0}</div><div className="text-[11px] text-muted-foreground">Completed</div></div>
            <div className="flex-1 border-x"><div className="font-display text-[20px] font-semibold">{dash?.assignedLeads ?? 0}</div><div className="text-[11px] text-muted-foreground">Assigned</div></div>
            <div className="flex-1"><div className="font-display text-[20px] font-semibold text-[#c98a18]">{formatDuration(dash?.productiveSecs ?? 0)}</div><div className="text-[11px] text-muted-foreground">Productive</div></div>
          </div>
        </div>
      </div>
      </>
      )}
    </div>
  );
}
