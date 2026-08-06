import { api } from './api';
import type { LeadTimezone } from './timezone';

/**
 * Callback reminders on the web side — the status vocabulary and the client for
 * the endpoints the reminder popup drives.
 *
 * The four statuses mirror `apps/crm-api/src/modules/callbacks/callback-status.ts`
 * exactly, including the one-hour Due window. They were previously each page's
 * own idea, which is how the same appointment could read "Today" in the
 * Follow-ups table while the Dashboard counted it overdue.
 */
export type CallbackStatus = 'upcoming' | 'due' | 'overdue' | 'completed';

/** Matches the API's `DUE_WINDOW_MS` and the reminder cron's missed grace. */
const DUE_WINDOW_MS = 60 * 60 * 1000;

export function callbackStatus(
  callbackAt: string | Date | null | undefined,
  completedAt?: string | Date | null,
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

/**
 * One palette for the four statuses, so a callback is the same colour wherever
 * it appears. Kept to the CRM's existing chip colours rather than inventing a
 * new set: amber for "needs you soon", red for "you're late".
 */
export const CALLBACK_STATUS_STYLE: Record<CallbackStatus, { label: string; fg: string; bg: string; dot: string }> = {
  upcoming: { label: 'Upcoming', fg: '#4a6b1f', bg: '#eef5e0', dot: 'var(--brand-lime)' },
  due: { label: 'Due Now', fg: '#8a5d0a', bg: '#fdf1de', dot: '#c98a18' },
  overdue: { label: 'Overdue', fg: '#8f2b1c', bg: '#fde9e6', dot: '#a8431f' },
  completed: { label: 'Completed', fg: '#2c6b4f', bg: 'var(--brand-tint-2)', dot: 'var(--brand-strong)' },
};

/** A callback as the reminder feeds return it. */
export interface DueCallback {
  leadId: string;
  businessName: string;
  contactName: string | null;
  phone: string;
  timezone: LeadTimezone | null;
  callbackAt: string;
  /** Pre-rendered in the customer's zone by the API, e.g. `Aug 5, 10:00 AM EDT`. */
  callbackAtLabel: string;
  status: CallbackStatus;
  snoozedUntil: string | null;
  dismissedAt: string | null;
}

export const callbacksApi = {
  /** Due or overdue, not snoozed or dismissed — what the popup should show now. */
  due: async (): Promise<DueCallback[]> => (await api.get('/callbacks/due')).data,
  /** Everything on the rep's plate today in the customer's zone, plus overdue. */
  today: async (): Promise<DueCallback[]> => (await api.get('/callbacks/today')).data,
  snooze: async (leadId: string, minutes: number) =>
    (await api.post(`/callbacks/${leadId}/snooze`, { minutes })).data,
  dismiss: async (leadId: string) => (await api.post(`/callbacks/${leadId}/dismiss`)).data,
};

/** Snooze choices offered on the popup. Short, because a callback is time-critical. */
export const SNOOZE_OPTIONS = [
  { label: '5 min', minutes: 5 },
  { label: '15 min', minutes: 15 },
  { label: '1 hour', minutes: 60 },
];
