import { AlertTriangle } from 'lucide-react';
import { atOnClock, outsideCustomerHours, wallClockIn, weekday } from '@/lib/calendar-grid';
import { formatInLeadZone, hasLeadZone, wallClockInLeadZone } from '@/lib/timezone';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * What a proposed time is for the CUSTOMER, and a warning when it falls outside
 * their working day (9 AM – 6 PM, Monday to Friday, on their own clock).
 *
 * The calendar is drawn on the rep's clock; this is the line that stops a rep
 * dragging a call to "2 PM" without noticing it's 11 AM for one customer and
 * 7 PM on a Friday for another. It warns rather than blocks.
 */
export function CustomerTimeNote({ at, timezone, displayTz }: { at: Date; timezone: string | null; displayTz: string }) {
  if (!hasLeadZone(timezone)) return null;
  const theirWall = wallClockInLeadZone(at, timezone);
  const warning = outsideCustomerHours(theirWall);
  // "Thu, Nov 26, 5:00 AM PST" — the shared formatter, with the day named and no leading zero on the hour.
  const theirs = `${DOW[weekday(theirWall.slice(0, 10))]}, ${formatInLeadZone(at.toISOString(), timezone).replace(/, 0(\d):/, ', $1:')}`;
  // Your calendar's reading only when the two clocks differ — an Eastern lead on
  // an Eastern calendar would say the same thing twice.
  const sameClock = theirWall === wallClockIn(at, displayTz);
  return (
    <div className="space-y-1.5 text-[11.5px]">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-muted-foreground">Customer</dt>
        <dd className="font-semibold">{theirs}</dd>
        {!sameClock && (
          <>
            <dt className="text-muted-foreground">Your calendar</dt>
            <dd>{atOnClock(at, displayTz)}</dd>
          </>
        )}
      </dl>
      {warning && (
        <p role="status" className="flex items-start gap-1.5 rounded-md bg-[var(--tone-amber-bg)] px-2 py-1.5 font-medium text-[var(--tone-amber-fg)]">
          <AlertTriangle className="mt-[1px] h-3.5 w-3.5 shrink-0" aria-hidden /> {warning}
        </p>
      )}
    </div>
  );
}
