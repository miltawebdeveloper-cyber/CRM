'use client';

import { AlertTriangle } from 'lucide-react';
import type { SameDayConflict } from '@/lib/crm';

/**
 * "This lead has already been assigned today — reassign it?"
 *
 * A lead is assigned once a day. The server refuses a second handover unless the
 * assigner confirms it, and this is that confirmation.
 *
 * The list of affected leads comes from the SERVER's refusal, not from anything
 * the client worked out for itself. The client would have to re-derive "was this
 * assigned today" from rows it may not be holding — and a prompt that named the
 * wrong leads, or appeared when nothing was at stake, would train people to
 * click through it.
 */
export function ReassignConfirm({
  conflicts,
  employee,
  busy,
  onConfirm,
  onCancel,
}: {
  conflicts: SameDayConflict[];
  /** Who the leads would move to, when it's a single named employee. */
  employee?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const many = conflicts.length > 1;
  return (
    <>
      {/* Above the assign dialog that raised it — this is the question now. */}
      <div onClick={onCancel} aria-hidden className="fixed inset-0 z-[60] bg-black/40" />
      <div className="fixed inset-0 z-[61] grid place-items-center p-4">
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="reassign-confirm-title"
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-[440px] overflow-hidden rounded-2xl border bg-card shadow-2xl"
        >
          <div className="flex items-start gap-3 px-5 pb-3 pt-5">
            <span className="mt-[2px] grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#fdf1de] text-[#8a5a00]">
              <AlertTriangle className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h3 id="reassign-confirm-title" className="font-display text-[14px] font-semibold">
                {many ? `${conflicts.length} leads have already been assigned today` : 'This lead has already been assigned today'}
              </h3>
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                {many
                  ? 'They were assigned to another employee earlier today. Do you want to reassign them'
                  : 'It was assigned to another employee earlier today. Do you want to reassign it'}
                {employee ? ` to ${employee}?` : '?'}
              </p>
            </div>
          </div>

          {/* Which leads, and who currently holds them — so the decision is made
              on the facts rather than on a count. Capped, because a confirmation
              is a decision, not a report. */}
          <div className="mx-5 max-h-[168px] overflow-y-auto rounded-lg border bg-muted/30">
            {conflicts.slice(0, 8).map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 border-b px-3 py-1.5 text-[11.5px] last:border-0">
                <span className="truncate font-mono text-[11px]">{c.leadId}</span>
                <span className="shrink-0 truncate text-muted-foreground">{c.assignedTo ?? 'unassigned'}</span>
              </div>
            ))}
            {conflicts.length > 8 && (
              <p className="px-3 py-1.5 text-[11px] text-muted-foreground">
                and {conflicts.length - 8} more…
              </p>
            )}
          </div>

          <div className="mt-4 flex items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3">
            {/* Cancel first and unstyled: the safe answer shouldn't be the one
                the eye lands on, and it leaves the existing assignment alone. */}
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded-md border bg-card px-3.5 py-2 text-[12.5px] font-semibold hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className="rounded-md bg-primary px-3.5 py-2 text-[12.5px] font-semibold text-primary-foreground disabled:opacity-60"
            >
              {busy ? 'Reassigning…' : 'Yes, Reassign'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
