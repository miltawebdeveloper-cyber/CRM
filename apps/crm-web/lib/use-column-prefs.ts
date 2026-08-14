'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { tokenStore } from './api';
import { loadServerPreferences, saveServerPreference, removeServerPreference } from './preferences';

/** Server preference key for a table's column layout. */
const serverKeyFor = (tableKey: string) => `cols:${tableKey}`;

/** A single column definition for a customizable table. */
export interface ColumnDef<T> {
  key: string;
  header: string;
  render: (row: T, index: number) => ReactNode;
  /** Optional footer cell (e.g. a totals row), rendered when any column has one. */
  footer?: (rows: T[]) => ReactNode;
  /** Hidden by default until the user enables it. */
  defaultHidden?: boolean;
  /** Cannot be hidden or moved out (e.g. the primary identity column). */
  required?: boolean;
  /**
   * Always the leftmost column, whatever the saved layout says.
   *
   * For the column that identifies the row — the Lead ID. Column order is
   * persisted per user, so moving a column in the source only reaches people who
   * have never customised that table; everyone else keeps the order they saved.
   * This makes the position a property of the column instead, so the rule holds
   * for existing users too, and a later drag can't push it out of first place.
   */
  pinFirst?: boolean;
  /** Default column width in px (user can resize from there). */
  width?: number;
  headerClassName?: string;
  cellClassName?: string;
  /** Eligible for the "Trackable Columns" section (change-tracking). On by default when eligible. */
  trackable?: boolean;
  /** Eligible for the "Searchable Columns" section (global search). On by default when eligible. */
  searchable?: boolean;
  /** Plain-text value used for global search over this column (falls back to none). */
  searchValue?: (row: T) => string | number | null | undefined;
  /**
   * Column can be sorted by clicking its header. Opt-in, because a column whose
   * cell is a button or a chart has nothing meaningful to order by.
   */
  sortable?: boolean;
  /**
   * Value used to order this column. Falls back to `searchValue`, so a column
   * that already declares one gets sorting for free. Numbers and dates compare
   * naturally; strings compare case-insensitively.
   */
  sortValue?: (row: T) => string | number | Date | null | undefined;
}

/** Which column a table is ordered by, and in which direction. */
export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

/**
 * The text a row offers to the table's search box.
 *
 * Two sources, in order of preference:
 *
 *  1. The columns that declare `searchValue` AND are still switched on in the
 *     Column Chooser's "Searchable Columns" section. This is the intended path:
 *     the user controls exactly which fields a search looks at, and the value is
 *     plain text the column author chose rather than whatever its cell rendered.
 *
 *  2. Failing that — a table that declares no searchable columns at all — every
 *     primitive value on the row object. Without this, the search box on tables
 *     like Caller Productivity or City Targets would silently match nothing,
 *     which is worse than matching a shade too much. It can match a field that
 *     is not on screen (an id, say), and that is the accepted cost: pasting an
 *     id to find its row is useful, and nobody types one by accident.
 *
 * Cells are `ReactNode`, so there is deliberately no third option of scraping
 * rendered output — a cell holding a pill, a link or a chart has no text to take.
 */
function searchTextFor<T>(row: T, columns: ColumnDef<T>[], enabled: Set<string>): string {
  const declared = columns.filter((c) => c.searchValue && enabled.has(c.key));
  if (declared.length > 0) {
    return declared.map((c) => c.searchValue!(row) ?? '').join(' ').toLowerCase();
  }
  if (row === null || typeof row !== 'object') return String(row ?? '').toLowerCase();
  return Object.values(row as Record<string, unknown>)
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .join(' ')
    .toLowerCase();
}

/**
 * Narrow rows to those matching a search box query.
 *
 * Whitespace splits the query into terms and EVERY term must match somewhere in
 * the row — so "miami closed" finds Miami leads that are closed, rather than
 * every row containing that exact phrase in one field. Order doesn't matter,
 * which is what makes typing two half-remembered details work.
 */
export function filterRows<T>(
  rows: T[],
  query: string,
  columns: ColumnDef<T>[],
  enabled: Set<string>,
): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return rows;
  return rows.filter((row) => {
    const text = searchTextFor(row, columns, enabled);
    return terms.every((t) => text.includes(t));
  });
}

/**
 * Order rows by the active sort. Blank values always sink to the bottom whichever
 * way the sort runs — an empty cell isn't "smallest", it's just missing, and
 * floating them to the top of an ascending sort buries the real data.
 */
export function sortRows<T>(rows: T[], sort: SortState | null, columns: ColumnDef<T>[]): T[] {
  if (!sort) return rows;
  const col = columns.find((c) => c.key === sort.key);
  const read = col?.sortValue ?? col?.searchValue;
  if (!read) return rows;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = read(a);
    const bv = read(b);
    const aEmpty = av === null || av === undefined || av === '';
    const bEmpty = bv === null || bv === undefined || bv === '';
    if (aEmpty || bEmpty) return aEmpty && bEmpty ? 0 : aEmpty ? 1 : -1;
    if (av instanceof Date || bv instanceof Date) {
      return (new Date(av as Date).getTime() - new Date(bv as Date).getTime()) * dir;
    }
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * dir;
  });
}

interface StoredPrefs {
  order: string[];
  hidden: string[];
  widths?: Record<string, number>;
  /** Trackable-eligible columns the user turned OFF. */
  untracked?: string[];
  /** Searchable-eligible columns the user turned OFF. */
  unsearchable?: string[];
  /**
   * Which revision of the table's own layout this was saved against — see the
   * `layoutRev` argument to `useColumnPrefs`. Absent on anything saved before
   * the mechanism existed, which reads as revision 0.
   */
  layoutRev?: number;
}

/** Decode the current user's id from the JWT so prefs are per-user. */
function currentUserId(): string {
  const token = tokenStore.access;
  if (!token) return 'anon';
  try {
    const payload = JSON.parse(atob(token.split('.')[1] ?? ''));
    return payload.sub ?? payload.email ?? 'anon';
  } catch {
    return 'anon';
  }
}

const keyFor = (tableKey: string) => `crm.cols.${currentUserId()}.${tableKey}`;

function load(tableKey: string): StoredPrefs | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(keyFor(tableKey));
    return raw ? (JSON.parse(raw) as StoredPrefs) : null;
  } catch {
    return null;
  }
}

function saveLocal(tableKey: string, value: StoredPrefs) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(keyFor(tableKey), JSON.stringify(value));
  } catch {
    /* ignore quota / serialization errors */
  }
}

/**
 * A saved column order, reconciled with the columns that exist today.
 *
 * Two things have to happen. Columns the table no longer declares are dropped —
 * a saved layout outlives the code that produced it. And columns the saved
 * layout has never seen have to be placed.
 *
 * Placing them is the part that was wrong. They used to be appended to the end,
 * which on a table like Lead Management — thirty-odd columns and a horizontal
 * scrollbar — puts every new column off the right edge of the screen, in a
 * position nobody chose, for everyone who has ever dragged a column or hidden
 * one. The author's declared position was honoured only for users who had never
 * customised the table at all, which is the smaller half and shrinking. So a
 * column added "next to Created Date" landed next to Created Date for some
 * people and three screens away for the rest.
 *
 * Each new column is instead inserted after its nearest declared neighbour that
 * the user actually has, which reads as "where the author put it, adjusted for
 * whatever this user has done to the rest". Walking the declared order forwards
 * keeps a run of consecutive new columns in their declared sequence, because by
 * the time the second is placed the first is already there to anchor it. A
 * column declared before anything the user has goes to the front.
 *
 * Everything the user did themselves is preserved exactly: this only decides
 * where columns they have never seen go.
 */
export function mergeSavedOrder(savedOrder: string[], declaredOrder: string[]): string[] {
  const declared = new Set(declaredOrder);
  const merged = savedOrder.filter((k) => declared.has(k));
  const present = new Set(merged);

  for (let i = 0; i < declaredOrder.length; i++) {
    const key = declaredOrder[i];
    if (present.has(key)) continue;
    // Nearest column declared to its left that this user actually has.
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const idx = merged.indexOf(declaredOrder[j]);
      if (idx >= 0) {
        at = idx + 1;
        break;
      }
    }
    merged.splice(at, 0, key);
    present.add(key);
  }
  return merged;
}

/**
 * The order to show, given what the user saved and which revision of the
 * table's layout they saved it against.
 *
 * One function so the rule is stated once and can be read whole: a saved layout
 * is honoured, unless the table has been restructured since it was saved — in
 * which case the declared arrangement is adopted, once. See `useColumnPrefs`'s
 * `layoutRev` for why a module is allowed to do that, and for what it is
 * deliberately NOT allowed to reset along with it.
 */
export function resolveOrder(
  savedOrder: string[],
  declaredOrder: string[],
  savedRev: number | undefined,
  layoutRev: number,
): string[] {
  if ((savedRev ?? 0) < layoutRev) return [...declaredOrder];
  return mergeSavedOrder(savedOrder, declaredOrder);
}

export interface ColumnPrefs<T> {
  /** Visible columns, in the user's order — drives the rendered table. */
  visible: ColumnDef<T>[];
  /** All columns in the user's order — drives the customize panel. */
  ordered: ColumnDef<T>[];
  isHidden: (key: string) => boolean;
  toggle: (key: string) => void;
  /** Move the column with `key` to the position of `beforeKey` (drag-and-drop). */
  reorder: (key: string, beforeKey: string) => void;
  /** User-set column widths (px), keyed by column key. */
  widths: Record<string, number>;
  /** Set/override a column's width (drag-to-resize). */
  setWidth: (key: string, px: number) => void;
  reset: () => void;
  /** True when the layout differs from the column defaults. */
  customized: boolean;

  // ── Trackable columns (change-tracking configuration) ──
  /** Columns eligible for tracking (declared `trackable`). */
  trackableColumns: ColumnDef<T>[];
  /** Keys currently enabled for tracking. */
  tracked: Set<string>;
  isTracked: (key: string) => boolean;
  toggleTracked: (key: string) => void;

  // ── Searchable columns (global-search configuration) ──
  /** Columns eligible for search (declared `searchable`). */
  searchableColumns: ColumnDef<T>[];
  /** Keys currently enabled for search. */
  searchable: Set<string>;
  isSearchable: (key: string) => boolean;
  toggleSearchable: (key: string) => void;
}

/**
 * Per-user, per-table column preferences (visibility + order), persisted to
 * localStorage and applied instantly. New columns added to the app appear
 * automatically; removed columns are dropped from saved prefs gracefully.
 *
 * `layoutRev` is how a table says "I have rearranged my columns, adopt it".
 *
 * Normally the saved order wins — it is the user's arrangement and nothing
 * should move it. But a module sometimes restructures its columns as a decision
 * about the module, not a suggestion: a column withdrawn and others put in its
 * place. Then the saved order is a layout of a table that no longer exists, and
 * silently keeping it means the change ships and nobody who has ever touched
 * that table can see it. Bumping the revision replaces the saved ORDER once,
 * with the declared one.
 *
 * Only the order. Which columns are hidden, how wide they are, and which are
 * tracked or searchable are all kept — those are preferences about the data,
 * they stay meaningful across a rearrangement, and throwing them away is the
 * reason "just tell them to press Reset" is a poor answer.
 *
 * Leave it unset for a table whose columns have not been restructured; nothing
 * about the default behaviour changes.
 */
export function useColumnPrefs<T>(tableKey: string, columns: ColumnDef<T>[], layoutRev = 0): ColumnPrefs<T> {
  const pinnedFirst = useMemo(() => columns.filter((c) => c.pinFirst).map((c) => c.key), [columns]);
  /**
   * Put the pinned columns at the front, keeping their declared order among
   * themselves and everything else's order untouched. Applied to the saved
   * layout as well as the default, so a table customised months ago still shows
   * its identity column first.
   */
  const hoistPinned = useCallback(
    (keys: string[]) => {
      if (pinnedFirst.length === 0) return keys;
      const pinned = pinnedFirst.filter((k) => keys.includes(k));
      return [...pinned, ...keys.filter((k) => !pinned.includes(k))];
    },
    [pinnedFirst],
  );
  const defaultOrder = useMemo(() => hoistPinned(columns.map((c) => c.key)), [columns, hoistPinned]);
  const defaultHidden = useMemo(() => columns.filter((c) => c.defaultHidden).map((c) => c.key), [columns]);
  const trackableKeys = useMemo(() => columns.filter((c) => c.trackable).map((c) => c.key), [columns]);
  const searchableKeys = useMemo(() => columns.filter((c) => c.searchable).map((c) => c.key), [columns]);
  const byKey = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns]);

  const [order, setOrder] = useState<string[]>(defaultOrder);
  const [hidden, setHidden] = useState<string[]>(defaultHidden);
  const [widths, setWidths] = useState<Record<string, number>>({});
  // Trackable/searchable-eligible columns the user turned OFF (default: all on).
  const [untracked, setUntracked] = useState<string[]>([]);
  const [unsearchable, setUnsearchable] = useState<string[]>([]);

  // Load saved prefs and merge with the current column set. localStorage is
  // applied instantly; the server copy (cross-device) is applied once it loads.
  useEffect(() => {
    let cancelled = false;
    const applyMerged = (saved: StoredPrefs | null) => {
      if (!saved) {
        setOrder(defaultOrder);
        setHidden(defaultHidden);
        setWidths({});
        setUntracked([]);
        setUnsearchable([]);
        return;
      }
      const known = new Set(defaultOrder);
      // Their arrangement, unless the table has been restructured since they
      // saved it. Only the ORDER is decided here; everything below is kept
      // either way. See `resolveOrder`.
      const mergedOrder = resolveOrder(saved.order, defaultOrder, saved.layoutRev, layoutRev);
      const mergedHidden = saved.hidden.filter((k) => known.has(k));
      // New columns flagged defaultHidden stay hidden unless the user saw them before.
      for (const k of defaultHidden) if (!saved.order.includes(k)) mergedHidden.push(k);
      setOrder(hoistPinned(mergedOrder));
      setHidden(mergedHidden);
      setWidths(saved.widths ?? {});
      setUntracked((saved.untracked ?? []).filter((k) => known.has(k)));
      setUnsearchable((saved.unsearchable ?? []).filter((k) => known.has(k)));
    };

    applyMerged(load(tableKey)); // instant local
    loadServerPreferences().then((all) => {
      if (cancelled) return;
      const sv = all[serverKeyFor(tableKey)] as StoredPrefs | undefined;
      if (sv && sv.order) {
        applyMerged(sv);
        saveLocal(tableKey, sv); // refresh local cache from authoritative server copy
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableKey, defaultOrder, defaultHidden, layoutRev]);

  // Latest committed snapshot, so persist can merge a single-field patch without
  // threading every dimension through each callback's closure. Kept in sync via
  // an effect (never mutated during render). Each action changes one dimension
  // and passes it in the patch, so the rest coming from the last commit is correct.
  const stateRef = useRef<StoredPrefs>({ order, hidden, widths, untracked, unsearchable, layoutRev });
  useEffect(() => {
    stateRef.current = { order, hidden, widths, untracked, unsearchable, layoutRev };
  }, [order, hidden, widths, untracked, unsearchable, layoutRev]);

  const persist = useCallback(
    (patch: Partial<StoredPrefs>) => {
      // Stamped on every save, so a layout adopted once is not re-adopted on the
      // next load — after which the user's arrangement is theirs again and this
      // revision leaves it alone.
      const value: StoredPrefs = { ...stateRef.current, ...patch, layoutRev };
      saveLocal(tableKey, value); // instant
      saveServerPreference(serverKeyFor(tableKey), value); // cross-device (debounced)
    },
    [tableKey, layoutRev],
  );

  const toggle = useCallback(
    (key: string) => {
      if (byKey.get(key)?.required) return;
      setHidden((h) => {
        const next = h.includes(key) ? h.filter((k) => k !== key) : [...h, key];
        persist({ hidden: next });
        return next;
      });
    },
    [byKey, persist],
  );

  const reorder = useCallback(
    (key: string, beforeKey: string) => {
      if (key === beforeKey) return;
      // A pinned column can't be dragged away, and nothing can be dropped in
      // front of one — otherwise the layout the user saves contradicts the rule
      // reloading the page would re-apply.
      if (pinnedFirst.includes(key)) return;
      setOrder((o) => {
        const next = o.filter((k) => k !== key);
        const idx = next.indexOf(beforeKey);
        if (idx < 0) next.push(key);
        else next.splice(idx, 0, key);
        const pinnedOrder = hoistPinned(next);
        persist({ order: pinnedOrder });
        return pinnedOrder;
      });
    },
    [persist, pinnedFirst, hoistPinned],
  );

  const setWidth = useCallback(
    (key: string, px: number) => {
      const w = Math.max(60, Math.round(px));
      setWidths((prev) => {
        const next = { ...prev, [key]: w };
        persist({ widths: next });
        return next;
      });
    },
    [persist],
  );

  // Toggle a column in/out of the tracked set (stored as the OFF list).
  const toggleTracked = useCallback(
    (key: string) => {
      setUntracked((u) => {
        const next = u.includes(key) ? u.filter((k) => k !== key) : [...u, key];
        persist({ untracked: next });
        return next;
      });
    },
    [persist],
  );

  const toggleSearchable = useCallback(
    (key: string) => {
      setUnsearchable((u) => {
        const next = u.includes(key) ? u.filter((k) => k !== key) : [...u, key];
        persist({ unsearchable: next });
        return next;
      });
    },
    [persist],
  );

  const reset = useCallback(() => {
    setOrder(defaultOrder);
    setHidden(defaultHidden);
    setWidths({});
    setUntracked([]);
    setUnsearchable([]);
    if (typeof window !== 'undefined') localStorage.removeItem(keyFor(tableKey));
    removeServerPreference(serverKeyFor(tableKey));
  }, [tableKey, defaultOrder, defaultHidden]);

  const ordered = useMemo(
    () => order.map((k) => byKey.get(k)).filter((c): c is ColumnDef<T> => !!c),
    [order, byKey],
  );
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const visible = useMemo(
    () => ordered.filter((c) => c.required || !hiddenSet.has(c.key)),
    [ordered, hiddenSet],
  );
  const customized = useMemo(
    () =>
      order.join() !== defaultOrder.join() ||
      hidden.slice().sort().join() !== defaultHidden.slice().sort().join() ||
      Object.keys(widths).length > 0 ||
      untracked.length > 0 ||
      unsearchable.length > 0,
    [order, hidden, widths, untracked, unsearchable, defaultOrder, defaultHidden],
  );

  // Trackable / searchable: eligible columns (in the user's column order) and
  // the currently-enabled subset (eligible minus the user's OFF list).
  const trackableColumns = useMemo(
    () => ordered.filter((c) => c.trackable),
    [ordered],
  );
  const searchableColumns = useMemo(
    () => ordered.filter((c) => c.searchable),
    [ordered],
  );
  const untrackedSet = useMemo(() => new Set(untracked), [untracked]);
  const unsearchableSet = useMemo(() => new Set(unsearchable), [unsearchable]);
  const tracked = useMemo(
    () => new Set(trackableKeys.filter((k) => !untrackedSet.has(k))),
    [trackableKeys, untrackedSet],
  );
  const searchable = useMemo(
    () => new Set(searchableKeys.filter((k) => !unsearchableSet.has(k))),
    [searchableKeys, unsearchableSet],
  );

  return {
    visible,
    ordered,
    isHidden: useCallback((k: string) => hiddenSet.has(k), [hiddenSet]),
    toggle,
    reorder,
    widths,
    setWidth,
    reset,
    trackableColumns,
    tracked,
    isTracked: useCallback((k: string) => !untrackedSet.has(k), [untrackedSet]),
    toggleTracked,
    searchableColumns,
    searchable,
    isSearchable: useCallback((k: string) => !unsearchableSet.has(k), [unsearchableSet]),
    toggleSearchable,
    customized,
  };
}
