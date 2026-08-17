'use client';

import { useQuery } from '@tanstack/react-query';
import { leadsApi } from '@/lib/leads';
import { leadDateTime, zoneNote } from '@/lib/timezone';

/**
 * One lead's comment trail — every remark, who left it, and where it came from.
 *
 * Lead Management and the Calling Panel are two views of the same conversation,
 * so they read it through this one component rather than each drawing their own
 * list. It is the same query key (`['lead-comments', leadId]`), so the two share
 * a cache entry and a single invalidation refreshes whichever is on screen; and
 * it is the same markup, so a remark cannot look like one thing in the column
 * and another in the panel.
 *
 * The server is what makes it one trail: manual edits and call notes both land
 * in `notes` against the lead, and `GET /leads/:id/comments` returns them
 * merged, newest first. Nothing is written here — this only reads.
 */
export function LeadCommentTrail({
  leadId,
  timezone,
  emptyText = 'No comments recorded yet.',
  className = '',
}: {
  leadId: string;
  /** The lead's own zone. Comments are stamped on it, like the rest of its history. */
  timezone?: string | null;
  emptyText?: string;
  className?: string;
}) {
  const { data = [], isLoading } = useQuery({
    queryKey: ['lead-comments', leadId],
    queryFn: () => leadsApi.commentHistory(leadId),
  });

  if (isLoading) {
    return <p className={`py-6 text-center text-[12px] text-muted-foreground ${className}`}>Loading…</p>;
  }
  if (data.length === 0) {
    return <p className={`py-6 text-center text-[12px] text-muted-foreground ${className}`}>{emptyText}</p>;
  }

  return (
    <div className={className}>
      {data.map((c) => (
        <div key={c.id} className="mb-2 rounded-lg border px-3 py-2 last:mb-0">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-[10.5px] text-muted-foreground">
            <span
              className={`rounded-full px-1.5 py-0.5 font-medium ${
                c.source === 'Call Notes' ? 'bg-[var(--brand-surface)] text-[var(--brand-on-surface)]' : 'bg-muted text-foreground'
              }`}
            >
              {c.source}
            </span>
            <span className="font-medium text-foreground">{c.user}</span>
            {/* The comment trail is part of the lead's history, so it is stamped
                on the lead's clock like the rest of it — a remark left during a
                call must not read as the following day beside the call it was
                left on. */}
            <span title={zoneNote(timezone)}>{leadDateTime(c.at, timezone)}</span>
          </div>
          <p className="whitespace-pre-wrap text-[12px]">{c.text}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * How many remarks a lead has, for a count beside a collapsed trail.
 *
 * Reads the same cache entry the trail itself does, so asking costs nothing
 * extra once either module has loaded it.
 */
export function useLeadCommentCount(leadId: string | undefined) {
  const { data = [] } = useQuery({
    queryKey: ['lead-comments', leadId],
    queryFn: () => leadsApi.commentHistory(leadId as string),
    enabled: !!leadId,
  });
  return data.length;
}
