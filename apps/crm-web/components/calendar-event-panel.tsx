'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, CheckCircle2, ExternalLink, ListTodo, Phone, PhoneCall, User as UserIcon, Video, X, XCircle } from 'lucide-react';
import { tasksApi, type CalendarEvent } from '@/lib/crm';
import { leadsApi } from '@/lib/leads';
import { zoomApi } from '@/lib/zoom';
import { CallbackStatusPill } from '@/components/callback-status-pill';
import { hasLeadZone, isPastInLeadZone, leadWallClockToInstant, wallClockInLeadZone, zoneLabel } from '@/lib/timezone';
import { fromWallClock, isOverdue, outsideCustomerHours, wallClockIn } from '@/lib/calendar-grid';
import { isPast, meetingOpen, moveBlocker, moveEvent } from '@/lib/calendar-actions';
import { userZoneAbbrev } from '@/lib/display-settings';

const KIND: Record<CalendarEvent['type'], { label: string; icon: typeof Phone }> = {
  call: { label: 'Scheduled call', icon: Phone },
  callback: { label: 'Callback', icon: PhoneCall },
  zoom: { label: 'Zoom meeting', icon: Video },
  task: { label: 'Task', icon: ListTodo },
};

/**
 * One calendar item, opened: who and when, and what can be done about it.
 *
 * Every action is one the CRM already has. Rescheduling a call or callback
 * moves the lead's Next Follow-up (which moves its callback with it, exactly
 * as editing the lead does); a meeting is moved, completed or cancelled
 * through the Zoom module; a task moves its due date or is marked done.
 * A lead's time is typed on the CUSTOMER's clock, the same as everywhere a
 * follow-up is booked, and the zone is named beside the box. A task has no
 * customer, so it's typed on the calendar's own clock.
 */
export function CalendarEventPanel({ event, displayTime, tz, now, onClose }: {
  event: CalendarEvent; displayTime: string; tz: string; now: number; onClose: () => void;
}) {
  const qc = useQueryClient();
  const panelRef = useRef<HTMLDivElement>(null);
  const isTask = event.type === 'task';
  const [when, setWhen] = useState(() => (isTask ? wallClockIn(event.date, tz) : wallClockInLeadZone(event.date, event.timezone)));
  const [rescheduling, setRescheduling] = useState(false);
  const kind = KIND[event.type];
  const Icon = kind.icon;
  const overdue = isOverdue(event, now);
  const open = meetingOpen(event);

  // Escape closes; focus starts on the panel so the keyboard is inside it.
  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const done = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ['calendar'] }), qc.invalidateQueries({ queryKey: ['tasks'] })]);
    onClose();
  };

  const reschedule = useMutation({
    mutationFn: async () => {
      if (event.type === 'call' || event.type === 'callback') {
        // The lead's Next Follow-up, typed on its own clock — the API reads it there.
        return leadsApi.update(event.leadRef!, { nextFollowUpDate: when });
      }
      const at = isTask ? fromWallClock(when, tz) : leadWallClockToInstant(when, event.timezone);
      if (!at) throw new Error('Pick a valid date and time.');
      return moveEvent(event, at);
    },
    meta: { successMessage: 'Rescheduled' },
    onSuccess: done,
  });
  const complete = useMutation({
    mutationFn: (): Promise<unknown> => (isTask ? tasksApi.setStatus(event.taskId!, 'done') : zoomApi.complete(event.meetingId!, {})),
    meta: { successMessage: isTask ? 'Task done' : 'Meeting marked done' },
    onSuccess: done,
  });
  const cancel = useMutation({
    mutationFn: () => zoomApi.cancel(event.meetingId!),
    meta: { successMessage: 'Meeting cancelled' },
    onSuccess: done,
  });

  const past = !!when && (isTask ? !!fromWallClock(when, tz) && isPast(fromWallClock(when, tz)!, now) : isPastInLeadZone(when, event.timezone));
  // Only a lead's time has a customer to be out of hours for.
  const offHours = !isTask && !!when && hasLeadZone(event.timezone) ? outsideCustomerHours(when) : null;
  const blocker = moveBlocker(event);
  // The same rule the drag uses, so the panel and the grid never disagree about what can move.
  const canReschedule = !blocker;
  const busy = reschedule.isPending || complete.isPending || cancel.isPending;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/30" />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${kind.label}: ${event.companyName}`}
        className="relative flex h-full w-full max-w-[420px] flex-col overflow-y-auto border-l bg-card shadow-2xl outline-none"
      >
        <header className="flex items-start gap-3 border-b p-5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-muted"><Icon className="h-5 w-5" aria-hidden /></span>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{kind.label}</div>
            <h2 className="mt-0.5 break-words font-display text-[16px] font-semibold leading-snug">{event.companyName}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {event.callbackStatus && <CallbackStatusPill status={event.callbackStatus} />}
              {overdue && event.type !== 'callback' && (
                <span className="rounded-full bg-[var(--tone-red-bg)] px-2 py-[2px] text-[10.5px] font-semibold text-[var(--tone-red-fg-2)]">Overdue</span>
              )}
              <span className="rounded-full bg-muted px-2 py-[2px] text-[10.5px] font-semibold capitalize">{event.status === 'todo' ? 'To do' : event.status.replace(/_/g, ' ')}</span>
              {event.priority && <span className="rounded-full bg-muted px-2 py-[2px] text-[10.5px] font-semibold capitalize">{event.priority} priority</span>}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </header>

        <dl className="space-y-3 border-b p-5 text-[12.5px]">
          <div>
            <dt className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{isTask ? 'Due' : 'When'}</dt>
            <dd className="mt-0.5 font-semibold">{event.atLabel}</dd>
            {/* Only when it differs — an Eastern lead on an Eastern calendar would say the same thing twice. */}
            {!isTask && !event.atLabel.includes(displayTime) && <dd className="text-muted-foreground">{displayTime} on your calendar</dd>}
          </div>
          {!isTask && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <dt className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Contact</dt>
                <dd className="mt-0.5">{event.leadName ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Lead ID</dt>
                <dd className="mt-0.5 tabular-nums">{event.leadId || '—'}</dd>
              </div>
            </div>
          )}
          <div>
            <dt className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">Owner</dt>
            <dd className="mt-0.5 flex items-center gap-1.5"><UserIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden /> {event.assignedTo ?? 'Unassigned'}</dd>
          </div>
        </dl>

        <div className="space-y-2.5 p-5">
          {event.leadRef && (
            <Link href={`/leads/${event.leadRef}`} className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-[13px] font-semibold text-primary-foreground hover:opacity-90">
              <ExternalLink className="h-4 w-4" aria-hidden /> Open lead{event.type === 'zoom' ? '' : ' to call'}
            </Link>
          )}
          {isTask && (
            <div className="grid grid-cols-2 gap-2.5">
              <button type="button" disabled={busy} onClick={() => complete.mutate()} className="flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-[12.5px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
                <CheckCircle2 className="h-4 w-4" aria-hidden /> Mark done
              </button>
              <Link href="/tasks" className="flex items-center justify-center gap-2 rounded-md border bg-card px-3 py-2 text-[12.5px] font-semibold hover:bg-muted">
                <ExternalLink className="h-4 w-4" aria-hidden /> Open tasks
              </Link>
            </div>
          )}
          {event.type === 'zoom' && (
            <div className="grid grid-cols-2 gap-2.5">
              {event.joinUrl && open ? (
                <a href={event.joinUrl} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 rounded-md border bg-card px-3 py-2 text-[12.5px] font-semibold hover:bg-muted">
                  <Video className="h-4 w-4" aria-hidden /> Join
                </a>
              ) : null}
              {event.meetingId && (
                <Link href={`/zoom/${event.meetingId}`} className="flex items-center justify-center gap-2 rounded-md border bg-card px-3 py-2 text-[12.5px] font-semibold hover:bg-muted">
                  Open meeting
                </Link>
              )}
            </div>
          )}

          {canReschedule && (
            rescheduling ? (
              <form
                className="space-y-2 rounded-lg border p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!past) reschedule.mutate();
                }}
              >
                <label className="block text-[11.5px] font-semibold">
                  {isTask ? 'New due time' : 'New time'}{' '}
                  <span className="font-normal text-muted-foreground">
                    · {isTask ? `your calendar (${userZoneAbbrev(tz)})` : `the customer’s clock (${zoneLabel(event.timezone)})`}
                  </span>
                  <input
                    type="datetime-local"
                    value={when}
                    onChange={(e) => setWhen(e.target.value)}
                    className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-[12.5px] font-normal"
                    required
                  />
                </label>
                {past && <p className="text-[11.5px] text-[var(--tone-red-fg-2)]">That time has already passed{isTask ? '' : ' for the customer'}.</p>}
                {!past && offHours && (
                  <p role="status" className="flex items-start gap-1.5 rounded-md bg-[var(--tone-amber-bg)] px-2 py-1.5 text-[11.5px] font-medium text-[var(--tone-amber-fg)]">
                    <AlertTriangle className="mt-[1px] h-3.5 w-3.5 shrink-0" aria-hidden /> {offHours}
                  </p>
                )}
                <div className="flex gap-2">
                  <button type="submit" disabled={busy || past || !when} className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-50">
                    {reschedule.isPending ? 'Saving…' : 'Save'}
                  </button>
                  <button type="button" onClick={() => setRescheduling(false)} className="rounded-md border px-3 py-1.5 text-[12px] font-semibold hover:bg-muted">Cancel</button>
                </div>
              </form>
            ) : (
              <button type="button" onClick={() => setRescheduling(true)} className="flex w-full items-center justify-center gap-2 rounded-md border bg-card px-3 py-2 text-[12.5px] font-semibold hover:bg-muted">
                <CalendarClock className="h-4 w-4" aria-hidden /> Reschedule
              </button>
            )
          )}

          {event.type === 'zoom' && open && event.meetingId && (
            <div className="grid grid-cols-2 gap-2.5">
              <button type="button" disabled={busy} onClick={() => complete.mutate()} className="flex items-center justify-center gap-2 rounded-md border bg-card px-3 py-2 text-[12.5px] font-semibold hover:bg-muted disabled:opacity-50">
                <CheckCircle2 className="h-4 w-4" aria-hidden /> Mark done
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => window.confirm(`Cancel the meeting with ${event.companyName}?`) && cancel.mutate()}
                className="flex items-center justify-center gap-2 rounded-md border bg-card px-3 py-2 text-[12.5px] font-semibold text-[var(--tone-red-fg-2)] hover:bg-muted disabled:opacity-50"
              >
                <XCircle className="h-4 w-4" aria-hidden /> Cancel meeting
              </button>
            </div>
          )}
          {(event.type === 'call' || event.type === 'callback') && (
            <p className="text-[11.5px] text-muted-foreground">
              A call is marked done by logging its outcome — open the lead to call.
              {blocker && <> {blocker}</>}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
