'use client';

import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, X } from 'lucide-react';
import { activitiesApi, type Activity } from '@/lib/crm';
import { LeadAssignmentHistory } from '@/components/lead-assignment-history';
import { formatDateTime } from '@/lib/display-settings';

const fmt = (iso: string) =>
  formatDateTime(iso);

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
function showVal(v: string | null): string {
  if (!v) return '—';
  if (isUuid(v)) return '—';
  const d = new Date(v);
  if (!Number.isNaN(d.getTime()) && /\d{4}-\d{2}-\d{2}T/.test(v)) {
    return formatDateTime(d);
  }
  return v.replace(/_/g, ' ');
}

/**
 * Per-lead Activity Log — full audit trail. Admin / Team-Lead only; the
 * `/activities/lead/:id` endpoint is role-gated, so render this only for them.
 */
export function LeadActivityLog({ leadId, title }: { leadId: string; title?: string }) {
  const { data: items = [], isLoading } = useQuery<Activity[]>({
    queryKey: ['lead', leadId, 'activities'],
    queryFn: () => activitiesApi.byLead(leadId),
  });

  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4 text-[#266929]" /> Activity Log{title ? <span className="text-muted-foreground">— {title}</span> : null}
        </h2>
        <span className="shrink-0 text-xs text-muted-foreground">Complete lead lifecycle timeline · {items.length} entries</span>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!isLoading && items.length === 0 && <p className="text-sm text-muted-foreground">No activity recorded yet.</p>}

      {items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-[11px] uppercase tracking-[.08em] text-muted-foreground">
                <th className="px-3 py-2 font-semibold">Lead ID</th>
                <th className="px-3 py-2 font-semibold">Date &amp; time</th>
                <th className="px-3 py-2 font-semibold">Call Status</th>
                <th className="px-3 py-2 font-semibold">Assigned Employee</th>
                <th className="px-3 py-2 font-semibold">Description</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => {
                let desc = label(a.action);
                if (a.oldValue || a.newValue) {
                  desc += `: ${showVal(a.oldValue)} ➔ ${showVal(a.newValue)}`;
                }
                if (a.remarks) {
                  desc += ` (${a.remarks})`;
                }

                return (
                  <tr key={a.id} className="border-b align-top last:border-0">
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs">{a.lead?.leadId ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">{fmt(a.createdAt)}</td>
                    <td className="px-3 py-2.5 capitalize">{a.callStatus ?? '—'}</td>
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
