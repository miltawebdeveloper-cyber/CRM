'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarPlus, X } from 'lucide-react';
import { tasksApi, type TaskPriority } from '@/lib/crm';
import { leadsApi, type Lead } from '@/lib/leads';
import { zoomApi } from '@/lib/zoom';
import { Segmented } from '@/components/segmented';
import { CustomerTimeNote } from '@/components/customer-time-note';
import { useDebounced } from '@/lib/use-debounced';
import { userZoneAbbrev } from '@/lib/display-settings';
import { formatInLeadZone, hasLeadZone, leadWallClockToInstant, wallClockInLeadZone, zoneLabel } from '@/lib/timezone';
import { atOnClock, fromWallClock, wallClockIn } from '@/lib/calendar-grid';
import { isPast } from '@/lib/calendar-actions';

type Kind = 'callback' | 'zoom' | 'task';
const PICKER_ROWS = 8;
const DURATIONS = [15, 30, 45, 60, 90];

/**
 * Book something straight onto the calendar: a callback or a Zoom meeting with
 * a lead, or a task of your own.
 *
 * It opens on the slot that was clicked, read on the calendar's clock. Once a
 * lead is chosen the time box switches to the CUSTOMER's clock — the clock
 * everything with a lead is booked on in this CRM — with the zone named and a
 * warning if it's outside their working day. Each booking goes through the
 * module that owns it: a callback is the lead's Next Follow-up (exactly as
 * editing the lead books one), a meeting is created by the Zoom module (which
 * files its own task), a task by the task board.
 */
export function CalendarNewPanel({ initialAt, tz, now, allowTask, onClose }: {
  initialAt: Date; tz: string; now: number; allowTask: boolean; onClose: () => void;
}) {
  const qc = useQueryClient();
  const panelRef = useRef<HTMLFormElement>(null);
  const [kind, setKind] = useState<Kind>('callback');
  const [at, setAt] = useState(initialAt);
  const [lead, setLead] = useState<Lead | null>(null);
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 250);
  const [duration, setDuration] = useState(30);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');

  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const needsLead = kind !== 'task';
  const { data: leads = [], isFetching: searching } = useQuery({
    queryKey: ['leads', 'calendar-picker', debounced],
    queryFn: () => leadsApi.list({ q: debounced || undefined, pageSize: PICKER_ROWS, sortBy: 'createdAt', sortDir: 'desc' }),
    enabled: needsLead && !lead,
  });

  // Which clock the time box is on: the customer's once there is one, otherwise the calendar's.
  const leadClock = needsLead && !!lead && hasLeadZone(lead.timezone);
  const wall = leadClock ? wallClockInLeadZone(at, lead!.timezone) : wallClockIn(at, tz);
  const setWall = (v: string) => {
    const next = leadClock ? leadWallClockToInstant(v, lead!.timezone) : fromWallClock(v, tz);
    if (next) setAt(next);
  };

  const noZone = needsLead && !!lead && !hasLeadZone(lead.timezone);
  const past = isPast(at, now);
  const pendingCallback = kind === 'callback' && lead?.callbackAt && !lead.callbackCompletedAt ? lead.callbackAt : null;
  const ready = !past && (kind === 'task' ? !!title.trim() : !!lead && !noZone);

  const save = useMutation({
    mutationFn: async () => {
      if (kind === 'task') return tasksApi.create(title.trim(), priority, at.toISOString());
      // A lead's time goes as its own wall clock — that's how the API reads it.
      const theirs = wallClockInLeadZone(at, lead!.timezone);
      if (kind === 'zoom') return zoomApi.create({ leadId: lead!.id, scheduledAt: theirs, durationMins: duration, title: title.trim() || undefined });
      return leadsApi.update(lead!.id, { nextFollowUpDate: theirs });
    },
    meta: { successMessage: kind === 'task' ? 'Task added' : kind === 'zoom' ? 'Meeting scheduled' : 'Callback booked' },
    onSuccess: async () => {
      // Wait for the calendar to come back, so the new item is there when the panel closes.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['calendar'] }),
        qc.invalidateQueries({ queryKey: ['tasks'] }),
        qc.invalidateQueries({ queryKey: ['leads'] }),
      ]);
      onClose();
    },
  });

  const kinds = [
    { label: 'Callback', value: 'callback' as Kind },
    { label: 'Zoom meeting', value: 'zoom' as Kind },
    ...(allowTask ? [{ label: 'Task', value: 'task' as Kind }] : []),
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/30" />
      <form
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Book on the calendar"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !save.isPending) save.mutate();
        }}
        className="relative flex h-full w-full max-w-[420px] flex-col overflow-y-auto border-l bg-card shadow-2xl outline-none"
      >
        <header className="flex items-start gap-3 border-b p-5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-muted"><CalendarPlus className="h-5 w-5" aria-hidden /></span>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">New on your calendar</div>
            <h2 className="mt-0.5 font-display text-[16px] font-semibold leading-snug">{atOnClock(at, tz)}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 p-5">
          <Segmented options={kinds} value={kind} onChange={setKind} />

          {needsLead && (
            <div>
              <div className="mb-1 text-[11.5px] font-semibold">Lead</div>
              {lead ? (
                <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-[12.5px]">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-semibold">{lead.businessName}</span>
                    <span className="text-muted-foreground"> · {[lead.contactName, lead.state].filter(Boolean).join(', ')}</span>
                  </span>
                  <button type="button" onClick={() => { setLead(null); setSearch(''); }} className="shrink-0 text-[11.5px] font-semibold text-muted-foreground hover:text-foreground">
                    Change
                  </button>
                </div>
              ) : (
                <>
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search company, contact, phone or lead ID…"
                    aria-label="Search leads"
                    className="w-full rounded-md border bg-background px-3 py-2 text-[12.5px]"
                  />
                  <div className="mt-1.5 max-h-[220px] overflow-y-auto rounded-md border">
                    {leads.length === 0 ? (
                      <p className="px-3 py-2.5 text-[12px] text-muted-foreground">{searching ? 'Searching…' : search ? 'No lead matches that.' : 'No leads yet.'}</p>
                    ) : leads.map((l) => (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() => setLead(l)}
                        className="block w-full border-b px-3 py-2 text-left text-[12.5px] last:border-0 hover:bg-muted"
                      >
                        <span className="block truncate font-semibold">{l.businessName}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {[l.contactName, l.leadId, l.timezone ? zoneLabel(l.timezone) : 'No timezone'].filter(Boolean).join(' · ')}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {(kind === 'task' || kind === 'zoom') && (
            <label className="block text-[11.5px] font-semibold">
              {kind === 'task' ? 'What needs doing' : 'Title'} {kind === 'zoom' && <span className="font-normal text-muted-foreground">· optional</span>}
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={kind === 'task' ? 'e.g. Send the proposal' : 'e.g. Product demo'}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-[12.5px] font-normal"
                required={kind === 'task'}
              />
            </label>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
            <label className="block text-[11.5px] font-semibold">
              {kind === 'task' ? 'Due' : 'Time'}{' '}
              <span className="font-normal text-muted-foreground">
                · {leadClock ? `the customer’s clock (${zoneLabel(lead!.timezone)})` : `your calendar (${userZoneAbbrev(tz)})`}
              </span>
              <input
                type="datetime-local"
                value={wall}
                onChange={(e) => setWall(e.target.value)}
                className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-[12.5px] font-normal"
                required
              />
            </label>
            {kind === 'zoom' && (
              <label className="block text-[11.5px] font-semibold">
                Length
                <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="mt-1 w-full rounded-md border bg-background px-2.5 py-[7px] text-[12.5px] font-normal">
                  {DURATIONS.map((d) => <option key={d} value={d}>{d} min</option>)}
                </select>
              </label>
            )}
            {kind === 'task' && (
              <label className="block text-[11.5px] font-semibold">
                Priority
                <select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)} className="mt-1 w-full rounded-md border bg-background px-2.5 py-[7px] text-[12.5px] font-normal">
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </label>
            )}
          </div>

          {past && <p className="text-[11.5px] text-[var(--tone-red-fg-2)]">That time has already passed — pick a later one.</p>}
          {!past && leadClock && <CustomerTimeNote at={at} timezone={lead!.timezone} displayTz={tz} />}
          {needsLead && !lead && <p className="text-[11.5px] text-muted-foreground">Pick the lead to see the time on the customer’s clock.</p>}
          {noZone && (
            <p className="flex items-start gap-1.5 rounded-md bg-[var(--tone-red-bg)] px-2 py-1.5 text-[11.5px] font-medium text-[var(--tone-red-fg-2)]">
              <AlertTriangle className="mt-[1px] h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                This lead has no timezone, so there’s no customer clock to book on.{' '}
                <Link href={`/leads/${lead!.id}`} className="underline">Set it on the lead</Link> first.
              </span>
            </p>
          )}
          {pendingCallback && !noZone && (
            <p className="text-[11.5px] text-muted-foreground">
              This replaces the callback already booked for {formatInLeadZone(pendingCallback, lead!.timezone)}.
            </p>
          )}
          {kind === 'task' && <p className="text-[11.5px] text-muted-foreground">Tasks are personal — this goes on your own task board.</p>}

          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={!ready || save.isPending} className="rounded-md bg-primary px-4 py-2 text-[12.5px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
              {save.isPending ? 'Saving…' : kind === 'task' ? 'Add task' : kind === 'zoom' ? 'Schedule meeting' : 'Book callback'}
            </button>
            <button type="button" onClick={onClose} className="rounded-md border px-4 py-2 text-[12.5px] font-semibold hover:bg-muted">Cancel</button>
          </div>
        </div>
      </form>
    </div>
  );
}
