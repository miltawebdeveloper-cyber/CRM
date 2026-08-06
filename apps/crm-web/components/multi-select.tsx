'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X, type LucideIcon } from 'lucide-react';

/**
 * Searchable multi-select dropdown. Controlled via `selected` / `onChange`.
 *
 * Built for large option lists: the panel filters as you type and caps the
 * rendered rows (search to narrow further), so thousands of cities stay smooth.
 * Closes on outside-click or Escape.
 */
export function MultiSelect({
  icon: Icon,
  label,
  options,
  selected,
  onChange,
  placeholder = 'Search…',
  disabled,
  emptyText = 'No options',
  maxRendered = 100,
}: {
  icon?: LucideIcon;
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  emptyText?: string;
  maxRendered?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
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

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
    return list;
  }, [options, query]);
  const shown = filtered.slice(0, maxRendered);
  const hiddenCount = filtered.length - shown.length;

  const toggle = (value: string) =>
    onChange(selectedSet.has(value) ? selected.filter((v) => v !== value) : [...selected, value]);

  const summary =
    selected.length === 0 ? label : selected.length === 1 ? selected[0] : `${label}: ${selected.length}`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-left text-[12px] outline-none focus:border-primary disabled:opacity-50 ${selected.length ? 'border-primary/60' : ''}`}
      >
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <span className={`min-w-0 flex-1 truncate ${selected.length ? 'font-medium' : 'text-muted-foreground'}`}>{summary}</span>
        {selected.length > 0 && (
          <span
            role="button"
            tabIndex={-1}
            aria-label={`Clear ${label}`}
            onClick={(e) => { e.stopPropagation(); onChange([]); }}
            className="grid h-4 w-4 shrink-0 place-items-center rounded hover:bg-muted"
          >
            <X className="h-3 w-3" />
          </span>
        )}
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-[60] mt-1 overflow-hidden rounded-lg border bg-card shadow-xl">
          <div className="flex items-center gap-2 border-b px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              className="w-full bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-52 overflow-y-auto py-1">
            {shown.length === 0 && <div className="px-3 py-3 text-center text-[11.5px] text-muted-foreground">{emptyText}</div>}
            {shown.map((o) => {
              const on = selectedSet.has(o);
              return (
                <button
                  key={o}
                  type="button"
                  onClick={() => toggle(o)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-muted"
                >
                  <span className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${on ? 'border-primary bg-primary text-primary-foreground' : 'border-input'}`}>
                    {on && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{o}</span>
                </button>
              );
            })}
            {hiddenCount > 0 && (
              <div className="px-3 py-1.5 text-center text-[10.5px] text-muted-foreground">
                +{hiddenCount} more — refine your search
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
