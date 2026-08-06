'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Search, CornerDownLeft, Loader2, Building2, ArrowRight } from 'lucide-react';
import { api } from '@/lib/api';
import { leadsApi } from '@/lib/leads';
import { navForRole, type Role } from '@/lib/nav';
import { cn } from '@/lib/utils';

/**
 * Lets anything open the palette without the component being passed around —
 * the topbar's search button fires this. A window event rather than context
 * because the palette is mounted once at the layout root and has no other
 * relationship with the things that open it.
 */
const OPEN_EVENT = 'crm:open-command-palette';
export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/**
 * `⌘K` on a Mac, `Ctrl K` everywhere else — shown on the topbar's button.
 *
 * `useSyncExternalStore` rather than an effect: the platform never changes, but
 * the server can't know it, and this is exactly the hook for a value with a
 * different server and client snapshot. It gives the right label on the first
 * client paint with no hydration mismatch and no state written from an effect.
 */
const NEVER_CHANGES = () => () => {};
export function useShortcutHint(): string {
  const isMac = useSyncExternalStore(
    NEVER_CHANGES,
    () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent),
    () => false,
  );
  return isMac ? '⌘K' : 'Ctrl K';
}

/** Long enough to stop a query per keystroke, short enough to feel immediate. */
const DEBOUNCE_MS = 200;
/** Leads shown at once — the palette is for finding one, not for browsing. */
const MAX_LEADS = 6;

interface Choice {
  key: string;
  label: string;
  hint?: string;
  group: 'Leads' | 'Go to';
  href: string;
  icon: typeof Search;
}

/**
 * Command palette — Ctrl/⌘K from anywhere.
 *
 * This replaces a search box that never searched: the topbar input had no value
 * binding and submitting it navigated to Lead Management whatever you typed,
 * while advertising a ⌘K shortcut that nothing listened for. It was the most
 * prominent control in the CRM and it did nothing.
 *
 * Two kinds of result, in one list: leads (searched server-side across company,
 * contact, phone, email and lead id, so it reaches the whole book rather than
 * the page a table happens to have loaded) and the modules the signed-in role
 * may actually open. Role scoping is the API's, so an employee only ever finds
 * their own leads here.
 */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.get('/auth/me')).data,
    retry: false,
    staleTime: 60_000,
  });

  // ── Open / close ──
  // Opening clears the previous query here, at the moment it opens, rather than
  // in an effect watching `open` — the palette should never reappear showing
  // whatever was typed last time, and this keeps that a property of opening.
  const show = useCallback(() => {
    setTerm('');
    setDebounced('');
    setCursor(0);
    setOpen(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((wasOpen) => {
          if (wasOpen) return false;
          show();
          return true;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, show);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_EVENT, show);
    };
  }, [show]);

  // One query per pause in typing, not one per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(term.trim()), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [term]);

  const { data: leads = [], isFetching } = useQuery({
    queryKey: ['palette-leads', debounced],
    queryFn: () => leadsApi.list({ q: debounced, limit: MAX_LEADS }),
    enabled: open && debounced.length >= 2,
    retry: false,
    staleTime: 30_000,
  });

  // ── Results ──
  const choices = useMemo<Choice[]>(() => {
    const q = debounced.toLowerCase();
    const leadChoices: Choice[] = leads.slice(0, MAX_LEADS).map((l) => ({
      key: `lead:${l.id}`,
      label: l.businessName || l.leadId,
      hint: [l.leadId, l.contactName, l.phone].filter(Boolean).join(' · '),
      group: 'Leads',
      href: `/leads/${l.id}`,
      icon: Building2,
    }));

    // Modules the role may open. With no query the palette is a jump list, which
    // is what makes it useful before you know what you're looking for.
    const modules: Choice[] = navForRole(me?.role as Role | undefined)
      .flatMap((g) => g.items)
      .filter((i) => !i.hidden)
      .filter((i) => !q || i.label.toLowerCase().includes(q))
      .map((i) => ({ key: `nav:${i.href}`, label: i.label, hint: i.sub, group: 'Go to', href: i.href, icon: i.icon }));

    return [...leadChoices, ...modules];
  }, [leads, debounced, me?.role]);

  // Clamp at render rather than correcting the state from an effect: results
  // change under the cursor as you type, and deriving the active row means it can
  // never point past the end even for the render in between.
  const active = choices.length === 0 ? 0 : Math.min(cursor, choices.length - 1);

  const go = (c?: Choice) => {
    if (!c) return;
    setOpen(false);
    router.push(c.href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return setOpen(false);
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((active + 1) % Math.max(choices.length, 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((active - 1 + choices.length) % Math.max(choices.length, 1)); }
    if (e.key === 'Enter') { e.preventDefault(); go(choices[active]); }
  };

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  let lastGroup = '';
  return (
    <>
      <div onClick={() => setOpen(false)} aria-hidden className="fixed inset-0 z-[90] bg-black/40" />
      <div className="fixed inset-x-0 top-[12vh] z-[91] mx-auto w-full max-w-[560px] px-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Search and jump to"
          className="overflow-hidden rounded-2xl border bg-card shadow-2xl"
          onKeyDown={onKeyDown}
        >
          <div className="flex items-center gap-2.5 border-b px-4">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              // The input only mounts when the palette opens, so `autoFocus` puts
              // the caret in it without a focus call from an effect.
              autoFocus
              value={term}
              onChange={(e) => { setTerm(e.target.value); setCursor(0); }}
              placeholder="Search leads by company, contact, phone or ID — or jump to a module…"
              aria-label="Search leads or jump to a module"
              className="flex-1 border-none bg-transparent py-3.5 text-[13px] outline-none placeholder:text-muted-foreground"
            />
            {isFetching && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
            <kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Esc</kbd>
          </div>

          <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-2">
            {choices.length === 0 && (
              <p className="px-3 py-6 text-center text-[12.5px] text-muted-foreground">
                {debounced.length >= 2 ? `Nothing matches “${debounced}”.` : 'Type at least two characters to search leads.'}
              </p>
            )}
            {choices.map((c, i) => {
              const Icon = c.icon;
              const header = c.group !== lastGroup ? ((lastGroup = c.group)) : null;
              return (
                <div key={c.key}>
                  {header && (
                    <p className="px-3 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-[.14em] text-muted-foreground">
                      {header}
                    </p>
                  )}
                  <button
                    type="button"
                    data-active={i === active}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => go(c)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors',
                      i === active ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0 opacity-80" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{c.label}</span>
                      {c.hint && (
                        <span className={cn('block truncate text-[11px]', i === active ? 'opacity-80' : 'text-muted-foreground')}>
                          {c.hint}
                        </span>
                      )}
                    </span>
                    {i === active && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 opacity-80" />}
                  </button>
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-3 border-t bg-muted/30 px-4 py-2 text-[10.5px] text-muted-foreground">
            <span className="flex items-center gap-1"><kbd className="rounded border bg-card px-1 font-mono">↑</kbd><kbd className="rounded border bg-card px-1 font-mono">↓</kbd> navigate</span>
            <span className="flex items-center gap-1"><kbd className="rounded border bg-card px-1 font-mono">↵</kbd> open</span>
            <span className="ml-auto flex items-center gap-1"><ArrowRight className="h-3 w-3" /> {choices.length} result{choices.length === 1 ? '' : 's'}</span>
          </div>
        </div>
      </div>
    </>
  );
}
