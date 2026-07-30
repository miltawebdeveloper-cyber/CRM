/**
 * The four words the CRM uses for where a callback stands, defined once.
 *
 * Dashboard, Calendar, the Today list and the reminder popup all used to decide
 * this for themselves, so the same appointment could read "Today" in one place
 * and be counted as overdue in another. They now all ask this module.
 *
 *   upcoming  — scheduled, not yet time
 *   due       — the scheduled time has arrived (and the grace period hasn't run out)
 *   overdue   — still open more than an hour past the scheduled time
 *   completed — the rep marked it done
 */
export type CallbackStatus = 'upcoming' | 'due' | 'overdue' | 'completed';

/**
 * How long a callback reads as "Due Now" before it becomes "Overdue". Matches
 * the reminder engine's missed-callback grace so the badge on screen and the
 * "Missed Callback" e-mail can never disagree about the same appointment.
 */
export const DUE_WINDOW_MS = 60 * 60 * 1000;

export function callbackStatus(
  callbackAt: Date | string | null | undefined,
  completedAt: Date | string | null | undefined,
  now: Date = new Date(),
): CallbackStatus | null {
  if (completedAt) return 'completed';
  if (!callbackAt) return null;
  const at = callbackAt instanceof Date ? callbackAt : new Date(callbackAt);
  if (Number.isNaN(at.getTime())) return null;

  const diff = at.getTime() - now.getTime();
  if (diff > 0) return 'upcoming';
  return diff > -DUE_WINDOW_MS ? 'due' : 'overdue';
}
