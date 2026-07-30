import { AlertTriangle, Bell, Check, Clock } from 'lucide-react';
import { CALLBACK_STATUS_STYLE, type CallbackStatus } from '@/lib/callbacks';

const ICON = { upcoming: Clock, due: Bell, overdue: AlertTriangle, completed: Check } as const;

/**
 * Upcoming / Due Now / Overdue / Completed, rendered the same way everywhere.
 *
 * The colours and labels come from `lib/callbacks`, which mirrors the API's
 * `callback-status.ts`. Before this, each page decided for itself what counted
 * as overdue, so the same appointment could be amber in one list and red in
 * another — and neither matched the "Missed Callback" e-mail.
 */
export function CallbackStatusPill({
  status,
  className = '',
}: {
  status: CallbackStatus | null;
  className?: string;
}) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  const s = CALLBACK_STATUS_STYLE[status];
  const Icon = ICON[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${className}`}
      style={{ background: s.bg, color: s.fg }}
    >
      <Icon className="h-3 w-3" /> {s.label}
    </span>
  );
}
