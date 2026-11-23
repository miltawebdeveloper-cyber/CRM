import type { PendingCall } from '@/lib/crm';

/** One employee's pending calls, day by day — oldest day first. */
export interface PendingGroup {
  owner: { id: string; name: string };
  total: number;
  days: { day: string; items: PendingCall[] }[];
}

/**
 * Employee-wise, then date-wise: the shape of the Pending Calls page. The day a
 * call sits under is the day it was ASSIGNED for — the original date it keeps
 * while it waits — falling back to its scheduled day for a call from before
 * assignments were recorded. Order inside a day is the server's (import order).
 */
export function groupPending(items: PendingCall[]): PendingGroup[] {
  const groups = new Map<string, PendingGroup>();
  for (const it of items) {
    const g = groups.get(it.owner.id) ?? { owner: it.owner, total: 0, days: [] };
    groups.set(it.owner.id, g);
    const day = it.assignedOn ?? it.scheduledFor;
    let bucket = g.days.find((d) => d.day === day);
    if (!bucket) {
      bucket = { day, items: [] };
      g.days.push(bucket);
    }
    bucket.items.push(it);
    g.total += 1;
  }
  const out = [...groups.values()].sort((a, b) => a.owner.name.localeCompare(b.owner.name) || a.owner.id.localeCompare(b.owner.id));
  for (const g of out) g.days.sort((a, b) => a.day.localeCompare(b.day));
  return out;
}

/** The next Monday-to-Friday day after `ymd` — the default new date for a pending call. */
export function nextWeekday(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  do t.setUTCDate(t.getUTCDate() + 1);
  while (t.getUTCDay() === 0 || t.getUTCDay() === 6);
  return t.toISOString().slice(0, 10);
}

/** "Fri, Nov 21" for a yyyy-mm-dd day (a date, so read as UTC and never shifted). */
export function dayLabel(ymd: string): string {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Whole days from `from` to `to` (both yyyy-mm-dd). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// ── What the managers' view filters and shows ──

/** How long a call has waited, as a tone: 0–1 day fresh, 2–3 aging, 4+ old. */
export type AgeTone = 'fresh' | 'aging' | 'old';
export function ageTone(days: number): AgeTone {
  if (days >= 4) return 'old';
  if (days >= 2) return 'aging';
  return 'fresh';
}

/** "1 day waiting" · "5 days waiting". */
export const waitingLabel = (days: number) => `${days} day${days === 1 ? '' : 's'} waiting`;

/** The day a pending call sits under: the day it was assigned for. */
export const pendingDay = (it: PendingCall) => it.assignedOn ?? it.scheduledFor;

export type PendingKind = 'all' | 'untried' | 'tried' | 'old';

/** Waiting this many days or more is "old" for the quick filter. */
export const OLD_AFTER_DAYS = 3;

export function matchesKind(it: PendingCall, kind: PendingKind, today: string): boolean {
  if (kind === 'untried') return it.attempts === 0;
  if (kind === 'tried') return it.attempts > 0;
  if (kind === 'old') return daysBetween(pendingDay(it), today) >= OLD_AFTER_DAYS;
  return true;
}

/** Company, contact, phone (digits only, so any formatting matches) or lead ID. */
export function matchesSearch(it: PendingCall, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  const digits = s.replace(/\D/g, '');
  return (
    it.businessName.toLowerCase().includes(s) ||
    (it.contactName ?? '').toLowerCase().includes(s) ||
    it.leadId.toLowerCase().includes(s) ||
    (digits.length >= 3 && (it.phone ?? '').replace(/\D/g, '').includes(digits))
  );
}

/** Each employee's backlog at a glance — the cards above the list. */
export interface OwnerSummary {
  owner: { id: string; name: string };
  count: number;
  untried: number;
  /** The oldest day among their pending calls. */
  oldest: string;
}
export function summarizeByOwner(items: PendingCall[]): OwnerSummary[] {
  const m = new Map<string, OwnerSummary>();
  for (const it of items) {
    const s = m.get(it.owner.id) ?? { owner: it.owner, count: 0, untried: 0, oldest: pendingDay(it) };
    s.count += 1;
    if (it.attempts === 0) s.untried += 1;
    if (pendingDay(it) < s.oldest) s.oldest = pendingDay(it);
    m.set(it.owner.id, s);
  }
  return [...m.values()].sort((a, b) => a.owner.name.localeCompare(b.owner.name) || a.owner.id.localeCompare(b.owner.id));
}

/**
 * The quick choices of a new date: the next working day, the one after, and
 * next Monday when that's further out — each `{ label, day }`.
 */
export function quickDays(today: string): { label: string; day: string }[] {
  const first = nextWeekday(today);
  const second = nextWeekday(first);
  const out = [
    { label: 'Next working day', day: first },
    { label: 'The day after', day: second },
  ];
  const [y, m, d] = today.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  do t.setUTCDate(t.getUTCDate() + 1);
  while (t.getUTCDay() !== 1);
  const monday = t.toISOString().slice(0, 10);
  if (monday > second) out.push({ label: 'Next Monday', day: monday });
  return out;
}
