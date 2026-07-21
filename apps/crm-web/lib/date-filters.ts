export type DateRangeValue = '' | 'today' | 'yesterday' | '7d' | '30d';

export function inDateRange(iso: string | null | undefined, range: DateRangeValue): boolean {
  if (!range) return true;
  if (!iso) return false;

  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;

  const now = new Date();
  const startOfDay = (date: Date) => {
    const n = new Date(date);
    n.setHours(0, 0, 0, 0);
    return n;
  };

  const dayDiff = (days: number) => {
    const start = startOfDay(now);
    start.setDate(start.getDate() - days);
    return d >= start;
  };

  if (range === 'today') return d.toDateString() === now.toDateString();
  if (range === 'yesterday') {
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    return d.toDateString() === y.toDateString();
  }
  if (range === '7d') return dayDiff(7);
  if (range === '30d') return dayDiff(30);
  return true;
}

export interface DateBounds {
  from?: string; // yyyy-mm-dd
  to?: string; // yyyy-mm-dd
}

/** Calendar range filter value used by DateRangePicker ('' = unbounded). */
export interface DateRange {
  from: string; // yyyy-mm-dd | ''
  to: string; // yyyy-mm-dd | ''
}

/** Convenience empty range. */
export const EMPTY_RANGE: DateRange = { from: '', to: '' };

/** Modes for the Lead Management date filter. */
export type DateMode = 'all' | 'day' | 'week' | 'month' | 'year' | 'custom';

/** Date-filter value: the mode plus the resolved `{from,to}` bounds it maps to. */
export interface DateFilterValue extends DateRange {
  mode: DateMode;
}

/** Empty (all-dates) filter. */
export const EMPTY_DATE_FILTER: DateFilterValue = { mode: 'all', from: '', to: '' };

/** Explicit calendar from/to filter (inclusive of both whole days). */
export function inDateBounds(iso: string | null | undefined, bounds: DateBounds): boolean {
  if (!bounds.from && !bounds.to) return true;
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;

  if (bounds.from) {
    const start = new Date(bounds.from);
    start.setHours(0, 0, 0, 0);
    if (d < start) return false;
  }
  if (bounds.to) {
    const end = new Date(bounds.to);
    end.setHours(23, 59, 59, 999);
    if (d > end) return false;
  }
  return true;
}
