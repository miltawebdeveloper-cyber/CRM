'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Clock, Globe, Loader2 } from 'lucide-react';
import { leadsApi } from '@/lib/leads';
import { pushToast } from '@/lib/toast';
import {
  LEAD_TIMEZONES,
  describeWallClock,
  formatInUserZone,
  hasLeadZone,
  isPastInLeadZone,
  leadWallClockToInstant,
  nowInLeadZone,
  userZoneLabel,
  zoneLabel,
} from '@/lib/timezone';

/**
 * The callback date/time picker, in one place.
 *
 * The Calling Panel and the docked call widget both schedule callbacks, and they
 * used to do it differently: the panel split date and time and named the lead's
 * zone, the widget used a bare `datetime-local` with no zone mentioned at all —
 * which reads as the REP's local time to anyone looking at it, and is stored as
 * the customer's. Same appointment, two meanings. They now share this.
 *
 * What it guarantees, and why each part is here:
 *
 *  • A lead with no zone cannot be scheduled at all. The rep is asked to pick one
 *    first, inline, because sending them to Lead Management mid-call to fix it is
 *    how it gets skipped. The API refuses this case too — this is the version
 *    that tells them what to do about it.
 *  • Both clocks are shown. "10:00 AM EST" tells an agent in India nothing about
 *    their own day; "8:30 PM IST" beside it does.
 *  • A time already gone in the CUSTOMER's zone is refused before submit, on the
 *    same 60-second grace the API uses, so the form and the server agree.
 */
export interface CallbackSchedulerProps {
  leadId: string;
  /** The lead's configured zone, or null/'' when nobody has set one. */
  timezone?: string | null;
  /** Wall clock as typed, `YYYY-MM-DDTHH:mm`. Never carries a zone — see lib/timezone. */
  value: string;
  onChange: (wallClock: string) => void;
  /** Called when the lead's zone is set from here, so the parent can refresh it. */
  onTimezoneSet?: (tz: string) => void;
  className?: string;
}

/**
 * Whether the current input may be submitted. Exported so a parent can disable
 * its Save button on exactly the condition the form is complaining about,
 * instead of keeping a second copy of the rules that drifts.
 */
export function callbackInputError(value: string, timezone?: string | null): string | null {
  if (!hasLeadZone(timezone)) return 'This lead needs a time zone before a callback can be scheduled.';
  if (!value) return 'Pick a callback date and time.';
  if (!leadWallClockToInstant(value, timezone)) return 'That date and time could not be read.';
  if (isPastInLeadZone(value, timezone)) return "That time has already passed in the lead's time zone.";
  return null;
}

export function CallbackScheduler({
  leadId,
  timezone,
  value,
  onChange,
  onTimezoneSet,
  className = '',
}: CallbackSchedulerProps) {
  const qc = useQueryClient();
  const zoned = hasLeadZone(timezone);

  const setZone = useMutation({
    mutationFn: (tz: string) => leadsApi.update(leadId, { timezone: tz }),
    onSuccess: (_res, tz) => {
      pushToast('success', `Time zone set to ${tz}. Callback times are now read on the customer's clock.`);
      // Everything that renders this lead's times has to re-read them.
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['caller-leads'] });
      onTimezoneSet?.(tz);
    },
    onError: () => pushToast('error', 'Could not save the time zone.'),
  });

  // ── No zone: the picker is replaced by the thing that has to happen first ──
  if (!zoned) {
    return (
      <div className={`rounded-lg border border-[#e8d19a] bg-[#fdf8ec] p-3 ${className}`}>
        <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-[#8a5d0a]">
          <AlertTriangle className="h-4 w-4" /> This lead has no time zone
        </div>
        <p className="mb-2.5 text-[11px] leading-relaxed text-[#8a5d0a]">
          A callback is agreed on the customer&apos;s clock, so we need to know which one that is. Pick their time
          zone and the date and time fields will appear.
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {LEAD_TIMEZONES.map((z) => (
            <button
              key={z.value}
              type="button"
              disabled={setZone.isPending}
              onClick={() => setZone.mutate(z.value)}
              className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-[#d9b978] bg-card px-3 py-[5px] text-[11.5px] font-semibold text-[#8a5d0a] hover:bg-[#f6ead0] disabled:opacity-50"
            >
              {setZone.isPending && setZone.variables === z.value ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Globe className="h-3 w-3" />
              )}
              {z.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const leadToday = nowInLeadZone(timezone).slice(0, 10);
  const date = value ? value.slice(0, 10) : '';
  const time = value ? value.slice(11, 16) : '';
  const past = !!value && isPastInLeadZone(value, timezone);
  const instant = value ? leadWallClockToInstant(value, timezone) : null;

  return (
    <div className={className}>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Callback Date</span>
          <input
            type="date"
            value={date}
            // Floored at the customer's today, not the rep's. Those are a
            // different date for several hours of every day, and a picker that
            // opens on the rep's can offer a day already gone where the
            // customer is.
            min={leadToday}
            onChange={(e) => onChange(`${e.target.value}T${time || '09:00'}`)}
            className={`w-full rounded-md border bg-background px-3 py-2 ${past ? 'border-[#a8431f]' : ''}`}
            required
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Callback Time</span>
          <input
            type="time"
            value={time}
            onChange={(e) => onChange(`${date || leadToday}T${e.target.value}`)}
            className={`w-full rounded-md border bg-background px-3 py-2 ${past ? 'border-[#a8431f]' : ''}`}
            required
          />
        </label>
      </div>

      {/* Both clocks, side by side. This is the whole point of the component:
          the rep confirms the customer's time AND sees what it means for them. */}
      {value && instant && !past && (
        <div className="mt-2 grid gap-1.5 rounded-lg border bg-muted/40 p-2.5 sm:grid-cols-2">
          <div className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[.08em] text-muted-foreground">Lead&apos;s time</div>
              <div className="truncate text-[12px] font-semibold">{describeWallClock(value, timezone)}</div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[.08em] text-muted-foreground">
                Your local time ({userZoneLabel()})
              </div>
              <div className="truncate text-[12px] font-semibold">{formatInUserZone(instant)}</div>
            </div>
          </div>
        </div>
      )}

      {past && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-[#a8431f]">
          <AlertTriangle className="h-3.5 w-3.5" />
          That time has already passed for the lead ({describeWallClock(value, timezone)}). Pick a later one.
        </p>
      )}

      <p className="mt-1.5 text-[10.5px] text-muted-foreground">
        Times are entered in the lead&apos;s time zone —{' '}
        <span className="font-semibold text-foreground">
          {timezone} ({zoneLabel(timezone)})
        </span>
        .
      </p>
    </div>
  );
}
