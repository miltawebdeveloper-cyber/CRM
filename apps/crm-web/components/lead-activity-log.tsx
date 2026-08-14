'use client';

import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, X } from 'lucide-react';
import { activitiesApi, type Activity } from '@/lib/crm';
import { LeadAssignmentHistory } from '@/components/lead-assignment-history';
import { OutcomePill } from '@/components/outcome-pill';
import { useOutcomeLabels } from '@/lib/use-outcome-label';
import { leadDateTime, zoneNote } from '@/lib/timezone';

/**
 * Every stamp in a lead's history is read on the LEAD's clock.
 *
 * This is the lead's own record of what happened to it, and the rest of the
 * module now dates that lead on its own zone — its created date, the day it is
 * queued for, the day the next-day sweep moved it to. A history rendered on the
 * reader's clock would be the one view that disagreed with all of them, and it
 * is the view people open precisely when the dates are in question.
 */
const fmt = (iso: string, tz?: string | null) => leadDateTime(iso, tz);

// Friendly labels for the action keys written across modules.
const ACTION_LABEL: Record<string, string> = {
  lead_created: 'Lead created',
  lead_updated: 'Lead updated',
  lead_assigned: 'Lead assigned',
  lead_reassigned: 'Lead reassigned',
  status_changed: 'Status changed',
  call_completed: 'Call completed',
  call_queued: 'Call queued (Quo)',
  call_connected: 'Call connected',
  call_started: 'Call started',
  call_ended: 'Call ended',
  call_recording_synced: 'Recording synced',
  call_summary_synced: 'AI summary synced',
  call_transcript_synced: 'Transcript synced',
  callback_scheduled: 'Callback scheduled',
  // Written by the overnight rollover when a scheduled call's day ended without
  // it: the appointment moves to the next working day, the lead does not change
  // hands, and nothing about the lead's own record is rewritten.
  callback_rolled_over: 'Callback moved to the next working day',
  completed: 'Follow-up completed',
  updated: 'Follow-up updated',
  note_added: 'Note added',
  zoom_scheduled: 'Zoom scheduled',
  zoom_started: 'Zoom started',
  zoom_completed: 'Zoom completed',
  zoom_cancelled: 'Zoom cancelled',
  zoom_rescheduled: 'Zoom rescheduled',
  task_updated: 'Task updated',
};
const label = (a: string) => ACTION_LABEL[a] ?? a.replace(/_/g, ' ');

// UUIDs (e.g. assignment owner ids) aren't human-friendly — hide them, prefer remarks.
const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
/**
 * `outcomeLabel` resolves an outcome slug to its configured name. These columns
 * carry more than outcomes — lead statuses, field edits, booleans — so anything
 * that isn't a known outcome falls through to the humanised value.
 *
 * The values that ARE instants get the lead's clock, like every other stamp
 * here. These are the two halves of "callback moved from X to Y", so showing
 * them on a different clock from the entry's own timestamp beside them would
 * make a single row internally inconsistent.
 */
function showVal(v: string | null, outcomeLabel: (s?: string | null) => string, tz?: string | null): string {
  if (!v) return '—';
  if (isUuid(v)) return '—';
  const d = new Date(v);
  if (!Number.isNaN(d.getTime()) && /\d{4}-\d{2}-\d{2}T/.test(v)) {
    return leadDateTime(d, tz);
  }
  return outcomeLabel(v);
}

/**
 * Per-lead Activity Log — full audit trail. Admin / Team-Lead only; the
 * `/activities/lead/:id` endpoint is role-gated, so render this only for them.
 */
export function LeadActivityLog({ leadId, title }: { leadId: string; title?: string }) {
  const { outcome, label: outcomeLabel } = useOutcomeLabels();
  const { data: items = [], isLoading } = useQuery<Activity[]>({
    queryKey: ['lead', leadId, 'activities'],
    queryFn: () => activitiesApi.byLead(leadId),
  });

  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4 text-[var(--brand)]" /> Activity Log{title ? <span className="text-muted-foreground">— {title}</span> : null}
        </h2>
        <span className="shrink-0 text-xs text-muted-foreground">Complete lead lifecycle timeline · {items.length} entries</span>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!isLoading && items.length === 0 && <p className="text-sm text-muted-foreground">No activity recorded yet.</p>}

      {items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-[10.5px] uppercase tracking-[.08em] text-muted-foreground">
                <th className="px-3 py-2 font-semibold">Lead ID</th>
                <th className="px-3 py-2 font-semibold">Date &amp; time</th>
                <th className="px-3 py-2 font-semibold">Call Status</th>
                <th className="px-3 py-2 font-semibold">Assigned Employee</th>
                <th className="px-3 py-2 font-semibold">Description</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => {
                // The clock this row is stated on — the lead's own, sent with
                // the entry so the log can't have to guess it.
                const tz = a.lead?.timezone;
                let desc = label(a.action);
                if (a.oldValue || a.newValue) {
                  desc += `: ${showVal(a.oldValue, outcomeLabel, tz)} ➔ ${showVal(a.newValue, outcomeLabel, tz)}`;
                }
                if (a.remarks) {
                  desc += ` (${a.remarks})`;
                }

                return (
                  <tr key={a.id} className="border-b align-top last:border-0">
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs">{a.lead?.leadId ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground" title={zoneNote(tz)}>{fmt(a.createdAt, tz)}</td>
                    {/* The configured outcome, not the stored slug. `capitalize`
                        is gone with it — a real name carries its own casing, and
                        forcing it mangled "Dm-Not Interested". */}
                    <td className="px-3 py-2.5">
                      {a.callStatus ? (
                        <OutcomePill name={outcomeLabel(a.callStatus)} color={outcome(a.callStatus)?.color} />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-medium">{a.assignedTo?.name ?? '—'}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{desc}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Right-side slide-over wrapper — opened from the Info (ⓘ) icon. */
export function LeadActivityDrawer({ leadId, leadName, onClose }: { leadId: string; leadName?: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="h-full w-full max-w-2xl overflow-y-auto bg-background p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:underline">
          <X className="h-4 w-4" /> Close
        </button>
        {/* Ownership first, then the general activity log. Who holds a lead and
            how it got there is the question this drawer is usually opened for,
            and it was previously only inferable from scattered log lines. */}
        <div className="mb-4">
          <LeadAssignmentHistory leadId={leadId} />
        </div>
        <LeadActivityLog leadId={leadId} title={leadName} />
      </div>
    </div>
  );
}
