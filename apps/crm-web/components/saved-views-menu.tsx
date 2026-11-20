'use client';

import { useEffect, useRef, useState } from 'react';
import { Bookmark, Check, ChevronDown, X } from 'lucide-react';
import type { LeadListFilters } from '@/lib/lead-list-filters';
import { MAX_SAVED_VIEWS, sameFilters, type SavedView } from '@/lib/saved-views';

/**
 * The saved-views menu at the start of the quick-filter row.
 *
 * Opening a view replaces the whole filter bar with it — search, location,
 * chips, outcomes, dates and sort. Saving uses the current bar as it stands,
 * and a name already in the list updates that view rather than duplicating it.
 * The button names the view on screen when the bar matches one exactly, so it
 * is always clear whether you are looking at "My Texas overdue" or at
 * something edited away from it.
 */
export function SavedViewsMenu({
  views,
  current,
  onApply,
  onSave,
  onDelete,
}: {
  views: SavedView[];
  current: LeadListFilters;
  onApply: (filters: LeadListFilters) => void;
  onSave: (name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const active = views.find((v) => sameFilters(v.filters, current));
  const clean = name.trim();
  const overwrites = views.some((v) => v.name.toLowerCase() === clean.toLowerCase());
  const full = views.length >= MAX_SAVED_VIEWS && !overwrites;

  const submit = () => {
    if (!clean || full) return;
    onSave(clean);
    setName('');
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`inline-flex max-w-[220px] items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-[12px] font-medium hover:bg-muted ${
          active ? 'border-primary/60 text-foreground' : 'text-muted-foreground'
        }`}
      >
        <Bookmark className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{active ? active.name : 'Views'}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 z-[60] mt-1 w-[280px] overflow-hidden rounded-lg border bg-card shadow-xl">
          <div className="max-h-64 overflow-y-auto py-1">
            {views.length === 0 && (
              <p className="px-3 py-3 text-[11.5px] text-muted-foreground">
                No saved views yet. Set up the filters you use often, then save them below.
              </p>
            )}
            {views.map((v) => {
              const on = v.id === active?.id;
              return (
                <div key={v.id} className="group/view flex items-center gap-1 px-1.5">
                  <button
                    type="button"
                    onClick={() => { onApply(v.filters); setOpen(false); }}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1.5 text-left text-[12px] hover:bg-muted"
                  >
                    <span className="grid h-4 w-4 shrink-0 place-items-center">{on && <Check className="h-3.5 w-3.5 text-primary" />}</span>
                    <span className="truncate">{v.name}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(v.id)}
                    title={`Delete "${v.name}"`}
                    aria-label={`Delete view ${v.name}`}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus:opacity-100 group-hover/view:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
          <form
            onSubmit={(e) => { e.preventDefault(); submit(); }}
            className="border-t bg-muted/30 p-2.5"
          >
            <label className="mb-1.5 block text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              Save current filters as
            </label>
            <div className="flex gap-1.5">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                placeholder="e.g. My Texas overdue"
                className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-[12px] outline-none focus:border-primary"
              />
              <button
                type="submit"
                disabled={!clean || full}
                className="rounded-md bg-primary px-2.5 py-1.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-50"
              >
                {overwrites ? 'Update' : 'Save'}
              </button>
            </div>
            {full && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {MAX_SAVED_VIEWS} views is the limit — delete one to make room.
              </p>
            )}
          </form>
        </div>
      )}
    </div>
  );
}
