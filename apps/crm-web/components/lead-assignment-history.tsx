'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, UserPlus, Repeat } from 'lucide-react';
import { leadsApi, type LeadAssignment } from '@/lib/leads';
import { formatDateTime } from '@/lib/display-settings';

/** Local date and time, to the minute — an audit entry needs the clock, not the day. */
const stamp = (iso: string) =>
  formatDateTime(iso);

/**
 * A lead's ownership history — every assignment and reassignment, newest first.
 *
 * Read-only by construction: rows are appended when a lead changes hands and are
 * never edited afterwards, which is what makes this an audit trail rather than a
 * view of current state. The lead's own details are untouched by any handover —
 * only the owner moves — so nothing here can overwrite the lead.
 */
export function LeadAssignmentHistory({ leadId }: { leadId: string }) {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['lead-assignments', leadId],
    queryFn: () => leadsApi.assignmentHistory(leadId),
    retry: false,
  });

  if (isLoading) return <p className="py-6 text-center text-[12.5px] text-muted-foreground">Loading assignment history…</p>;
  if (rows.length === 0) {
    return <p className="py-6 text-center text-[12.5px] text-muted-foreground">This lead has never been assigned.</p>;
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <h4 className="text-[10.5px] font-bold uppercase tracking-[.09em]">Assignment History</h4>
        <span className="ml-auto text-[10.5px] text-muted-foreground">
          {rows.length} {rows.length === 1 ? 'entry' : 'entries'}
        </span>
      </div>
      <div className="divide-y">
        {rows.map((r: LeadAssignment) => {
          const reassigned = r.type === 'reassignment';
          const Icon = reassigned ? Repeat : UserPlus;
          return (
            <div key={r.id} className="px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-full"
                  style={reassigned ? { background: '#fbf0dc', color: '#8a5a00' } : { background: '#e0f2e9', color: '#0a6640' }}
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="text-[10.5px] font-bold uppercase tracking-wider" style={{ color: reassigned ? '#8a5a00' : '#0a6640' }}>
                  {reassigned ? 'Reassignment' : 'New assignment'}
                </span>
                {/* Which row names the owner right now — the rest are history. */}
                {r.current && (
                  <span className="rounded-full border px-1.5 py-[1px] text-[10px] font-semibold text-muted-foreground">Current</span>
                )}
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">{stamp(r.assignedAt)}</span>
              </div>

              {/* From → to. A first assignment has no "from", so it says so
                  rather than showing an arrow out of nowhere. */}
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-8 text-[12.5px]">
                {r.previousEmployee ? (
                  <>
                    <span className="text-muted-foreground">{r.previousEmployee}</span>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                  </>
                ) : (
                  <span className="text-muted-foreground">Unassigned</span>
                )}
                {!r.previousEmployee && <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />}
                <span className="font-semibold">{r.newEmployee}</span>
              </div>

              <p className="mt-0.5 pl-8 text-[11px] text-muted-foreground">
                by {r.assignedBy}
                {r.remarks && <> · {r.remarks}</>}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
