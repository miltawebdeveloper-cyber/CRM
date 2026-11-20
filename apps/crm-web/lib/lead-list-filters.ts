'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { usePersistedState } from './use-persisted-state';
import { EMPTY_DATE_FILTER, type DateFilterValue, type DateMode } from './date-filters';
import type { SortState } from './use-column-prefs';

export type Ownership = '' | 'assigned' | 'unassigned';
export type ContactFilter = '' | 'contacted' | 'never';
export type FollowUpFilter = '' | 'today' | 'overdue';

/**
 * Everything the Lead Library / Lead Management filter bar holds, as one value.
 *
 * Kept together so the whole view can be saved, restored, cleared and written
 * into the address bar as a unit. Each control used to be its own `useState`,
 * so opening a lead and coming back reset all of them except the date filter —
 * the one value that happened to be persisted.
 *
 * Ownership and contact used to share one "Status" dropdown, so "unassigned
 * AND never contacted" — the pool a manager hands out first — could not be
 * asked for. They are separate fields now, and so is the follow-up quick filter.
 */
export interface LeadListFilters {
  q: string;
  country: string;
  tz: string;
  state: string;
  city: string;
  employeeId: string;
  /** Lead Library only — Lead Management lists assigned leads by definition. */
  ownership: Ownership;
  contact: ContactFilter;
  followUp: FollowUpFilter;
  /** Outcome slugs; a lead matches if its outcome is ANY of them. */
  outcomes: string[];
  dateField: 'created' | 'scheduled';
  dateFilter: DateFilterValue;
  sort: SortState;
}

export const DEFAULT_LEAD_LIST_FILTERS: LeadListFilters = {
  q: '',
  country: '',
  tz: '',
  state: '',
  city: '',
  employeeId: '',
  ownership: '',
  contact: '',
  followUp: '',
  outcomes: [],
  dateField: 'created',
  dateFilter: EMPTY_DATE_FILTER,
  // Import order — row 1 of the uploaded file first. See the pages' notes.
  sort: { key: 'importSeq', dir: 'asc' },
};

/** Single-value filters, and the URL parameter each one travels under. */
const TEXT_PARAMS: [keyof LeadListFilters & string, string][] = [
  ['q', 'q'],
  ['country', 'country'],
  ['tz', 'tz'],
  ['state', 'state'],
  ['city', 'city'],
  ['employeeId', 'employee'],
  ['ownership', 'owner'],
  ['contact', 'contact'],
  ['followUp', 'followup'],
];

/** The values a closed-list filter may hold — anything else reads as unset. */
const ALLOWED: Partial<Record<keyof LeadListFilters, string[]>> = {
  ownership: ['assigned', 'unassigned'],
  contact: ['contacted', 'never'],
  followUp: ['today', 'overdue'],
};

const DATE_MODES: DateMode[] = ['all', 'day', 'week', 'month', 'year', 'custom'];

/**
 * Every parameter this module owns — anything else in the URL is left alone.
 * `status` is the old combined Status dropdown's parameter: still read, so a
 * link made before the split opens the view it named, and cleared on write.
 */
const OWNED_PARAMS = [...TEXT_PARAMS.map(([, p]) => p), 'outcome', 'status', 'on', 'date', 'from', 'to', 'sort'];

const allowed = (key: keyof LeadListFilters, v: string) => !ALLOWED[key] || ALLOWED[key]!.includes(v);

/** The old combined Status value, split into the two fields that replaced it. */
function fromLegacyStatus(status: unknown): Partial<LeadListFilters> {
  if (status === 'assigned' || status === 'unassigned') return { ownership: status };
  if (status === 'contacted') return { contact: 'contacted' };
  return {};
}

/**
 * The filters as URL parameters — only the ones that differ from the default,
 * so an unfiltered list keeps a clean address.
 */
export function filtersToParams(f: LeadListFilters): URLSearchParams {
  const p = new URLSearchParams();
  for (const [key, param] of TEXT_PARAMS) {
    const v = String(f[key] ?? '').trim();
    if (v) p.set(param, v);
  }
  if (f.outcomes.length) p.set('outcome', f.outcomes.join(','));
  if (f.dateField !== DEFAULT_LEAD_LIST_FILTERS.dateField) p.set('on', f.dateField);
  if (f.dateFilter.mode !== 'all' || f.dateFilter.from || f.dateFilter.to) {
    p.set('date', f.dateFilter.mode);
    if (f.dateFilter.from) p.set('from', f.dateFilter.from);
    if (f.dateFilter.to) p.set('to', f.dateFilter.to);
  }
  const s = DEFAULT_LEAD_LIST_FILTERS.sort;
  if (f.sort.key !== s.key || f.sort.dir !== s.dir) p.set('sort', `${f.sort.key}:${f.sort.dir}`);
  return p;
}

/**
 * Filters named by a URL, or null when it names none.
 *
 * A link describes the WHOLE view: whatever it leaves out is the default, not
 * whatever the reader last had saved — otherwise the same link would show two
 * people two different lists. Values that can't be right (an unknown date mode,
 * a sort with no direction, an ownership that isn't one) fall back to the
 * default rather than reaching the API as a filter it will refuse.
 */
export function filtersFromParams(p: URLSearchParams): LeadListFilters | null {
  if (!OWNED_PARAMS.some((k) => p.has(k))) return null;
  const f: LeadListFilters = { ...DEFAULT_LEAD_LIST_FILTERS, ...fromLegacyStatus(p.get('status')) };
  for (const [key, param] of TEXT_PARAMS) {
    const v = p.get(param)?.trim();
    if (v && allowed(key, v)) (f as unknown as Record<string, string>)[key] = v;
  }
  f.outcomes = splitList(p.get('outcome'));
  const on = p.get('on');
  if (on === 'created' || on === 'scheduled') f.dateField = on;
  const mode = p.get('date') as DateMode | null;
  if (mode && DATE_MODES.includes(mode)) {
    f.dateFilter = { mode, from: p.get('from') ?? '', to: p.get('to') ?? '' };
  }
  const [key, dir] = (p.get('sort') ?? '').split(':');
  if (key && (dir === 'asc' || dir === 'desc')) f.sort = { key, dir };
  return f;
}

const splitList = (raw?: string | null) => [...new Set((raw ?? '').split(',').map((s) => s.trim()).filter(Boolean))];

/**
 * How many filters are narrowing the list — the number on "Clear filters".
 *
 * The sort and the Created/Scheduled switch don't count: neither removes a
 * single lead from the list. `employee` is skipped when the viewer can't see
 * that control (it is admin-only), so a value left behind in a shared browser
 * can't produce a count of one with nothing on screen to explain it.
 */
export function activeFilterCount(f: LeadListFilters, opts: { employee?: boolean } = {}): number {
  let n = 0;
  for (const [key] of TEXT_PARAMS) {
    if (key === 'employeeId' && !opts.employee) continue;
    if (String(f[key] ?? '').trim()) n++;
  }
  if (f.outcomes.length) n++;
  if (f.dateFilter.mode !== 'all' || f.dateFilter.from || f.dateFilter.to) n++;
  return n;
}

/** Every filter back to its default, keeping the sort and the date field. */
export function clearedFilters(f: LeadListFilters): LeadListFilters {
  return { ...DEFAULT_LEAD_LIST_FILTERS, sort: f.sort, dateField: f.dateField };
}

/**
 * A stored value from an older shape, filled out to the current one — including
 * the shape before Status was split and Call Outcome became a list, so a saved
 * view survives the change rather than resetting.
 */
export function normaliseFilters(raw: unknown): LeadListFilters {
  if (!raw || typeof raw !== 'object') return DEFAULT_LEAD_LIST_FILTERS;
  const old = raw as Partial<LeadListFilters> & { status?: unknown; callStatus?: unknown };
  const { status, callStatus, ...rest } = old;
  const v: LeadListFilters = { ...DEFAULT_LEAD_LIST_FILTERS, ...fromLegacyStatus(status), ...rest };
  if (!Array.isArray(v.outcomes)) v.outcomes = [];
  if (typeof callStatus === 'string' && callStatus && v.outcomes.length === 0) v.outcomes = [callStatus];
  for (const key of Object.keys(ALLOWED) as (keyof LeadListFilters)[]) {
    const val = v[key];
    if (typeof val !== 'string' || (val && !allowed(key, val))) (v as unknown as Record<string, string>)[key] = '';
  }
  if (!v.dateFilter || typeof v.dateFilter !== 'object') v.dateFilter = EMPTY_DATE_FILTER;
  if (!v.sort || typeof v.sort !== 'object' || !v.sort.key) v.sort = DEFAULT_LEAD_LIST_FILTERS.sort;
  return v;
}

/**
 * The filter bar's state for one lead list, kept across visits and in the URL.
 *
 * Saved in the browser under `storageKey`, so leaving the page — opening a
 * lead, going to the Calling Panel — and coming back by any route restores the
 * view. Mirrored into the address bar, so Back restores it too and the URL is a
 * link to exactly this view. A URL that names filters wins over the saved ones:
 * that is somebody's link being opened.
 */
export function useLeadListFilters(storageKey: string, opts: { employee?: boolean } = {}) {
  const [raw, setRaw] = usePersistedState<LeadListFilters>(storageKey, DEFAULT_LEAD_LIST_FILTERS);
  const filters = useMemo(() => normaliseFilters(raw), [raw]);

  // Read the URL once, on arrival. Afterwards the state is the source of truth
  // and the URL follows it.
  const adopted = useRef(false);
  useEffect(() => {
    if (!adopted.current) {
      adopted.current = true;
      const fromUrl = filtersFromParams(new URLSearchParams(window.location.search));
      if (fromUrl) {
        // Syncing from an external source (the address bar) — what effects are
        // for. Its render comes back through here and writes the URL.
        setRaw(fromUrl);
        return;
      }
    }
    writeUrl(filters);
  }, [filters, setRaw]);

  const update = useCallback((patch: Partial<LeadListFilters>) => setRaw({ ...filters, ...patch }), [filters, setRaw]);
  const clear = useCallback(() => setRaw(clearedFilters(filters)), [filters, setRaw]);
  /** Swap the whole view at once — what opening a saved view does. */
  const replace = useCallback((next: LeadListFilters) => setRaw(normaliseFilters(next)), [setRaw]);
  const activeCount = activeFilterCount(filters, opts);

  return { filters, update, clear, replace, activeCount };
}

/**
 * Put the filters in the address bar without navigating.
 *
 * `history.replaceState` rather than the router: Next.js keeps its own state in
 * step with native history calls, and a router navigation would re-run the
 * route for what is only a change of query string. Replace, not push — a filter
 * change is not a page, and Back should leave Lead Management rather than step
 * through every filter that was tried. Parameters this module doesn't own (a
 * `leadId` someone linked to, say) are kept.
 */
function writeUrl(f: LeadListFilters) {
  const current = new URLSearchParams(window.location.search);
  for (const k of OWNED_PARAMS) current.delete(k);
  for (const [k, v] of filtersToParams(f)) current.set(k, v);
  const qs = current.toString();
  const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
  if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(null, '', next);
  }
}
