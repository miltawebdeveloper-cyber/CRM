'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { leadsApi, type Lead, type UpdateLeadInput } from '@/lib/leads';

/**
 * Generic single-field inline editor for a lead cell.
 *
 * Click the value to edit it, Enter/blur saves, Escape abandons — the same feel as
 * the Comments cell, but without the comment-history plumbing, so it suits plain
 * text fields like Lost Reason. Saves just that one field via the lead PATCH.
 */
export function LeadInlineCell({
  lead,
  field,
  placeholder = 'Add…',
}: {
  lead: Lead;
  field: keyof UpdateLeadInput & keyof Lead;
  placeholder?: string;
}) {
  const qc = useQueryClient();
  const current = (lead[field] as string | null) ?? '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(current);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = useMutation({
    mutationFn: (text: string) => leadsApi.update(lead.id, { [field]: text } as UpdateLeadInput),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      setEditing(false);
    },
  });

  const begin = () => { setDraft(current); setEditing(true); };
  const commit = () => {
    const text = draft.trim();
    if (text === current.trim()) return setEditing(false);
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
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { setDraft(current); setEditing(false); }
        }}
        onClick={(e) => e.stopPropagation()}
        placeholder={placeholder}
        className="w-full min-w-[160px] resize-y rounded-md border bg-background px-2 py-1 text-[12px] outline-none focus:border-primary"
      />
    );
  }

  return (
    <button
      onClick={(e) => { e.stopPropagation(); begin(); }}
      title={current || placeholder}
      className="block w-full min-w-0 truncate rounded px-1 py-0.5 text-left text-[12px] hover:bg-muted"
    >
      {save.isPending ? (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Saving…
        </span>
      ) : current ? (
        current
      ) : (
        <span className="text-muted-foreground">—</span>
      )}
    </button>
  );
}
