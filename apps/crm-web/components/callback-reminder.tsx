'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bell, BellOff, CalendarClock, Clock, Loader2, Phone, X } from 'lucide-react';
import { callbacksApi, CALLBACK_STATUS_STYLE, SNOOZE_OPTIONS, type DueCallback } from '@/lib/callbacks';
import { callsApi } from '@/lib/crm';
import { useCanCall } from '@/lib/use-can-call';
import { pushToast } from '@/lib/toast';
import { invalidateCallActivity } from '@/lib/sync';
import { CallbackScheduler, callbackInputError } from '@/components/callback-scheduler';
import { formatInUserZone, userZoneLabel } from '@/lib/timezone';

/** How often the browser re-asks what's due. Fast enough to feel immediate. */
const POLL_MS = 30_000;

/**
 * The callback reminder popup.
 *
 * Mounted once in the app shell, so a callback finds the rep wherever they are
 * in the CRM rather than only on the page that happens to list it.
 *
 * Two things it does that a notification alone can't:
 *
 *  • It persists. The feed re-answers "what is due for this rep right now" every
 *    30 seconds, so the popup comes back until the rep actually acts. A browser
 *    notification is dismissed by the OS after a few seconds and by switching
 *    tabs — which is exactly when a rep misses a callback.
 *  • It carries the actions. Call Now, Snooze, Reschedule and Dismiss are all
 *    here, so the rep never has to go and find the lead to deal with it.
 *
 * The desktop notification is the attention-getter for a rep on another tab, and
 * is best-effort: permission may be denied, and nothing here depends on it.
 */
export function CallbackReminders() {
  const router = useRouter();
  const qc = useQueryClient();
  const { dial, callingEnabled } = useCanCall();

  const { data: dueList = [] } = useQuery({
    queryKey: ['callbacks', 'due'],
    queryFn: callbacksApi.due,
    refetchInterval: POLL_MS,
    // Coming back to the tab should show the current truth immediately, not
    // whatever was due when the rep wandered off.
    refetchOnWindowFocus: true,
    retry: false,
  });

  // Which lead the rep pushed aside for this page view only. Kept in memory
  // rather than sent to the server: closing the popup with the X is "not now,
  // I'm mid-something", not the durable Dismiss below it.
  const [setAside, setSetAside] = useState<string[]>([]);
  const [rescheduling, setRescheduling] = useState<string | null>(null);
  const [newTime, setNewTime] = useState('');

  const visible = useMemo(() => dueList.filter((c) => !setAside.includes(c.leadId)), [dueList, setAside]);
  const current = visible[0] ?? null;

  useDesktopNotifications(dueList);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['callbacks'] });
    qc.invalidateQueries({ queryKey: ['followups'] });
    invalidateCallActivity(qc);
  };

  const snooze = useMutation({
    mutationFn: ({ leadId, minutes }: { leadId: string; minutes: number }) => callbacksApi.snooze(leadId, minutes),
    onSuccess: (_r, v) => {
      pushToast('info', `Reminder snoozed for ${v.minutes} minutes.`);
      refresh();
    },
    onError: () => pushToast('error', 'Could not snooze that reminder.'),
  });

  const dismiss = useMutation({
    mutationFn: (leadId: string) => callbacksApi.dismiss(leadId),
    onSuccess: () => {
      pushToast('info', 'Reminder dismissed. The callback is still scheduled and still shows in your lists.');
      refresh();
    },
    onError: () => pushToast('error', 'Could not dismiss that reminder.'),
  });

  const reschedule = useMutation({
    mutationFn: ({ leadId, at }: { leadId: string; at: string }) =>
      callsApi.updateFollowup('lead', leadId, { followUpAt: at }),
    onSuccess: () => {
      pushToast('success', 'Callback rescheduled.');
      setRescheduling(null);
      setNewTime('');
      refresh();
    },
    onError: (e: unknown) => pushToast('error', apiMessage(e) ?? 'Could not reschedule that callback.'),
  });

  if (!current) return null;

  const busy = snooze.isPending || dismiss.isPending || reschedule.isPending;
  const style = CALLBACK_STATUS_STYLE[current.status];
  const isRescheduling = rescheduling === current.leadId;
  const rescheduleError = isRescheduling ? callbackInputError(newTime, current.timezone) : null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[70] flex justify-center p-4 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:justify-end">
      <div className="w-full max-w-[400px] overflow-hidden rounded-2xl border bg-card shadow-2xl">
        <div className="flex items-center gap-2.5 px-4 py-3" style={{ background: style.dot, color: '#fff' }}>
          <Bell className="h-4 w-4 animate-pulse" />
          <span className="text-[12.5px] font-semibold">
            {current.status === 'overdue' ? 'Overdue callback' : 'Callback due now'}
          </span>
          {visible.length > 1 && (
            <span className="rounded-full bg-white/25 px-2 py-0.5 text-[10.5px] font-semibold">
              +{visible.length - 1} more
            </span>
          )}
          {/* Set aside for this page view. Deliberately distinct from Dismiss:
              one is "not this second", the other is a decision recorded on the
              lead. Both are offered because reps mean both at different times. */}
          <button
            onClick={() => setSetAside((prev) => [...prev, current.leadId])}
            title="Hide until the next check"
            className="ml-auto grid h-7 w-7 place-items-center rounded-lg hover:bg-white/15"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4">
          <div className="text-[14px] font-bold">{current.businessName}</div>
          {current.contactName && (
            <div className="text-[12px] text-muted-foreground">{current.contactName}</div>
          )}
          <div className="font-mono text-[12.5px] font-semibold">{current.phone}</div>

          {/* Both clocks again, for the same reason the scheduler shows both:
              the rep needs the time they promised the customer AND the one on
              their own wall. */}
          <div className="mt-3 grid gap-2 rounded-lg border bg-muted/40 p-2.5 sm:grid-cols-2">
            <div className="flex items-start gap-1.5">
              <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[.08em] text-muted-foreground">
                  Scheduled ({current.timezone ?? 'no zone set'})
                </div>
                <div className="text-[12px] font-semibold">{current.callbackAtLabel}</div>
              </div>
            </div>
            <div className="flex items-start gap-1.5">
              <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[.08em] text-muted-foreground">
                  Your time ({userZoneLabel()})
                </div>
                <div className="text-[12px] font-semibold">{formatInUserZone(new Date(current.callbackAt))}</div>
              </div>
            </div>
          </div>

          <span
            className="mt-2.5 inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11px] font-semibold"
            style={{ background: style.bg, color: style.fg }}
          >
            {current.status === 'overdue' && <AlertTriangle className="h-3 w-3" />}
            {style.label}
          </span>

          {isRescheduling ? (
            <div className="mt-3">
              <CallbackScheduler
                leadId={current.leadId}
                timezone={current.timezone}
                value={newTime}
                onChange={setNewTime}
              />
              <div className="mt-2.5 flex items-center justify-end gap-2">
                <button
                  onClick={() => { setRescheduling(null); setNewTime(''); }}
                  className="rounded-md border bg-card px-3 py-2 text-[12.5px] font-semibold hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  onClick={() => reschedule.mutate({ leadId: current.leadId, at: newTime })}
                  disabled={!!rescheduleError || busy}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-[12.5px] font-semibold text-primary-foreground disabled:opacity-50"
                >
                  {reschedule.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Save new time
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="mt-3.5 flex flex-wrap items-center gap-2">
                {/* Hidden rather than disabled while calling is switched off,
                    matching every other dial affordance in the CRM. */}
                {callingEnabled && (
                  <button
                    onClick={() => {
                      // Dial inside the click — the Quo app handoff is only
                      // honoured from a real gesture — then open the panel on
                      // this lead so the rep can log the outcome.
                      if (!dial(current.phone)) return;
                      router.push(`/calling?leadId=${current.leadId}&autocall=1`);
                    }}
                    className="inline-flex items-center gap-2 rounded-full bg-[var(--brand)] px-4 py-2 text-[12.5px] font-semibold text-white hover:opacity-90"
                  >
                    <Phone className="h-4 w-4" /> Call Now
                  </button>
                )}
                <button
                  onClick={() => { setRescheduling(current.leadId); setNewTime(''); }}
                  className="inline-flex items-center gap-1.5 rounded-full border px-3 py-2 text-[12px] font-semibold hover:bg-muted"
                >
                  <CalendarClock className="h-3.5 w-3.5" /> Reschedule
                </button>
                <button
                  onClick={() => dismiss.mutate(current.leadId)}
                  disabled={busy}
                  title="Stop reminding me — the callback stays scheduled"
                  className="inline-flex items-center gap-1.5 rounded-full border px-3 py-2 text-[12px] font-semibold hover:bg-muted disabled:opacity-50"
                >
                  <BellOff className="h-3.5 w-3.5" /> Dismiss
                </button>
              </div>

              <div className="mt-2.5 flex items-center gap-1.5">
                <span className="text-[11px] font-semibold text-muted-foreground">Snooze</span>
                {SNOOZE_OPTIONS.map((o) => (
                  <button
                    key={o.minutes}
                    onClick={() => snooze.mutate({ leadId: current.leadId, minutes: o.minutes })}
                    disabled={busy}
                    className="rounded-full border px-2.5 py-1 text-[11px] font-semibold hover:bg-muted disabled:opacity-50"
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Desktop notification for each callback as it first comes due.
 *
 * Fires once per lead per session — `seen` is what stops the 30-second poll
 * turning into a notification every 30 seconds, which is the failure mode that
 * gets browser notifications switched off for good. The in-CRM popup is what
 * persists; this is only the tap on the shoulder for a rep looking elsewhere.
 *
 * Permission is requested on the first due callback rather than at load: asking
 * an unprompted permission dialog on page one is how it gets denied outright.
 */
function useDesktopNotifications(due: DueCallback[]) {
  const seen = useRef(new Set<string>());
  const asked = useRef(false);

  useEffect(() => {
    if (due.length === 0) return;
    if (typeof window === 'undefined' || !('Notification' in window)) return;

    const fresh = due.filter((c) => !seen.current.has(c.leadId));
    if (fresh.length === 0) return;

    const show = () => {
      for (const c of fresh) {
        seen.current.add(c.leadId);
        try {
          const n = new Notification(
            c.status === 'overdue' ? `Overdue callback: ${c.businessName}` : `Callback due: ${c.businessName}`,
            {
              body: `${c.phone}\n${c.callbackAtLabel}${c.timezone ? ` (${c.timezone})` : ''}`,
              // Same tag per lead, so a re-fire replaces the old toast rather
              // than stacking a second one for the same callback.
              tag: `callback-${c.leadId}`,
            },
          );
          n.onclick = () => { window.focus(); n.close(); };
        } catch {
          // Some browsers throw for constructed notifications outside a service
          // worker. The popup is the real reminder — nothing to recover here.
        }
      }
    };

    if (Notification.permission === 'granted') {
      show();
    } else if (Notification.permission === 'default' && !asked.current) {
      asked.current = true;
      void Notification.requestPermission().then((p) => {
        if (p === 'granted') show();
      });
    }
  }, [due]);
}

/** Pull the API's message off an axios error, so the rep sees why it was refused. */
function apiMessage(e: unknown): string | null {
  const msg = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
  if (Array.isArray(msg)) return msg[0] ?? null;
  return msg ?? null;
}
