/**
 * The period just before a date range, the same number of days long — what
 * the ▲/▼ badges compare against. 1–7 Nov compares with 25–31 Oct; a single
 * day with the day before. The same rule as the dashboard's (metrics:
 * previousPeriod), worked on calendar days with no clock involved.
 */
const DAY = 86_400_000;
const toUtc = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Days in an inclusive yyyy-mm-dd range. */
export function daysIn(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY) + 1;
}

/** The previous period, or null without both ends (nothing to compare with). */
export function previousRange(from?: string, to?: string): { from: string; to: string; days: number } | null {
  if (!from || !to) return null;
  const days = daysIn(from, to);
  if (days < 1) return null;
  const end = toUtc(from) - DAY;
  return { from: fromUtc(end - (days - 1) * DAY), to: fromUtc(end), days };
}
