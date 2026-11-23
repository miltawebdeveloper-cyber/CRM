'use client';

import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import type { CalendarEvent } from '@/lib/crm';
import { CustomerTimeNote } from '@/components/customer-time-note';
import { atOnClock } from '@/lib/calendar-grid';
import { isPast, moveEvent } from '@/lib/calendar-actions';

/**
 * The confirm step after a drag: from → to on the calendar's clock, what that
 * is for the customer, and a warning if it's outside their working day.
 *
 * A drag is easy to do by accident, and a moved callback changes what the
 * customer was told — so nothing is saved until this is confirmed. The panel
 * stays pending until the calendar has re-read, so the item never jumps back to
 * its old slot in between.
 */
export function CalendarMoveDialog({ event, at, tz, now, onClose }: {
  event: CalendarEvent; at: Date; tz: string; now: number; onClose: () => void;
}) {
  const qc = useQueryClient();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const past = isPast(at, now);

  const move = useMutation({
    mutationFn: () => moveEvent(event, at),
    meta: { successMessage: 'Rescheduled' },
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['calendar'] }), qc.invalidateQueries({ queryKey: ['tasks'] })]);
      onClose();
    },
  });

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !move.isPending && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, move.isPending]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <button type="button" aria-label="Cancel" onClick={() => !move.isPending && onClose()} className="absolute inset-0 bg-black/30" />
      <div role="alertdialog" aria-modal="true" aria-labelledby="cal-move-title" className="relative w-full max-w-[400px] rounded-2xl border bg-card p-5 shadow-2xl">
        <h2 id="cal-move-title" className="font-display text-[15px] font-semibold">Move {event.type === 'task' ? 'task' : 'this'}?</h2>
        <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">{event.companyName}</p>

        <dl className="mt-4 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-[12.5px]">
          <dt className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">From</dt>
          <dd className="text-muted-foreground line-through decoration-muted-foreground/60">{atOnClock(event.date, tz)}</dd>
          <dt className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">To</dt>
          <dd className="flex items-center gap-1.5 font-semibold">
            <ArrowRight className="h-3.5 w-3.5 text-primary" aria-hidden /> {atOnClock(at, tz)}
          </dd>
        </dl>

        <div className="mt-3">
          {past ? (
            <p className="text-[11.5px] text-[var(--tone-red-fg-2)]">That time has already passed — drag it somewhere later.</p>
          ) : (
            event.type !== 'task' && <CustomerTimeNote at={at} timezone={event.timezone} displayTz={tz} />
          )}
          {event.type === 'call' && !past && (
            <p className="mt-1.5 text-[11.5px] text-muted-foreground">This moves the lead’s next follow-up, and its callback with it.</p>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={move.isPending} className="rounded-md border px-3.5 py-1.5 text-[12.5px] font-semibold hover:bg-muted disabled:opacity-50">Cancel</button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => move.mutate()}
            disabled={past || move.isPending}
            className="rounded-md bg-primary px-3.5 py-1.5 text-[12.5px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {move.isPending ? 'Moving…' : 'Move'}
          </button>
        </div>
      </div>
    </div>
  );
}
