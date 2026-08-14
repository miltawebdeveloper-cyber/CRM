'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, UserPlus, Repeat, CalendarArrowDown } from 'lucide-react';
import { leadsApi, type LeadAssignment } from '@/lib/leads';
import { leadDateTime, zoneNote } from '@/lib/timezone';

/**
 * Date and time to the minute — an audit entry needs the clock, not the day —
 * read on the LEAD's clock.
 *
 * Which matters most exactly here. These rows are the record of when a lead
 * changed hands and when it was moved to a new day, and the sweep that moves it
 * decides "next day" on the lead's calendar. Rendering the result on the
 * reader's calendar made the trail contradict the rule that produced it: a
 * carry-forward stamped just after midnight Eastern read as the following
 * afternoon in India, a day later than the day it had just moved the lead to.
 */
const stamp = (iso: string, tz?: string | null) => leadDateTime(iso, tz);

/**
 * How each kind of entry presents itself.
 *
 * Three kinds, because three different things happen to a lead and reading them
 * as one another is misleading. A new assignment gives a lead an owner; a
 * reassignment takes it from one person and gives it to another; a carry-forward
 * moves nothing between people at all — an automatic sweep re-stamped the lead
 * for its next day because the work on it was still outstanding. The last one
 * used to render as "New assignment", which claimed a manager had assigned the
 * lead afresh every single morning it went unfinished.
 */
const KIND: Record<LeadAssignment['type'], { label: string; icon: typeof UserPlus; bg: string; fg: string }> = {
  new_assignment: { label: 'New assignment', icon: UserPlus, bg: '#e0f2e9', fg: '#0a6640' },
  reassignment: { label: 'Reassignment', icon: Repeat, bg: '#fbf0dc', fg: 'var(--tone-amber-fg-strong)' },
  carry_forward: { label: 'Moved to next day', icon: CalendarArrowDown, bg: 'var(--tone-blue-bg-2)', fg: 'var(--tone-blue-fg-2)' },
};

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
          const kind = KIND[r.type] ?? KIND.new_assignment;
          const Icon = kind.icon;
          // A carry-forward names the same person on both sides, so the
          // "from → to" line below would read "Lisa → Lisa" and imply a handover
          // that never happened. It gets a sentence about the lead instead.
          const moved = r.type === 'carry_forward';
          return (
            <div key={r.id} className="px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-full"
                  style={{ background: kind.bg, color: kind.fg }}
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="text-[10.5px] font-bold uppercase tracking-wider" style={{ color: kind.fg }}>
                  {kind.label}
                </span>
                {/* Which row names the owner right now — the rest are history. */}
                {r.current && (
                  <span className="rounded-full border px-1.5 py-[1px] text-[10px] font-semibold text-muted-foreground">Current</span>
                )}
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground" title={zoneNote(r.timezone)}>
                  {stamp(r.assignedAt, r.timezone)}
                </span>
              </div>

              {/* From → to. A first assignment has no "from", so it says so
                  rather than showing an arrow out of nowhere. */}
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-8 text-[12.5px]">
                {moved ? (
                  <span className="text-muted-foreground">
                    Same lead, still with <span className="font-semibold text-foreground">{r.newEmployee}</span>
                  </span>
                ) : (
                  <>
                    {r.previousEmployee ? (
                      <>
                        <span className="text-muted-foreground">{r.previousEmployee}</span>
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                      </>
                    ) : (
                      <>
                        <span className="text-muted-foreground">Unassigned</span>
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                      </>
                    )}
                    <span className="font-semibold">{r.newEmployee}</span>
                  </>
                )}
              </div>

              <p className="mt-0.5 pl-8 text-[11px] text-muted-foreground">
                {/* An automatic move was nobody's decision, so naming an
                    assigner would credit the owner with an action they didn't
                    take. The remark carries the account of it instead. */}
                {!moved && <>by {r.assignedBy}</>}
                {r.remarks && <>{moved ? '' : ' · '}{r.remarks}</>}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
