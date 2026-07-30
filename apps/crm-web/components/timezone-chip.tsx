import { AlertTriangle } from 'lucide-react';

/**
 * A lead's time zone as a chip — and, when it has none, a visible prompt rather
 * than a blank.
 *
 * Leads used to be stamped Eastern by default, so this was never empty and never
 * needed to say anything. Now that an unconfigured lead is honestly blank, the
 * blank has to be legible: it is the one state that stops a callback being
 * scheduled, and the list is where somebody notices and fixes it.
 */
export function TimezoneChip({ tz, className = '' }: { tz?: string | null; className?: string }) {
  if (!tz) {
    return (
      <span
        title="No time zone set — a callback can't be scheduled for this lead until one is chosen"
        className={`inline-flex items-center gap-1 rounded-full bg-[#fbf3e2] px-2 py-0.5 text-[11px] font-semibold text-[#8a5d0a] ${className}`}
      >
        <AlertTriangle className="h-3 w-3" /> Not set
      </span>
    );
  }
  return (
    <span className={`rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold ${className}`}>{tz}</span>
  );
}
