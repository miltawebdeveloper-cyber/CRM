import type { CSSProperties } from 'react';
import { ListTodo, Phone, PhoneCall, Video, type LucideIcon } from 'lucide-react';
import type { ActivityType, CalendarEvent } from '@/lib/crm';
import { atOnClock, isOverdue, LOAD_ALPHA, loadLevel, timeIn, zoneParts } from '@/lib/calendar-grid';

/**
 * One look per activity type, from theme tokens so dark mode reads as well as
 * light. The chip and the dot of the legend share it.
 */
export const TYPE_META: Record<ActivityType, { label: string; plural: string; chip: string; dot: string; icon: LucideIcon }> = {
  call: { label: 'Scheduled call', plural: 'Calls', chip: 'bg-[var(--brand-surface)] text-[var(--brand-on-surface)]', dot: 'var(--viz-closed)', icon: Phone },
  callback: { label: 'Callback', plural: 'Callbacks', chip: 'bg-[var(--tone-amber-bg)] text-[var(--tone-amber-fg)]', dot: 'var(--viz-warm)', icon: PhoneCall },
  zoom: { label: 'Zoom meeting', plural: 'Zoom', chip: 'bg-[var(--tone-blue-bg)] text-[var(--tone-blue-fg)]', dot: 'var(--viz-cold)', icon: Video },
  task: { label: 'Task', plural: 'Tasks', chip: 'bg-[var(--tone-teal-bg)] text-[var(--tone-teal-fg)]', dot: 'var(--tone-teal-fg)', icon: ListTodo },
};
export const OVERDUE_CHIP = 'bg-[var(--tone-red-bg)] text-[var(--tone-red-fg-2)]';

/** An event with where it sits on the calendar's one clock (the CRM's display zone). */
export type Placed = CalendarEvent & { ymd2: string; hour: number; minute: number; time: string };

export function placeEvent(e: CalendarEvent, tz: string): Placed {
  const p = zoneParts(e.date, tz);
  return {
    ...e,
    // A task has no customer, so its time is the calendar's own, not a customer clock.
    ...(e.type === 'task' ? { atLabel: atOnClock(e.date, tz) } : {}),
    ymd2: p.ymd, hour: p.hour, minute: p.minute, time: timeIn(e.date, tz),
  };
}

export type Look = { cls: string; style?: CSSProperties };

/**
 * How an item looks wherever it's drawn. By type: its type colour, overdue in
 * red, a cancelled meeting struck through, a finished one faded. By rep (a
 * manager's whole-team calendar): a tint of that person's colour with a solid
 * stripe down its left edge — kept even on an overdue or finished item, so who
 * it belongs to never disappears. Red stays red: it's a status, not a series.
 */
export function look(e: CalendarEvent, now: number, repColour?: string): Look {
  const muted = e.type === 'zoom' && (e.status === 'cancelled' || e.status === 'completed');
  const overdue = !muted && isOverdue(e, now);
  const cls = muted
    ? `bg-muted text-muted-foreground${e.status === 'cancelled' ? ' line-through' : ''}`
    : overdue ? OVERDUE_CHIP : TYPE_META[e.type].chip;
  if (!repColour) return { cls };
  const stripe = `inset 3px 0 0 ${repColour}`;
  if (muted || overdue) return { cls, style: { boxShadow: stripe } };
  return { cls: 'text-foreground', style: { background: `color-mix(in srgb, ${repColour} 16%, hsl(var(--card)))`, boxShadow: stripe } };
}

/** The busy-day shade for a count: one hue, deeper with more. `dim` softens it (another month's days). */
export function loadShade(count: number, dim = 1): string | undefined {
  const level = loadLevel(count);
  return level ? `hsl(var(--primary) / ${LOAD_ALPHA[level] * dim})` : undefined;
}

/** "1 item" / "4 items". */
export const itemCount = (n: number) => `${n} item${n === 1 ? '' : 's'}`;
