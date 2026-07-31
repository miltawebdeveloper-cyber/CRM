'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Loader2 } from 'lucide-react';
import { leadsApi, type Lead } from '@/lib/leads';
import { formatDateTime } from '@/lib/display-settings';

/**
 * The Comments cell in Lead Management: shows the latest remark, edits in place,
 * and opens the full trail.
 *
 * `Lead.comments` holds only the newest remark — every save also appends to the
 * lead's note history server-side, so nothing is overwritten. Call notes taken in
 * the Call Panel land in that same field, which is why this cell can show a remark
 * the user never typed here.
 */
export function LeadCommentCell({ lead }: { lead: Lead }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(lead.comments ?? '');
  const [showHistory, setShowHistory] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The draft is seeded when editing STARTS rather than kept in step with the row.
  // Outside an edit it isn't read, and syncing it would mean a call note landing
  // mid-edit could overwrite what the user is part-way through typing.
  const beginEdit = () => {
    setDraft(lead.comments ?? '');
    setEditing(true);
  };

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = useMutation({
    mutationFn: (text: string) => leadsApi.update(lead.id, { comments: text }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['lead-comments', lead.id] });
      setEditing(false);
    },
  });

  const commit = () => {
    const text = draft.trim();
    if (text === (lead.comments ?? '').trim()) return setEditing(false);
    save.mutate(text);
  };

  if (editing) {
    return (
      <textarea
        ref={inputRef}
        rows={2}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        // Enter saves, Shift+Enter adds a line, Escape abandons the edit.
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { setDraft(lead.comments ?? ''); setEditing(false); }
        }}
        onClick={(e) => e.stopPropagation()}
        placeholder="Add a comment…"
        className="w-full min-w-[180px] resize-y rounded-md border bg-background px-2 py-1 text-[12.5px] outline-none focus:border-primary"
      />
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <button
        onClick={(e) => { e.stopPropagation(); beginEdit(); }}
        // The full text is on the title so a truncated remark is still readable.
        title={lead.comments || 'Click to add a comment'}
        className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-[12.5px] hover:bg-muted"
      >
        {save.isPending ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Saving…
          </span>
        ) : lead.comments ? (
          lead.comments
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); setShowHistory(true); }}
        title="Comment history"
        aria-label="Comment history"
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
      >
        <History className="h-3.5 w-3.5" />
      </button>
      {showHistory && <CommentHistoryDialog lead={lead} onClose={() => setShowHistory(false)} />}
    </div>
  );
}

/** The full trail for one lead: every remark, who left it and where it came from. */
function CommentHistoryDialog({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const { data = [], isLoading } = useQuery({
    queryKey: ['lead-comments', lead.id],
    queryFn: () => leadsApi.commentHistory(lead.id),
  });

  return (
    <>
      <div onClick={(e) => { e.stopPropagation(); onClose(); }} className="fixed inset-0 z-40 bg-black/30" />
      <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" aria-label="Comment history">
        <div onClick={(e) => e.stopPropagation()} className="flex max-h-[80vh] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl">
          <div className="border-b px-5 py-4">
            <h3 className="font-display text-[15px] font-semibold">Comment history</h3>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{lead.businessName} · {lead.leadId}</p>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {isLoading && <p className="py-6 text-center text-[12.5px] text-muted-foreground">Loading…</p>}
            {!isLoading && data.length === 0 && (
              <p className="py-6 text-center text-[12.5px] text-muted-foreground">No comments recorded yet.</p>
            )}
            {data.map((c) => (
              <div key={c.id} className="mb-2 rounded-lg border px-3 py-2">
                <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span
                    className={`rounded-full px-1.5 py-0.5 font-medium ${
                      c.source === 'Call Notes' ? 'bg-[#d8eed9] text-[#266929]' : 'bg-muted text-foreground'
                    }`}
                  >
                    {c.source}
                  </span>
                  <span className="font-medium text-foreground">{c.user}</span>
                  <span>{formatDateTime(c.at)}</span>
                </div>
                <p className="whitespace-pre-wrap text-[12.5px]">{c.text}</p>
              </div>
            ))}
          </div>
          <div className="flex justify-end border-t px-5 py-3">
            <button onClick={onClose} className="rounded-md border bg-card px-3 py-2 text-[13px] font-medium hover:bg-muted">Close</button>
          </div>
        </div>
      </div>
    </>
  );
}
