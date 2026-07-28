import type { QueryClient } from '@tanstack/react-query';

/**
 * What has to be re-read when a call is dispositioned.
 *
 * The Calling Panel is the hub every other call-related screen reports on, so a
 * single save fans out further than it looks: it writes a Call row, a Note, the
 * lead's status / comments / callback, sometimes a Zoom meeting and the task
 * attached to it. Each of those is the source for a different module.
 *
 * Listing them in one place is the point. Every screen used to be invalidated by
 * whichever component happened to remember it, so a save from the panel refreshed
 * five keys and left the rest stale — including the panel's OWN sibling tabs:
 * log a call, switch to Calls Made, and the call wasn't there. Anything reading
 * call or lead data belongs in this list, and adding a module means adding a line
 * here rather than hunting for every writer.
 */
const CALL_ACTIVITY_KEYS: string[][] = [
  // ── Calling Panel itself ──
  ['caller-leads'], // the queue
  ['caller-dash'], // its KPI cards
  // ── The panel's sibling tabs (same screen, previously never refreshed) ──
  ['calls-made'], // Calls Made — stats, records and filters
  ['calls-aspects'], // Analytics pivot
  ['recordings'], // Call Recordings
  ['lead-book'], // assigned / completed / balance on the Analytics tab
  // ── Lead-side modules ──
  ['leads'], // Lead Management + Closed Leads
  ['lead'], // a single lead: detail, timeline (Call History), comments
  ['lead-comments'], // the comment trail behind the Comments column
  ['activities'], // Lead Activity Log / Call Logs
  ['followups'], // Follow-Ups module
  ['calendar'], // callbacks and meetings on the calendar
  // ── Zoom ──
  ['zoom'],
  ['zoom-due'],
  ['zoom-timeline'],
  ['zoom-meeting'],
  ['zoom-activities'],
  ['tasks'], // scheduling a Zoom creates a linked task for the organiser
  // ── Dashboards and reports ──
  ['metrics'], // dashboard summary cards
  ['m-bar'], // analytics charts, which read the same metrics
  ['m-tz'],
  ['m-daily'],
  ['m-states'],
  ['productivity'], // per-caller productivity report
  ['daily-summary'], // end-of-day call summary
  ['team-live'], // manager live view
  ['comm-analytics'], // communication analytics
  ['outcomes'], // Outcome Records log
];

/**
 * Refresh every module that reflects call activity.
 *
 * Call this after ANY action that dispositions a call or lead — from the Calling
 * Panel, the docked dial-pad widget, or a correction in the Outcome Records log.
 * React Query matches by key prefix, so the bare roots here cover the
 * parameterised variants (`['calls-made', 'stats', params]` and friends) without
 * having to know the filters each screen is currently using.
 *
 * Invalidation only marks the cached data stale; React Query refetches the
 * queries that are actually mounted, so listing every module costs one refetch
 * for the screen in front of the user, not twenty-seven requests.
 */
export function invalidateCallActivity(qc: QueryClient) {
  for (const queryKey of CALL_ACTIVITY_KEYS) qc.invalidateQueries({ queryKey });
}
