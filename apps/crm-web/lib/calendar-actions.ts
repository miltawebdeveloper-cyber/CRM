import { tasksApi, type CalendarEvent } from '@/lib/crm';
import { leadsApi } from '@/lib/leads';
import { zoomApi } from '@/lib/zoom';
import { hasLeadZone, wallClockInLeadZone } from '@/lib/timezone';

/** A meeting that hasn't finished or been cancelled — the only kind that can still move. */
export const meetingOpen = (e: Pick<CalendarEvent, 'type' | 'status'>) =>
  e.type === 'zoom' && (e.status === 'scheduled' || e.status === 'rescheduled' || e.status === 'in_progress');

/**
 * Why an event can't be moved on the calendar, or null when it can.
 *
 * A call or callback is booked on the CUSTOMER's clock, so a lead with no zone
 * has nothing to book on — the API refuses it, and the calendar says why up
 * front instead of letting a drag fail on drop.
 */
export function moveBlocker(e: CalendarEvent): string | null {
  if (e.type === 'task') return e.taskId ? null : 'This task can’t be moved.';
  if (e.type === 'zoom') return meetingOpen(e) && e.meetingId ? null : 'A finished or cancelled meeting stays where it was.';
  if (!e.leadRef) return 'There’s no lead to move.';
  if (!hasLeadZone(e.timezone)) return 'Set the lead’s timezone first — a callback needs one.';
  return null;
}

/**
 * Moves an event to a new instant, through the module that owns it: a call or
 * callback moves the lead's Next Follow-up (which moves its callback with it,
 * exactly as editing the lead does), sent on the lead's own clock because that
 * is how the API reads it; a meeting through the Zoom module; a task its due date.
 */
export function moveEvent(e: CalendarEvent, at: Date): Promise<unknown> {
  if (e.type === 'task') return tasksApi.setDue(e.taskId!, at.toISOString());
  if (e.type === 'zoom') return zoomApi.update(e.meetingId!, { scheduledAt: at.toISOString() });
  return leadsApi.update(e.leadRef!, { nextFollowUpDate: wallClockInLeadZone(at, e.timezone) });
}

/** Has this instant already gone? The same 60-second grace the API allows. */
export const isPast = (at: Date, now: number) => at.getTime() < now - 60_000;
