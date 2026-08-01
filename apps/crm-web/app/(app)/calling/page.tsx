'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, Check, Target, CheckCircle2, Clock, Percent, Video, ExternalLink, MessageSquare, Mail, Briefcase, UserRound, Send, X, Loader2 } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { callsApi, communicationsApi, outcomesApi, formatDuration, type CallPhase } from '@/lib/crm';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';
import { zoomApi } from '@/lib/zoom';
import { leadsApi, type Lead } from '@/lib/leads';
import { CallsMade } from '@/components/calls-made';
import { CallsAnalytics } from '@/components/calls-analytics';
import { CallRecordings } from '@/components/call-recordings';
import { SmsHistory } from '@/components/sms-history';
import { MissedCalls } from '@/components/missed-calls';
import { PageTabs } from '@/components/page-tabs';
import { PageHead, Avatar } from '@/components/page-head';
import { StatusPill } from '@/components/status-pill';
import { OutcomePill } from '@/components/outcome-pill';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { DialPad } from '@/components/dial-pad';
import { useCall } from '@/components/call-provider';
import { useCanCall } from '@/lib/use-can-call';
import { launchQuoCall } from '@/lib/dialer';
import { dayInLeadZone, formatScheduleInLeadZone, nowInLeadZone, zoneLabel, TIMEZONE_FILTER_OPTIONS } from '@/lib/timezone';
import { usePersistedState } from '@/lib/use-persisted-state';
import { CallbackScheduler, callbackInputError } from '@/components/callback-scheduler';
import { invalidateCallActivity } from '@/lib/sync';
import { useShortcutHint } from '@/components/command-palette';
import { formatTime } from '@/lib/display-settings';

/**
 * How often the panel re-reads its two live sources. The queue is checked more
 * often than the cards because working the wrong lead is worse than a KPI being a
 * few seconds stale — and both refetch immediately on window focus anyway.
 */
const QUEUE_POLL_MS = 15_000;
const DASH_POLL_MS = 30_000;

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

// Scheduled times are shown in the LEAD's zone, with the zone named — an
// appointment belongs to the customer's clock, not the rep's browser.
const formatScheduledTime = formatScheduleInLeadZone;

function getQueueItemType(l: Lead) {
  // "Due today" is asked on the CUSTOMER's calendar, not the rep's — the two are
  // a different date for several hours of every day, and the server bands the
  // queue the same way. Comparing day strings keeps this badge and the position
  // the server gave the lead in agreement.
  const today = dayInLeadZone(new Date(), l.timezone);
  const cbDay = !l.callbackCompletedAt && l.callbackAt ? dayInLeadZone(l.callbackAt, l.timezone) : '';
  const zmDay = l.nextZoomMeeting ? dayInLeadZone(l.nextZoomMeeting.scheduledAt, l.timezone) : '';

  const isCbToday = !!cbDay && cbDay <= today;
  const isZmToday = !!zmDay && zmDay <= today;
  const isCbFuture = !!cbDay && cbDay > today;
  const isZmFuture = !!zmDay && zmDay > today;

  if (isCbToday) {
    return { type: 'callback' as const, label: 'Callback Queue', badge: 'Callback Today', scheduledAt: l.callbackAt, isToday: true };
  }
  if (isZmToday) {
    return { type: 'zoom' as const, label: 'Zoom Scheduled Queue', badge: 'Zoom Today', scheduledAt: l.nextZoomMeeting?.scheduledAt, isToday: true };
  }
  if (isCbFuture) {
    return { type: 'callback' as const, label: 'Callback Queue', badge: 'Callback Scheduled', scheduledAt: l.callbackAt, isToday: false };
  }
  if (isZmFuture) {
    return { type: 'zoom' as const, label: 'Zoom Scheduled Queue', badge: 'Zoom Scheduled', scheduledAt: l.nextZoomMeeting?.scheduledAt, isToday: false };
  }
  return { type: 'new_call' as const, label: 'New Calling Queue', badge: 'New Call', scheduledAt: null, isToday: false };
}

export default function CallingPage() {
  const qc = useQueryClient();
  // Which view is showing. The dialer's state lives here, so switching tabs and
  // back doesn't disturb an in-progress call.
  const [tab, setTab] = useState<'panel' | 'made' | 'analytics' | 'recordings' | 'missed' | 'sms'>('panel');
  const [queueFilter, setQueueFilter] = useState<'all' | 'callback' | 'zoom' | 'new_call'>('all');
  // Which zone's leads the queue is showing. `''` is All Time Zones. Persisted so
  // it survives switching to Calls Made and back, or following a lead into Lead
  // Management and returning — a rep working one region shouldn't have to reset
  // it every time they leave the panel. Cleared only by choosing All again.
  const [tzFilter, setTzFilter] = usePersistedState<string>('calling:queue-timezone', '');
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
  // Leads saved in this sitting. See `isDone` — this is what advances the queue
  // when no call was placed to stamp `lastCallEndedAt`.
  const [processed, setProcessed] = useState<Set<string>>(() => new Set());
  // When the agent started working the lead now on screen. With live calling off
  // there is no call to time, so this stands in as the duration: it starts the
  // moment a lead is put in front of them and stops when they press Save. Kept in
  // a ref because it must not re-render anything — nothing counts up on screen,
  // the elapsed time is only read once, at the save.
  const openedAt = useRef<number>(Date.now());
  // A call placed from the dial pad runs in the global docked widget, not this
  // panel. Knowing about it is what stops the two flows starting a second call
  // over the top of the first.
  const { active: widgetCall } = useCall();
  // The one call-launch path: guards on caller ID, then hands the number to the
  // Quo app. Never a browser tab, never a tel: chooser. `callingEnabled` false is
  // the temporary lead-processing mode — the queue below runs exactly as it does
  // normally, minus the dialling.
  const { dial, callingEnabled, disabledReason } = useCanCall();

  // Managers get the team-wide Calls Made view plus its per-employee filter;
  // employees see only their own calls (enforced by the API regardless).
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data, retry: false });
  const isManager = me?.role === 'admin' || me?.role === 'team_leader';

  // The panel's two live reads. Both poll, because the things that change them
  // happen elsewhere: a manager assigning, reassigning or removing a lead, or the
  // auto-reassignment that runs when someone goes offline. Without polling the
  // queue and the cards only caught up on a manual reload, so an employee could
  // sit calling a lead that had already been handed to someone else. React Query
  // also refetches on window focus by default, so coming back to the tab is
  // instant rather than waiting out the interval.
  const { data: dash } = useQuery({
    queryKey: ['caller-dash'],
    queryFn: callsApi.dashboard,
    refetchInterval: DASH_POLL_MS,
  });
  const { data: leads = [] } = useQuery({
    queryKey: ['caller-leads'],
    queryFn: callsApi.myLeads,
    refetchInterval: QUEUE_POLL_MS,
  });
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

  // ── Queue ordering ──
  // The order is the SERVER's, used exactly as it arrives: ascending Lead ID, with
  // only callbacks and Zoom meetings due today pinned above it and finished leads
  // pushed to the end. Deliberately not re-sorted here — two sort implementations
  // is how the list you see stops matching the lead the panel hands you next.
  /**
   * A lead is finished once it's closed/rejected, once a call on it has ended, or
   * once it has been saved today.
   *
   * `lastWorkedAt` is the server's answer to that last clause and is what keeps the
   * queue moving with dialling off: `lastCallEndedAt` is only stamped by ending a
   * CALL, so without it a saved lead stayed top of the queue and the panel handed
   * the agent the same record again. It comes from the API rather than memory, so a
   * page refresh, a queue refresh or a re-login all show the same finished leads.
   * `processed` still covers the moment between saving and the next refetch.
   */
  const isDone = (l: Lead) =>
    l.status === 'closed' ||
    l.status === 'rejected' ||
    !!l.lastCallEndedAt ||
    !!l.lastWorkedAt ||
    processed.has(l.id);
  const queue = leads;

  // ── Time-zone filter ──
  // Purely a view over the queue: it narrows what the list DISPLAYS and the
  // counts on the type tabs, which describe that list. It deliberately does not
  // touch `nextPending` or `current` below — those decide which lead the panel
  // hands the rep and are what the call, the outcome and the status update are
  // recorded against, so a display filter must not be able to move them.
  //
  // Matched on the lead's OWN configured zone, compared exactly. A lead with no
  // zone set therefore matches no selection and appears only under All Time
  // Zones — filing it under Eastern is precisely the guess the rest of this
  // module exists to refuse.
  const zoneQueue = tzFilter ? queue.filter((l) => l.timezone === tzFilter) : queue;
  const filteredQueue = zoneQueue.filter((q) => {
    if (queueFilter === 'all') return true;
    return getQueueItemType(q).type === queueFilter;
  });
  // The next lead to work: first not-yet-done in ascending queue order. Read off
  // the FULL queue, not the filtered view — see above.
  const nextPending = queue.find((l) => !isDone(l));

  // User may call ANY record: an explicit selection wins, else the next pending
  // lead (top of the queue). Falls back to the first row if everything's done.
  const current =
    active?.lead ??
    (selectedId ? leads.find((l) => l.id === selectedId) ?? selectedLead : undefined) ??
    nextPending ??
    queue[0];

  // Restart the processing clock whenever a different lead comes to the front —
  // whether the agent picked it or the queue handed it over after a save. Reading
  // `current.id` rather than the queue array means a background refetch that
  // leaves the same lead in place doesn't reset the time already spent on it.
  useEffect(() => {
    openedAt.current = Date.now();
  }, [current?.id]);

  // No live timer during the call: we don't tick a running clock while `live`.
  // The total duration is computed once, from `startedAt`, when the call ends.

  function resetZoom() {
    setZoomAt('');
    setZoomDuration(30);
    setZoomParticipants('');
    setZoomJoinUrl('');
  }

  /**
   * Place the call: hand the number to the Quo app, then log it.
   *
   * The handoff goes FIRST and synchronously. Browsers only pass a custom scheme
   * to an app from a real user gesture, so launching after `await` would be
   * silently dropped — which is what left agents staring at a "live" call that
   * never dialled. `launchDialer=false` is the autocall path, where the Quo app
   * was already opened at the originating click in Lead Management.
   *
   * Quo places and routes the call; `call.*` webhooks sync status, recording and
   * transcript back onto this record. The API rejects the call if the agent has
   * no assigned caller ID, so the customer never sees another employee's identity
   * — `dial` mirrors that check before anything is dialled.
   */
  async function startCall(launchDialer = true) {
    if (!current) return;
    // Lead-processing mode: no call is placed and none is logged. The panel is a
    // review-and-record workflow until an admin turns calling back on.
    if (!callingEnabled) return;
    if (launchDialer && !dial(current.phone)) return;
    setBusy(true);
    try {
      const res = await communicationsApi.startCall(current.id);
      setActive({ callId: res.callId, lead: current, startedAt: Date.now(), from: res.from, callerName: res.callerName });
      setLive(true);
      setElapsed(0);
      setNote('');
      setOutcome(null);
      setCallbackAt('');
      resetZoom();
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
    // `callingEnabled` gates it too: no automatic call may start from the queue
    // while dialling is off, however the agent arrived here.
    if (callingEnabled && autoCall && current && current.id === selectedId && !active && !busy && !autoFired.current) {
      autoFired.current = true;
      void startCall(false); // dialer already opened at the originating click
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCall, current, selectedId, active, busy, callingEnabled]);

  async function saveAndNext() {
    // A call is no longer required to save. With dialling off there is no call to
    // end, but the lead still has to be worked: outcome, notes and callback are
    // recorded against the lead itself and the queue advances just the same.
    const lead = active?.lead ?? current;
    if (!lead || !outcome) return;
    // Same rule the Save button is disabled on, restated for the keyboard path.
    if (schedules && callbackInputError(callbackAt, lead.timezone)) return;
    if (schedulesZoom && !zoomAt) return;
    setBusy(true);
    try {
      if (active) {
        // `elapsed` is only stamped by the End Call button, so saving a still-live
        // call would have logged a 0s duration. Derive it from the start instead —
        // saving ends the call either way, so the elapsed time IS the duration.
        const durationSecs = live ? Math.max(0, Math.round((Date.now() - active.startedAt) / 1000)) : elapsed;
        await callsApi.end(active.callId, outcome, durationSecs, callbackAt || undefined);
        if (note.trim()) await callsApi.addNote(active.callId, note.trim(), callbackAt || undefined, callbackAt || undefined);
      } else {
        // No call was placed — log the same disposition and the same note straight
        // onto the lead. No Call row is written, so Total Calls Made stays honest
        // about a session in which nobody dialled; the record still appears in the
        // log, marked "No call", carrying the time spent working the lead.
        const processingSecs = Math.max(0, Math.round((Date.now() - openedAt.current) / 1000));
        await callsApi.logLead(lead.id, outcome, callbackAt || undefined, processingSecs);
        if (note.trim()) await callsApi.addLeadNote(lead.id, note.trim(), callbackAt || undefined, callbackAt || undefined);
      }
      // Selecting a Zoom outcome auto-creates the meeting in the Zoom dashboard.
      if (schedulesZoom && zoomAt) {
        await zoomApi.create({
          leadId: lead.id,
          // Sent as the bare wall clock the rep typed. `new Date(zoomAt).toISOString()`
          // resolved it in the BROWSER's zone, so the same "2 PM" booked a different
          // instant depending on where the rep sat — and disagreed with the callback
          // field beside it. The API reads it in the lead's zone instead.
          scheduledAt: zoomAt,
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
      // Mark it done for this session, then clear the selection so `nextPending`
      // hands over the next lead — no refresh, no manual navigation.
      setProcessed((done) => new Set(done).add(lead.id));
      setSelectedId(null); // advance to the next open lead after completing this one
      // One save touches the call log, the lead, its notes and callback, and any
      // Zoom booked alongside — so every module reading those is refreshed
      // together. This used to name five keys, which left the panel's own Calls
      // Made, Analytics and Recordings tabs showing the call as if it never
      // happened until the page was reloaded. See lib/sync.ts.
      invalidateCallActivity(qc);
    } catch (err) {
      // Report it rather than just un-busying the button. The resets above are
      // inside the try, so a failure leaves the call open with the outcome, notes
      // and callback still filled in — the agent can simply press save again.
      toast.error(apiError(err, 'Could not save the call. Your notes are still here — try again.'));
    } finally {
      setBusy(false);
    }
  }

  // Whether the save button would accept a click right now — shared with the
  // keyboard shortcut so the two can never disagree about when a lead is ready.
  // Matches the key the shortcut actually listens for on this platform.
  const saveHint = useShortcutHint() === '⌘K' ? '⌘↵' : 'Ctrl ↵';
  // The callback half of the check comes from the scheduler itself rather than
  // being restated here — "a date was typed" is not the same as "that date can
  // be booked", and the API rejects a lead with no zone or a time already gone.
  // Restating the rules is how the button stayed enabled for a save the server
  // was always going to refuse.
  const callbackError = schedules ? callbackInputError(callbackAt, current?.timezone) : null;
  const canSave = !!current && !!outcome && !busy && !callbackError && !(schedulesZoom && !zoomAt);

  /**
   * Keyboard shortcuts for the queue.
   *
   * This is the screen an agent spends the day in, working one lead after
   * another, and it was entirely mouse-driven: click an outcome, click the notes
   * box, type, click Save. Number keys pick from the outcome row and Ctrl/⌘+Enter
   * saves and advances, which takes the two round trips out of every single lead.
   *
   * Digits are ignored while typing — a phone number in the notes must not fire
   * an outcome — but Ctrl+Enter deliberately still works there, so the agent can
   * finish a note and save without reaching for the mouse at all.
   */
  useEffect(() => {
    if (tab !== 'panel') return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (canSave) void saveAndNext();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= 9 && outcomes[n - 1]) {
        e.preventDefault();
        setOutcome(outcomes[n - 1].slug);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, outcomes, canSave, busy]);

  // The Zoom form still books on the CURRENT lead's clock here: `leadZone` is the
  // zone abbreviation as it stands today (EDT vs EST), `leadNow` the customer's
  // own current date/time, used to bound the picker. The callback picker keeps
  // its own copies inside <CallbackScheduler>, which the widget shares.
  const leadZone = zoneLabel(current?.timezone);
  const leadNow = nowInLeadZone(current?.timezone); // `YYYY-MM-DDTHH:mm`

  // Which average the last KPI reports. Talk time is the meaningful one once calls
  // have been placed; with none today (or with dialling off entirely) it would be a
  // permanent 00:00, so the card falls back to time spent per lead.
  const showAvgCall = callingEnabled && (dash?.callsToday ?? 0) > 0;

  // ── Quick message ── send an SMS to the current lead without leaving the panel.
  const [msgOpen, setMsgOpen] = useState(false);
  const [msgBody, setMsgBody] = useState('');
  const sendMsg = useMutation({
    mutationFn: () => communicationsApi.sendSms(current!.id, msgBody.trim()),
    onSuccess: (r) => {
      if (r.success) {
        toast.success('Message sent');
        setMsgOpen(false);
        setMsgBody('');
      } else {
        toast.error(r.error ?? 'Could not send the message.');
      }
    },
    onError: (err) => toast.error(apiError(err, 'Could not send the message.')),
  });

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
             // Inbound calls nobody picked up. Its own tab rather than a widget,
             // so a rep can work the list rather than glance at the newest few.
             ['missed', 'Missed Calls'],
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
      {tab === 'missed' && <MissedCalls />}
      {tab === 'sms' && <SmsHistory />}

      {tab === 'panel' && (
      <>
      {/* KPIs — live for the logged-in rep. Assigned / Completed / Pending are the
          rep's book (they always add up, and they hold across a refresh); the last
          two describe today's sitting. All five re-read on a poll, on window focus
          and immediately after each lead is saved.

          The average switches source rather than showing a misleading zero: with
          dialling off there are no call durations to average, so it reports time
          per lead worked instead — which is the number that actually moves. */}
      <div className="mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
        <KpiCard icon={Target} iconBg="#d8eed9" iconColor="#266929" value={dash?.assignedLeads ?? 0} label="Assigned Leads" />
        <KpiCard icon={CheckCircle2} iconBg="#e4f2e4" iconColor="#317d34" value={dash?.callsCompleted ?? 0} label="Calls Completed" />
        <KpiCard icon={Clock} iconBg="#fbf3e2" iconColor="#c98a18" value={dash?.pendingLeads ?? 0} label="Pending" />
        <KpiCard icon={Phone} iconBg="#e3f1ee" iconColor="#2f6f63" value={formatDuration(dash?.productiveSecs ?? 0)} label="Productive Time" />
        <KpiCard
          icon={Percent}
          iconBg="#e7f0f8"
          iconColor="#2c5d8f"
          value={formatDuration(showAvgCall ? dash?.avgCallSecs ?? 0 : dash?.avgHandleSecs ?? 0)}
          label={showAvgCall ? 'Avg Call' : 'Avg / Lead'}
        />
      </div>

      {/* Queue (left) · Green lead card + notes (centre) · Dial pad (right).
          Three fixed-ish columns only once there is genuinely room for them. The
          breakpoint measures the VIEWPORT, but 248px of it is sidebar — so at
          `xl` (1280px) the three columns had about 1030px to share, and after the
          300px queue and 360px dial pad the lead card was left around 330px, too
          narrow for the customer's name, contact, email and location. So: one
          column on small screens, queue + lead card from `xl` (card gets ~700px),
          and the dial pad joins them as a third column only at `2xl`. */}
      <div className="grid gap-[18px] xl:grid-cols-[280px_minmax(0,1fr)] 2xl:grid-cols-[300px_minmax(0,1fr)_360px]">
        {/* Left: Your Queue section (New Calling Queue, Callback Queue, Zoom Scheduled Queue) */}
        <div className="space-y-[18px]">
          <div className="rounded-2xl border bg-card shadow-sm">
            <div className="border-b px-[18px] py-3.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-display text-[15px] font-semibold">Your Queue</h3>
                {/* Counts the leads actually listed below, so it moves with the
                    zone filter rather than claiming a size the list doesn't show. */}
                <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-bold text-primary">
                  {zoneQueue.length} leads
                </span>
              </div>

              {/* Time Zone filter — sits above the queue list and narrows it to
                  leads whose configured zone matches. Full-width because the
                  queue column is 280–300px: the shared FilterSelect is sized for
                  a horizontal filter bar and would overflow here. */}
              <div className="mt-3">
                <label
                  htmlFor="queue-timezone"
                  className="mb-1 block text-[11px] font-semibold uppercase tracking-[.06em] text-muted-foreground"
                >
                  Time Zone
                </label>
                <div className="flex items-center gap-[7px] rounded-md border bg-card px-3 py-2 text-[13px] font-medium text-[#163618] dark:text-foreground">
                  <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <select
                    id="queue-timezone"
                    value={tzFilter}
                    onChange={(e) => setTzFilter(e.target.value)}
                    className="w-full min-w-0 cursor-pointer truncate border-none bg-transparent font-medium outline-none"
                  >
                    {TIMEZONE_FILTER_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Counts are of the zone-filtered queue, since they label that list.
                  All four sit on ONE row: the queue column is 280px at `xl`, which
                  the tabs overflow at their natural width — that overflow first
                  drew a scrollbar (`overflow-x-auto`, which also hid the last tab
                  off the edge) and then wrapped "New" onto a second line. Sharing
                  the row in equal quarters (`flex-1` + `min-w-0`) fits them at any
                  column width; `truncate` is the backstop for counts long enough
                  that even a quarter is too narrow, so they ellipsize rather than
                  breaking the row again. */}
              <div className="mt-2.5 flex items-center gap-1 text-[10.5px]">
                <button
                  type="button"
                  onClick={() => setQueueFilter('all')}
                  className={`flex-1 min-w-0 truncate rounded-md px-1 py-1 text-center font-semibold transition-colors ${queueFilter === 'all' ? 'bg-primary text-primary-foreground' : 'bg-muted/60 text-muted-foreground hover:bg-muted'}`}
                >
                  All ({zoneQueue.length})
                </button>
                <button
                  type="button"
                  onClick={() => setQueueFilter('callback')}
                  className={`flex-1 min-w-0 truncate rounded-md px-1 py-1 text-center font-semibold transition-colors ${queueFilter === 'callback' ? 'bg-[#9e2b21] text-white' : 'bg-muted/60 text-muted-foreground hover:bg-muted'}`}
                >
                  Callback ({zoneQueue.filter((l) => getQueueItemType(l).type === 'callback').length})
                </button>
                <button
                  type="button"
                  onClick={() => setQueueFilter('zoom')}
                  className={`flex-1 min-w-0 truncate rounded-md px-1 py-1 text-center font-semibold transition-colors ${queueFilter === 'zoom' ? 'bg-[#2c5d8f] text-white' : 'bg-muted/60 text-muted-foreground hover:bg-muted'}`}
                >
                  Zoom ({zoneQueue.filter((l) => getQueueItemType(l).type === 'zoom').length})
                </button>
                <button
                  type="button"
                  onClick={() => setQueueFilter('new_call')}
                  className={`flex-1 min-w-0 truncate rounded-md px-1 py-1 text-center font-semibold transition-colors ${queueFilter === 'new_call' ? 'bg-[#266929] text-white' : 'bg-muted/60 text-muted-foreground hover:bg-muted'}`}
                >
                  New ({zoneQueue.filter((l) => getQueueItemType(l).type === 'new_call').length})
                </button>
              </div>
            </div>
            <div className="max-h-[620px] overflow-y-auto p-[14px]">
              {/* Two different empty states: an empty zone is worth naming, since
                  otherwise "no items in this queue" reads as an empty queue and
                  the rep has no reason to suspect a filter they set days ago. */}
              {filteredQueue.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {tzFilter && zoneQueue.length === 0
                    ? 'No leads available for the selected time zone.'
                    : 'No items in this queue.'}
                </p>
              )}
              {filteredQueue.map((q) => {
                const closed = q.status === 'closed' || q.status === 'rejected';
                const activeCall = !!q.lastCallAt && !q.lastCallEndedAt && !q.lastWorkedAt;
                // Same definition as `isDone`, so the ✓ on a row and the row's
                // position in the queue can't disagree about what's been worked.
                const completedToday = !!q.lastCallEndedAt || !!q.lastWorkedAt || processed.has(q.id);
                const isCurrent = current?.id === q.id && !closed;
                const done = closed || completedToday;
                const meta = outcomeMeta(q.lastOutcome ?? q.callStatus);
                const qType = getQueueItemType(q);
                const priorityIndex = queue.findIndex((item) => item.id === q.id) + 1;

                return (
                  <div
                    key={q.id}
                    onClick={() => { if (!live && !closed) setSelectedId(q.id); }}
                    className={`mb-[9px] flex flex-col gap-1.5 rounded-[11px] border p-3 transition-colors ${
                      isCurrent ? 'border-[#2b732f] bg-muted shadow-[inset_3px_0_0_#266929]' : 'hover:bg-muted/50'
                    } ${!live && !closed ? 'cursor-pointer' : ''} ${
                      qType.type === 'callback'
                        ? 'border-[#e8c9bf] bg-[#fdf6f4]'
                        : qType.type === 'zoom'
                        ? 'border-[#bfe3e8] bg-[#f4fbfd]'
                        : ''
                    } ${completedToday && !qType.isToday ? 'opacity-70' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <div className="grid h-6 w-6 shrink-0 place-items-center rounded-[7px] bg-[#d8eed9] text-[11px] font-bold text-[#266929]">
                          {done ? '✓' : `#${priorityIndex}`}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-semibold text-foreground">
                            {q.contactName ? q.contactName : q.businessName}
                          </div>
                          {q.contactName && (
                            <div className="truncate text-[11px] text-muted-foreground">{q.businessName}</div>
                          )}
                        </div>
                      </div>

                      {/* Queue Type Badge */}
                      {qType.type === 'callback' ? (
                        <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-[#9e2b21] px-2 py-[2px] text-[10px] font-semibold text-white">
                          <Clock className="h-3 w-3" />
                          {qType.badge}
                        </span>
                      ) : qType.type === 'zoom' ? (
                        <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-[#2c5d8f] px-2 py-[2px] text-[10px] font-semibold text-white">
                          <Video className="h-3 w-3" />
                          {qType.badge}
                        </span>
                      ) : (isCurrent || activeCall) ? (
                        <StatusPill status="in_progress" />
                      ) : completedToday && (q.lastOutcome || q.callStatus) ? (
                        // `lastOutcome` comes off the call record, so a lead worked
                        // with dialling off has none — fall back to the outcome
                        // stamped on the lead itself, or the row reads "New Call"
                        // straight after being completed.
                        <OutcomePill name={meta?.name ?? q.lastOutcome ?? q.callStatus!} color={meta?.color} />
                      ) : closed ? (
                        <StatusPill status={q.status} />
                      ) : (
                        <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-[#266929]/15 px-2 py-[2px] text-[10px] font-semibold text-[#266929]">
                          <Phone className="h-3 w-3" />
                          New Call
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-between text-[11.5px] text-muted-foreground border-t pt-1.5">
                      <span className="font-mono">{q.phone}</span>
                      {qType.scheduledAt ? (
                        <span className="font-medium text-foreground">
                          📅 {formatScheduledTime(qType.scheduledAt, q.timezone)}
                        </span>
                      ) : (
                        <span>{q.timezone}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Centre: call card + notes */}
        <div className="space-y-[18px]">
          <div className="relative overflow-hidden rounded-[18px] p-4 text-white shadow-md" style={{ background: 'linear-gradient(165deg,#163618,#112712)' }}>
            <svg className="pointer-events-none absolute inset-0 opacity-[.13]" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
              <g fill="none" stroke="#a6c15c" strokeWidth="1">
                <path d="M-50 80 Q150 30 350 90 T780 80" /><path d="M-50 160 Q180 100 360 180 T800 160" />
                <path d="M-50 250 Q160 190 380 270 T820 250" /><path d="M-50 340 Q200 280 400 360 T840 340" />
              </g>
            </svg>
            <div className="relative z-[2]">
              {current ? (
                <>
                  <div className="mb-2.5 flex items-start gap-[12px]">
                    <Avatar name={current.businessName} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className="font-display text-[20px] font-semibold">{current.businessName}</div>
                      <div className="text-[13px] text-[#a6c74d]">{current.leadId}</div>
                    </div>
                    {/* Quick message — SMS the current lead without leaving the panel. */}
                    <button
                      onClick={() => { setMsgBody(''); setMsgOpen(true); }}
                      title="Send a message"
                      aria-label="Send a message"
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-white/10 text-white transition-colors hover:bg-white/20"
                    >
                      <MessageSquare className="h-[18px] w-[18px]" />
                    </button>
                  </div>
                  <div className="mb-1 font-mono text-[15px] tracking-[.02em] text-[#d8eed9]">{current.phone}</div>
                  {/* Complete lead information — the person, their role, how to reach
                      them, and who owns the record. Only what's present is shown. */}
                  <div className="mt-2.5 flex flex-wrap gap-x-6 gap-y-2 text-[12.5px]">
                    {current.contactName && (
                      <span className="inline-flex items-center gap-1.5 text-[#d8eed9]"><UserRound className="h-3.5 w-3.5 text-[#a6c74d]" /> {current.contactName}</span>
                    )}
                    {current.contactName2 && (
                      <span className="inline-flex items-center gap-1.5 text-[#d8eed9]"><Briefcase className="h-3.5 w-3.5 text-[#a6c74d]" /> {current.contactName2}</span>
                    )}
                    {current.email && (
                      <a href={`mailto:${current.email}`} className="inline-flex items-center gap-1.5 text-[#d8eed9] hover:underline"><Mail className="h-3.5 w-3.5 text-[#a6c74d]" /> {current.email}</a>
                    )}
                    {current.assignedTo && (
                      <span className="inline-flex items-center gap-1.5 text-[#d8eed9]"><Check className="h-3.5 w-3.5 text-[#a6c74d]" /> {current.assignedTo.name}</span>
                    )}
                  </div>
                  {/* Caller identity the customer will see. During a call it's the
                      identity the API stamped on this call; otherwise the rep's own
                      assigned line. An unassigned rep is warned they can't call yet. */}
                  {(() => {
                    const callerName = active?.callerName ?? me?.name;
                    const from = active?.from ?? me?.openphoneNumber;
                    // With calling off, neither the identity nor the "no caller ID"
                    // warning is actionable — nobody is dialling either way.
                    if (!callingEnabled) return null;
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
                  <div className="my-3 flex flex-wrap gap-x-5 gap-y-2">
                    <div><div className="text-[10px] uppercase tracking-[.1em] text-[#7e9933]">Location</div><div className="mt-0.5 font-display text-[14px] font-semibold">{current.city}, {current.state}</div></div>
                    <div><div className="text-[10px] uppercase tracking-[.1em] text-[#7e9933]">Timezone</div><div className="mt-0.5 font-display text-[14px] font-semibold">{current.timezone}</div></div>
                    <div><div className="text-[10px] uppercase tracking-[.1em] text-[#7e9933]">Status</div><div className="mt-0.5 font-display text-[14px] font-semibold capitalize">{current.status.replace('_', ' ')}</div></div>
                  </div>

                  {/* Scheduled Zoom Meeting indicator & controls */}
                  {current.nextZoomMeeting && (
                    <div className="my-3 rounded-xl border border-[#7dd3fc]/30 bg-[#0c4a6e]/40 p-3 text-white backdrop-blur-sm">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Video className="h-4 w-4 text-[#7dd3fc]" />
                          <span className="text-[13.5px] font-semibold text-[#f0f9ff]">
                            {current.nextZoomMeeting.title || 'Scheduled Zoom Meeting'}
                          </span>
                        </div>
                        <span className="rounded-full bg-[#7dd3fc]/20 px-2 py-0.5 text-[10.5px] font-medium text-[#7dd3fc]">
                          {current.nextZoomMeeting.durationMins} mins
                        </span>
                      </div>
                      <div className="mt-1.5 text-[12px] text-[#e0f2fe]">
                        Scheduled: <span className="font-semibold">{formatScheduledTime(current.nextZoomMeeting.scheduledAt, current.timezone)}</span>
                      </div>
                      <div className="mt-2.5 flex items-center gap-2">
                        {current.nextZoomMeeting.joinUrl && (
                          <a
                            href={current.nextZoomMeeting.joinUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 rounded-lg bg-[#0284c7] px-3 py-1.5 text-[12px] font-semibold text-white shadow hover:bg-[#0369a1]"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            Join Zoom
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await zoomApi.start(current.nextZoomMeeting!.id);
                              toast.success('Zoom meeting started');
                              qc.invalidateQueries({ queryKey: ['caller-leads'] });
                              qc.invalidateQueries({ queryKey: ['zoom-due'] });
                            } catch (err) {
                              toast.error(apiError(err, 'Could not start Zoom meeting'));
                            }
                          }}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-white/20 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-white/30"
                        >
                          <Video className="h-3.5 w-3.5" />
                          Start Meeting
                        </button>
                      </div>
                    </div>
                  )}
                  {/* No live timer during the call — but the live phase (Calling →
                      Ringing → Connected) is shown while live, then only the final
                      duration once ended. Hidden entirely in lead-processing mode:
                      a call timer on a panel that cannot call is just confusing. */}
                  {callingEnabled && (
                  <div className="my-1.5 text-center">
                    {live ? (
                      <div className={`font-display text-[22px] font-semibold text-[#d0e29c] ${livePhase === 'initiated' || livePhase === 'ringing' ? 'animate-pulse' : ''}`}>
                        {PHASE_LABEL[livePhase]}
                      </div>
                    ) : active ? (
                      <>
                        <div className="text-[11px] uppercase tracking-[.1em] text-[#7e9933]">Call Duration</div>
                        <div className="font-mono text-[34px] font-semibold text-[#d0e29c]">
                          {String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}
                        </div>
                      </>
                    ) : (
                      <div className="font-mono text-[34px] font-semibold text-white/70">00:00</div>
                    )}
                  </div>
                  )}

                  {/* Lead-processing mode: the dial controls are not rendered at
                      all — an agent shouldn't have to work out which buttons are
                      real — and the panel says what to do instead. The calling
                      code is untouched; this is a switch, not a removal. */}
                  {!callingEnabled ? (
                    <div className="my-2 rounded-xl bg-white/10 px-3.5 py-3 text-center text-[12.5px] leading-relaxed text-[#d8eed9]">
                      <div className="font-semibold text-white">Calling is temporarily disabled</div>
                      <div className="mt-0.5">{disabledReason || 'Review the lead, log the outcome and save — the queue moves on as usual.'}</div>
                      {/* Say that the time is being recorded. Without this the
                          agent has no way to know their handling time counts, and
                          a hidden measurement that feeds their own numbers is not
                          something to leave them guessing about. There is
                          deliberately no ticking clock — a counter on screen turns
                          the write-up into a race. */}
                      <div className="mt-1.5 text-[11.5px] text-[#a6c74d]">
                        Time on this lead is recorded as the call duration when you save.
                      </div>
                    </div>
                  ) : (
                  <div className="flex flex-wrap justify-center gap-2.5">
                    {!live ? (
                      <button onClick={() => startCall(true)} disabled={busy || widgetCall || (!!me && !me.openphoneNumber)} title={widgetCall ? 'Finish the dial-pad call first' : me && !me.openphoneNumber ? 'No caller ID assigned to your account' : 'Start call'} className="grid h-14 w-14 place-items-center rounded-[18px] bg-[#317d34] text-white shadow-[0_8px_20px_rgba(63,122,50,.5)] disabled:opacity-60">
                        <Phone className="h-[22px] w-[22px]" />
                      </button>
                    ) : (
                      // Mute/hold live in the Quo app (the CRM can't control the
                      // audio), so the panel offers End Call — the one control it can
                      // honour by closing out and logging the call — plus a way to
                      // re-send the number if Quo never came to the front. A browser
                      // can't detect that, so it's a button rather than a guess.
                      <>
                        <button onClick={() => launchQuoCall(active?.lead.phone, active?.from)} title="Send this number to the Quo app again" className="grid h-14 w-14 place-items-center rounded-[18px] border border-white/25 text-white hover:bg-white/10">
                          <ExternalLink className="h-[20px] w-[20px]" />
                        </button>
                        <button onClick={() => { if (active) setElapsed(Math.floor((Date.now() - active.startedAt) / 1000)); setLive(false); }} title="End call" className="grid h-14 w-14 place-items-center rounded-[18px] bg-[#9e2b21] text-white shadow-[0_8px_20px_rgba(158,43,33,.5)]">
                          <Phone className="h-[22px] w-[22px] rotate-[135deg]" />
                        </button>
                      </>
                    )}
                  </div>
                  )}
                  {callingEnabled && live && (
                    <p className="mt-2.5 text-center text-[11px] leading-relaxed text-[#a6c74d]">
                      Mute, hold &amp; audio are in the Quo app — call status updates here automatically. If Quo didn&apos;t
                      come to the front, tap the arrow to send the number again.
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
            <div className="border-b px-4 py-2.5"><h3 className="font-display text-[14px] font-semibold">Call Notes</h3><div className="text-[11px] text-muted-foreground">Saved automatically with outcome</div></div>
            <div className="p-4">
              <div className="mb-1.5 flex items-center gap-2 text-[11px] uppercase tracking-[.08em] text-muted-foreground">
                Outcome
                {/* The shortcuts are only worth anything if the agent knows they
                    exist, so the first nine carry their key and the hint sits
                    beside the label rather than in a help page nobody opens. */}
                <span className="ml-auto normal-case tracking-normal">
                  Press <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">1</kbd>–
                  <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">9</kbd> to pick
                </span>
              </div>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {outcomes.map((o, i) => {
                  const sel = outcome === o.slug;
                  const key = i < 9 ? String(i + 1) : null;
                  return (
                    <button
                      key={o.id}
                      onClick={() => setOutcome(o.slug)}
                      title={key ? `${o.name} — press ${key}` : o.name}
                      className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] px-2.5 py-[4px] text-[12px] font-semibold transition-colors"
                      style={
                        sel
                          ? { borderColor: o.color, background: o.color, color: '#fff' }
                          : { borderColor: `${o.color}66`, color: o.color }
                      }
                    >
                      {key && (
                        <span
                          className="rounded-[4px] px-1 font-mono text-[10px] leading-[14px]"
                          style={sel ? { background: 'rgba(255,255,255,.22)' } : { background: `${o.color}1f` }}
                        >
                          {key}
                        </span>
                      )}
                      {o.name}
                    </button>
                  );
                })}
              </div>
              {schedules && current && (
                // Shared with the docked call widget, so a callback booked from
                // either place is entered, validated and displayed identically.
                <CallbackScheduler
                  className="mb-3"
                  leadId={current.id}
                  timezone={current.timezone}
                  value={callbackAt}
                  onChange={setCallbackAt}
                />
              )}
              {schedulesZoom && (
                <div className="mb-3 rounded-lg border border-[#bcd9ff] bg-[#f2f8ff] p-3">
                  <div className="mb-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-[#1f5fae]">
                    <Video className="h-4 w-4" /> Schedule Zoom Meeting
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="space-y-1 text-sm">
                      <span className="font-medium">Date &amp; time ({leadZone})</span>
                      <input type="datetime-local" value={zoomAt} onChange={(e) => setZoomAt(e.target.value)} min={leadNow} className="w-full rounded-md border bg-background px-3 py-2" required />
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
                  <p className="mt-1.5 text-[11px] text-[#1f5fae]">
                    Booked in the lead&apos;s time zone ({current?.timezone ?? 'EST'} / {leadZone}). Saved to the Zoom dashboard and pinned in the Call Panel at the scheduled time.
                  </p>
                </div>
              )}
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="e.g. Client requested callback tomorrow at 4 PM. Interested in bookkeeping. Send pricing email."
                className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm"
              />
              {/* The follow-up quick-picker that used to sit here was inert — it had
                  no state binding, so every selection was silently discarded. Callbacks
                  are scheduled by the date/time fields above, which the chosen outcome
                  requires, so there is one real path rather than a decorative second one. */}
              <div className="mt-2.5 flex items-center gap-2.5">
                {/* No longer requires a live call: with dialling off the agent
                    reviews the lead, picks an outcome and saves, which records the
                    disposition and moves the queue on. */}
                <button
                  onClick={saveAndNext}
                  disabled={!canSave}
                  title="Save and load the next lead — Ctrl+Enter"
                  className="ml-auto inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[8px] text-[13px] font-semibold text-primary-foreground disabled:opacity-50"
                >
                  <Check className="h-4 w-4" /> Save &amp; next lead
                  <kbd className="rounded border border-white/30 bg-white/15 px-1 font-mono text-[10px] font-normal">
                    {saveHint}
                  </kbd>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right: dial pad + zoom + stats.
            At `xl` the grid is two columns, so this sits on its own row beneath
            them and spans both — a third of a row's width with two-thirds empty
            beside it would waste the space it was moved down to reclaim. Its
            cards then run side by side rather than stacked, since a dial pad
            stretched across 1000px is not a better dial pad. At `2xl` there is
            room for a third column, so it goes back to being one. */}
        <div className="space-y-[18px] xl:col-span-2 xl:grid xl:gap-[18px] xl:space-y-0 xl:[grid-template-columns:repeat(auto-fit,minmax(300px,1fr))] 2xl:col-span-1 2xl:block 2xl:space-y-[18px]">
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
                        {/* The rep's own clock, not the browser's. Ideally this
                            would also name the customer's, as the Zoom form
                            does — but the due feed doesn't carry the lead's
                            zone, so that needs an API change rather than a
                            guess here. */}
                        {formatTime(m.scheduledAt)} · {m.durationMins} min
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

          <div className="flex gap-[14px] rounded-2xl border bg-card p-[18px] text-center shadow-sm">
            <div className="flex-1"><div className="font-display text-[20px] font-semibold text-primary">{dash?.callsCompleted ?? 0}</div><div className="text-[11px] text-muted-foreground">Completed</div></div>
            <div className="flex-1 border-x"><div className="font-display text-[20px] font-semibold">{dash?.assignedLeads ?? 0}</div><div className="text-[11px] text-muted-foreground">Assigned</div></div>
            <div className="flex-1"><div className="font-display text-[20px] font-semibold text-[#c98a18]">{formatDuration(dash?.productiveSecs ?? 0)}</div><div className="text-[11px] text-muted-foreground">Productive</div></div>
          </div>
        </div>
      </div>

      {/* Quick-message composer — SMS the current lead in place, over the panel. */}
      {msgOpen && current && (
        <>
          <div onClick={() => !sendMsg.isPending && setMsgOpen(false)} className="fixed inset-0 z-50 bg-black/30" />
          <div className="fixed inset-0 z-[51] grid place-items-center p-4" role="dialog" aria-modal="true" aria-label="Send a message">
            <div onClick={(e) => e.stopPropagation()} className="w-full max-w-[440px] overflow-hidden rounded-2xl border bg-card shadow-2xl">
              <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
                <div className="min-w-0">
                  <h3 className="font-display text-[15px] font-semibold">Send a message</h3>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {current.businessName} · <span className="font-mono">{current.phone}</span>
                  </p>
                </div>
                <button onClick={() => setMsgOpen(false)} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
              </div>
              <div className="p-4">
                <textarea
                  autoFocus
                  value={msgBody}
                  onChange={(e) => setMsgBody(e.target.value)}
                  rows={4}
                  placeholder="Type your message…"
                  className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </div>
              <div className="flex items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3">
                <button onClick={() => setMsgOpen(false)} disabled={sendMsg.isPending} className="rounded-md border bg-card px-3.5 py-2 text-[13px] font-medium hover:bg-muted disabled:opacity-50">Cancel</button>
                <button
                  onClick={() => sendMsg.mutate()}
                  disabled={!msgBody.trim() || sendMsg.isPending}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
                >
                  {sendMsg.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  {sendMsg.isPending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
      </>
      )}
    </div>
  );
}
