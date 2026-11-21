import type { DateFilterValue } from '@/lib/date-filters';

/**
 * One-click date ranges — Today, Yesterday, This week, This month.
 *
 * They build exactly what the date picker builds for the same choice (same
 * modes, same Sunday-based week, same calendar month), so picking "This week"
 * here or in the calendar is the same filter, and the picker shows it the same
 * way. `today` is the BUSINESS day as a local-midnight Date
 * (lib/business-day: businessTodayLocal), passed in so this stays pure.
 */
export type QuickRange = 'today' | 'yesterday' | 'week' | 'month';

export const QUICK_RANGES: { value: QuickRange; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
];

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plusDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export function quickRange(kind: QuickRange, today: Date): DateFilterValue {
  switch (kind) {
    case 'today':
      return { mode: 'day', from: iso(today), to: iso(today) };
    case 'yesterday': {
      const y = plusDays(today, -1);
      return { mode: 'day', from: iso(y), to: iso(y) };
    }
    case 'week': {
      const start = plusDays(today, -today.getDay());
      return { mode: 'week', from: iso(start), to: iso(plusDays(start, 6)) };
    }
    case 'month':
      return {
        mode: 'month',
        from: iso(new Date(today.getFullYear(), today.getMonth(), 1)),
        to: iso(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
      };
  }
}

/** Which quick range a filter currently is, if any — so its chip can show as on. */
export function activeQuickRange(value: DateFilterValue, today: Date): QuickRange | null {
  for (const { value: kind } of QUICK_RANGES) {
    const r = quickRange(kind, today);
    if (r.mode === value.mode && r.from === value.from && r.to === value.to) return kind;
  }
  return null;
}
