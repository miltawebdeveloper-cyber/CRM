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

/**
 * What has to be re-read when a comment is written against a lead.
 *
 * A comment is not a call, but it is shared. Lead Management's Comments column,
 * its history dialog and the Calling Panel's write-up are three views of one
 * trail (`notes` rows on the lead), so a remark typed in one has to show up in
 * the others without a reload — the reason this is a named set rather than the
 * two keys whichever component happened to remember.
 *
 * That is the bug it fixes: the Comments cell invalidated `leads` and its own
 * `lead-comments`, and nothing else, so a comment typed in Lead Management was
 * invisible to a Calling Panel already open on the same lead until its 15s queue
 * poll happened to come round — and invisible to the lead's detail page until it
 * was navigated away from and back.
 *
 * Every key here is also in `CALL_ACTIVITY_KEYS` above: a call disposition
 * writes a comment too, so saving from the panel already covers all of this.
 * This is the smaller set for a write that is ONLY a comment.
 */
const LEAD_COMMENT_KEYS: string[][] = [
  ['leads'], // Lead Management + Closed Leads — the Comments column
  ['lead'], // a single lead: detail page and its timeline
  ['lead-comments'], // the shared trail both modules render
  ['caller-leads'], // the Calling Panel queue, which carries the latest remark
  ['activities'], // Lead Activity Log
];

/**
 * Refresh every module that shows a lead's comments.
 *
 * Call this after any write that adds a remark and nothing else. Keys are bare
 * roots, so React Query's prefix matching covers the per-lead variants
 * (`['lead-comments', id]`, `['lead', id, 'timeline']`) without this having to
 * know which lead is on screen.
 */
export function invalidateLeadComment(qc: QueryClient) {
  for (const queryKey of LEAD_COMMENT_KEYS) qc.invalidateQueries({ queryKey });
}
