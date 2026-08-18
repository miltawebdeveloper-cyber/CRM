'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SlidersHorizontal, GripVertical, X, RotateCcw, Pencil, Trash2, ArrowUp, ArrowDown, ChevronsUpDown, Search } from 'lucide-react';
import { filterRows, useColumnPrefs, type ColumnDef, type ColumnPrefs, type SortState } from '@/lib/use-column-prefs';
import { gridState, isGridBusy } from '@/lib/table-state';
import { ConfirmDialog } from '@/components/confirm-dialog';

export type { ColumnDef } from '@/lib/use-column-prefs';
export { useColumnPrefs } from '@/lib/use-column-prefs';

// `fillViewport` sizing: breathing room below the grid, and the least space
// worth using where the table already sits. Under that threshold it takes a
// screenful and lets the page scroll to it instead.
const VIEWPORT_GAP = 16;
const MIN_VIEWPORT_H = 220;

interface DataTableProps<T> {
  /** Stable key used to persist this table's column layout per user. */
  tableKey: string;
  columns: ColumnDef<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  title?: string;
  subtitle?: ReactNode;
  /** Filters / actions rendered to the left of the Customize Columns button. */
  toolbar?: ReactNode;
  /**
   * There is nothing to show yet — the FIRST load of this table.
   *
   * Not "a request is in flight". A table that empties itself whenever it is
   * fetching is a table that blinks on every filter, every sort and every
   * refresh after a save, and the rows it removes were perfectly good. Pass
   * `refreshing` for that instead; this one draws the placeholder, and only
   * while `rows` is genuinely empty.
   */
  loading?: boolean;
  /**
   * The rows on screen are being brought up to date. Purely an indicator: the
   * grid keeps showing what it has and says quietly that newer data is coming.
   */
  refreshing?: boolean;
  emptyText?: ReactNode;
  onRowClick?: (row: T) => void;
  rowClassName?: string;
  /**
   * Leading selection checkbox on every row (single + multi select) plus a
   * bulk-action bar. On by default for every table — pass `selectable={false}`
   * to opt a table out.
   */
  selectable?: boolean;
  /**
   * How rows are selected when `selectable`. `'checkbox'` (default) shows the
   * leading checkbox column. `'row'` hides the checkbox entirely and toggles
   * selection on row click — used by Outcome & Activity Tracker, which support
   * selection without a visible checkbox.
   */
  selectionMode?: 'checkbox' | 'row';
  /** Bulk Edit handler. Enabled when exactly one row is selected. */
  onEditSelected?: (rows: T[]) => void;
  /** Bulk Delete handler. Enabled for one or more rows; confirmed before calling. */
  onDeleteSelected?: (rows: T[]) => void | Promise<void>;
  editLabel?: string;
  deleteLabel?: string;
  /** Custom confirm message for the Delete action. */
  deleteConfirm?: (rows: T[]) => string;
  /** Extra bulk actions rendered in the selection bar, right of Edit/Delete. */
  bulkActions?: (rows: T[], clear: () => void) => ReactNode;
  /**
   * Optionally share a `useColumnPrefs` instance owned by the page (so the page
   * can read the same searchable/tracked config it applies to `rows`). When
   * omitted the table manages its own prefs.
   */
  prefs?: ColumnPrefs<T>;
  /**
   * Excel-style scrolling: the rows scroll inside a viewport sized to the space
   * left below the table in the window, so the header stays pinned and the
   * horizontal scrollbar rides the bottom of the screen instead of sitting
   * under the last row, pages away. Off by default — the table then grows to
   * fit its rows, which is fine for short ones.
   */
  fillViewport?: boolean;
  /**
   * Click-and-drag across rows to select a run of them, instead of ticking each
   * checkbox. Opt-in, because on a table whose rows are primarily click-to-open
   * it would fight the row click. Dragging from an unselected row selects the
   * run; dragging from a selected one clears it. Requires checkbox selection.
   */
  dragSelect?: boolean;
  /**
   * Rows that can't be picked. Returning false disables that row's checkbox and
   * keeps it out of select-all and drag sweeps — used for leads that already
   * belong to an employee, which must never be swept up by a bulk assignment.
   * `reason` is surfaced as the checkbox tooltip.
   */
  isRowSelectable?: (row: T) => boolean;
  rowNotSelectableReason?: (row: T) => string;
  /**
   * Active sort, owned by the page rather than the table. The page sorts `rows`
   * itself (via `sortRows`) so that exports can reuse exactly the order on screen
   * — a table that sorted internally would leave the Excel file in a different
   * sequence from the grid it was exported from.
   */
  sort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  /**
   * Render the header row in capitals. Styling only — `header` keeps its original
   * casing, so the Column Chooser and CSV/Excel exports still read as proper names
   * rather than shouting.
   */
  uppercaseHeaders?: boolean;
  /**
   * Search box in the table header, filtering these rows against the columns the
   * user has enabled under "Searchable Columns". On by default — pass
   * `searchable={false}` for a table whose rows are already narrowed by a
   * page-level search, so the two can't disagree about what's on screen.
   */
  searchable?: boolean;
  /** Placeholder for the search box. Defaults to a generic prompt. */
  searchPlaceholder?: string;
}

/** Everything one body row needs. Flat and primitive-heavy on purpose: `memo`
 *  below compares these shallowly, so anything rebuilt per render belongs in a
 *  ref on the table, not in here. */
interface RowProps<T> {
  row: T;
  index: number;
  rowKey: string;
  cols: ColumnDef<T>[];
  widths: Record<string, number>;
  selected: boolean;
  pickable: boolean;
  showCheckbox: boolean;
  notSelectableReason?: string;
  /** 'row' selection mode marks the row itself as selected for assistive tech. */
  rowMode: boolean;
  clickable: boolean;
  dragOn: boolean;
  dragging: boolean;
  rowClassName: string;
  onRowClick: (rowKey: string, index: number) => void;
  onToggle: (rowKey: string) => void;
  onDragStart: (e: React.MouseEvent, index: number, rowKey: string) => void;
  onDragOver: (index: number) => void;
}

/**
 * One body row, re-rendered only when its own inputs change.
 *
 * The reason this is a separate memoised component rather than inline JSX: the
 * grid holds every lead that has been scrolled into it — a few thousand after a
 * few minutes' work — and several columns render real components with their own
 * state (the editable Outcome, Comments and Lost Reason cells). Rendering the
 * body inline meant every one of them re-rendered whenever ANY table state
 * moved: a keystroke in the table's search box, a tick in a checkbox, and worst
 * of all a drag-select, which fires a selection update for every row the pointer
 * crosses. That is thousands of component renders per pointer move, and it is
 * what made sweeping a long list feel like the page had frozen.
 *
 * Now a selection change re-renders the two rows whose `selected` actually
 * flipped. The handlers are passed as stable callbacks from the table (see the
 * refs around them) — a fresh closure per render would defeat the comparison and
 * put us straight back where we started.
 */
const TableRow = memo(function TableRow<T>({
  row,
  index,
  rowKey,
  cols,
  widths,
  selected,
  pickable,
  showCheckbox,
  notSelectableReason,
  rowMode,
  clickable,
  dragOn,
  dragging,
  rowClassName,
  onRowClick,
  onToggle,
  onDragStart,
  onDragOver,
}: RowProps<T>) {
  return (
    <tr
      onClick={clickable ? () => onRowClick(rowKey, index) : undefined}
      onMouseDown={dragOn ? (e) => onDragStart(e, index, rowKey) : undefined}
      onMouseEnter={dragOn ? () => onDragOver(index) : undefined}
      aria-selected={rowMode ? selected : undefined}
      className={`group border-b last:border-0 hover:bg-muted/50 ${selected ? 'bg-primary/5' : ''} ${clickable ? 'cursor-pointer' : ''} ${dragging ? 'select-none' : ''} ${rowClassName}`}
    >
      {showCheckbox && (
        <td className="w-10 px-4 py-[var(--row-py)]" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            disabled={!pickable}
            title={pickable ? undefined : notSelectableReason}
            onChange={() => pickable && onToggle(rowKey)}
            aria-label="Select row"
            className={`h-4 w-4 accent-[var(--brand)] align-middle ${pickable ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'}`}
          />
        </td>
      )}
      {cols.map((c) => {
        const w = widths[c.key] ?? c.width;
        return (
          <td key={c.key} style={w ? { maxWidth: w } : undefined} className={`px-4 py-[var(--row-py)] ${w ? 'overflow-hidden text-ellipsis' : ''} ${c.cellClassName ?? ''}`}>{c.render(row, index)}</td>
        );
      })}
    </tr>
  );
  // `memo` erases the generic; the cast restores it for callers. Standard for a
  // memoised generic component — the runtime value is unchanged.
}) as <T>(p: RowProps<T>) => React.ReactElement;

export function DataTable<T>({
  tableKey,
  columns,
  rows: allRows,
  getRowKey,
  title,
  subtitle,
  toolbar,
  loading,
  refreshing,
  emptyText = 'No records.',
  onRowClick,
  rowClassName = '',
  selectable,
  selectionMode = 'checkbox',
  onEditSelected,
  onDeleteSelected,
  editLabel = 'Edit',
  deleteLabel = 'Delete',
  deleteConfirm,
  bulkActions,
  prefs: prefsProp,
  fillViewport,
  dragSelect,
  isRowSelectable,
  rowNotSelectableReason,
  sort,
  onSortChange,
  uppercaseHeaders,
  searchable,
  searchPlaceholder = 'Search this table…',
}: DataTableProps<T>) {
  // Always create an instance (hooks can't be conditional); prefer the page's
  // shared prefs when provided so config stays in sync with the page's data.
  const ownPrefs = useColumnPrefs(tableKey, columns);
  const prefs = prefsProp ?? ownPrefs;
  const [panelOpen, setPanelOpen] = useState(false);
  const cols = prefs.visible;

  // ── Table search ──
  // Applied here, at the top, so everything downstream — selection, drag ranges,
  // the footer totals row and the empty state — sees exactly the rows on screen.
  // Filtering later would leave the footer totalling records the grid isn't
  // showing, and let a bulk Delete reach a row the search had hidden.
  const searchOn = searchable !== false;
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rows = useMemo(
    () => (searchOn && query ? filterRows(allRows, query, prefs.ordered, prefs.searchable) : allRows),
    [searchOn, query, allRows, prefs.ordered, prefs.searchable],
  );
  const closeSearch = () => { setQuery(''); setSearchOpen(false); };

  // What the body shows, and whether newer data is on its way. The rule itself
  // lives in `lib/table-state`, where it is stated once and tested — see the
  // note there for why it is not decided inline any more.
  const busy = isGridBusy({ loading, refreshing });
  const state = gridState({ loading, refreshing, rowCount: rows.length });

  // ── Row selection ── on by default; opt out with selectable={false}.
  const selectionOn = selectable !== false;
  // 'row' mode hides the checkbox column and selects on row click instead.
  const showCheckbox = selectionOn && selectionMode !== 'row';
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);

  // selectedRows filters against the current rows, so keys for rows that have
  // been filtered out simply don't count — no separate pruning needed.
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(getRowKey(r))), [rows, selected, getRowKey]);
  // Rows the caller allows picking. Select-all and drag operate on these only, so
  // a locked row can never be swept into a bulk action by accident.
  const canSelectRow = (row: T) => (isRowSelectable ? isRowSelectable(row) : true);
  const pickableRows = useMemo(
    () => (isRowSelectable ? rows.filter(isRowSelectable) : rows),
    [rows, isRowSelectable],
  );
  const allSelected = pickableRows.length > 0 && selectedRows.length === pickableRows.length;
  const someSelected = selectedRows.length > 0 && !allSelected;
  const clearSelection = () => setSelected(new Set());
  // Stable across renders: it is handed to every body row, and a fresh closure
  // each render would re-render all of them (see `TableRow`). The updater form
  // is what makes that safe — it never needs to close over the current set.
  const toggleRow = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(pickableRows.map(getRowKey)));

  // ── Drag-to-select ──
  // Every extension of the drag is applied against the selection as it was when
  // the drag STARTED, not the previous frame, so sweeping past a row and back
  // again leaves it as it was rather than latching it on.
  const dragOn = dragSelect === true && showCheckbox;
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ anchor: number; mode: 'add' | 'remove'; moved: boolean } | null>(null);
  const dragBaseRef = useRef<Set<string>>(new Set());
  // A drag ends in a click on the row it finished over; without this that click
  // would also fire the row's own handler (opening a lead, say).
  const suppressClickRef = useRef(false);

  /**
   * The three things a drag needs that change every render — the rows, the
   * selection, and which rows may be picked — read through a ref.
   *
   * The handlers below are given to every row, so they have to keep the same
   * identity from render to render or the memoised rows all re-render anyway.
   * Closing over `rows` and `selected` directly would change that identity on
   * every fetch and every tick of the selection; reading them through a box that
   * is updated in place does not.
   */
  const dragCtx = useRef({ rows, selected, canSelectRow, getRowKey });
  useEffect(() => {
    dragCtx.current = { rows, selected, canSelectRow, getRowKey };
  });

  const applyDragRange = useCallback((index: number) => {
    const d = dragRef.current;
    if (!d) return;
    const { rows: r, canSelectRow: pickable, getRowKey: keyOf } = dragCtx.current;
    const [lo, hi] = d.anchor <= index ? [d.anchor, index] : [index, d.anchor];
    // Locked rows inside the swept span are stepped over, not selected.
    const keys = r.slice(lo, hi + 1).filter(pickable).map(keyOf);
    setSelected(() => {
      const next = new Set(dragBaseRef.current);
      for (const k of keys) (d.mode === 'add' ? next.add(k) : next.delete(k));
      return next;
    });
  }, []);

  const startDrag = useCallback((e: React.MouseEvent, index: number, key: string) => {
    const { rows: r, selected: sel, canSelectRow: pickable } = dragCtx.current;
    // Left button only, and never when the press landed on something interactive
    // (the row's own checkbox, action buttons, links).
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea, label')) return;
    // Starting on a locked row would set the drag's add/remove mode from a row that
    // can never change — begin the sweep only from a pickable one.
    if (!pickable(r[index])) return;
    dragBaseRef.current = new Set(sel);
    dragRef.current = { anchor: index, mode: sel.has(key) ? 'remove' : 'add', moved: false };
    setDragging(true);
    applyDragRange(index);
    e.preventDefault(); // stops the browser text-selecting across rows
  }, [applyDragRange]);

  const extendDrag = useCallback((index: number) => {
    if (!dragRef.current) return;
    dragRef.current.moved = true;
    applyDragRange(index);
  }, [applyDragRange]);

  // Release anywhere ends the drag — including outside the table, which is where
  // a fast sweep usually lets go.
  useEffect(() => {
    if (!dragging) return;
    const onUp = () => {
      suppressClickRef.current = !!dragRef.current?.moved;
      dragRef.current = null;
      setDragging(false);
      if (suppressClickRef.current) setTimeout(() => (suppressClickRef.current = false), 0);
    };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, [dragging]);

  /**
   * What a click on the row body does.
   *
   * In 'row' selection mode it toggles selection; otherwise it falls back to the
   * caller's `onRowClick` (opening a lead, say). A click that ENDS a drag is
   * swallowed, so finishing a sweep over a row doesn't also open it.
   *
   * Stable, for the same reason as the drag handlers: it is passed to every row.
   */
  const rowSelectMode = selectionOn && selectionMode === 'row';
  const rowClickable = rowSelectMode || !!onRowClick;
  const clickCtx = useRef({ rowSelectMode, onRowClick, rows });
  useEffect(() => {
    clickCtx.current = { rowSelectMode, onRowClick, rows };
  });
  const activateRow = useCallback(
    (key: string, index: number) => {
      if (suppressClickRef.current) return;
      const ctx = clickCtx.current;
      if (ctx.rowSelectMode) toggleRow(key);
      else ctx.onRowClick?.(ctx.rows[index]);
    },
    [toggleRow],
  );

  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  // Delete opens the styled confirm dialog rather than window.confirm — same flow,
  // but in the product's own voice and with a busy state while it runs.
  const [confirmDelete, setConfirmDelete] = useState<T[] | null>(null);
  const runDelete = () => {
    if (!onDeleteSelected || selectedRows.length === 0) return;
    setConfirmDelete(selectedRows);
  };
  const doDelete = async () => {
    if (!onDeleteSelected || !confirmDelete) return;
    setDeleting(true);
    try {
      await onDeleteSelected(confirmDelete);
      clearSelection();
    } finally {
      setDeleting(false);
    }
  };

  // +1 leading column for the selection checkbox, when visible.
  const bodyColSpan = cols.length + (showCheckbox ? 1 : 0);

  // ── Excel-style viewport (`fillViewport`) ──
  // How tall the rows may be. A fixed height (say 70vh) can't work: it knows
  // nothing about the filters and cards stacked above, so on a shorter window
  // the viewport's bottom edge — and with it the horizontal scrollbar — lands
  // off screen. So measure instead. See `measure` for the two cases.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportH, setViewportH] = useState<number>();
  useEffect(() => {
    if (!fillViewport) return;
    const el = scrollRef.current;
    if (!el) return;

    // The app shell is h-screen and scrolls <main>, so the window never scrolls
    // and its metrics say nothing about the space we have. Measure against the
    // ancestor that actually scrolls, falling back to the window.
    let scroller: HTMLElement | null = el.parentElement;
    while (scroller) {
      const oy = getComputedStyle(scroller).overflowY;
      if (oy === 'auto' || oy === 'scroll') break;
      scroller = scroller.parentElement;
    }

    const measure = () => {
      const node = scrollRef.current;
      if (!node) return;
      /**
       * Rendered px → layout px.
       *
       * The shell scales itself on laptop widths (see `.app-shell`), and the two
       * families of measurement below disagree under any scale:
       * `getBoundingClientRect()` reports what is on the GLASS, while
       * `clientHeight`, `scrollTop` and the `maxHeight` we set are all in the
       * element's own layout units. Mixing them makes the offset read ~9% short
       * on a 1366px laptop, so the table is handed more height than there is room
       * for and the page scrolls — the one thing capping the height prevents.
       *
       * Derived from the element rather than read from the CSS variable, so it
       * stays right wherever the scale is declared, and comes out at exactly 1
       * when there is none.
       */
      const box = node.getBoundingClientRect();
      const scale = node.offsetWidth > 0 ? box.width / node.offsetWidth : 1;
      const toLayoutPx = (renderedPx: number) => (scale > 0 ? renderedPx / scale : renderedPx);

      // `clientHeight` is already layout px; `innerHeight` is glass px.
      const viewH = scroller ? scroller.clientHeight : toLayoutPx(window.innerHeight);
      // Our offset *within the scrolled content*, so the result holds no matter
      // how far the user has scrolled when this runs.
      const offset = scroller
        ? toLayoutPx(box.top - scroller.getBoundingClientRect().top) + scroller.scrollTop
        : toLayoutPx(box.top) + window.scrollY;
      const below = viewH - offset - VIEWPORT_GAP;
      // A table near the top of a page takes the room left below it, so the page
      // itself barely scrolls and the horizontal scrollbar never leaves the
      // screen. A table sitting under a tall dashboard has no such room — give
      // it a screenful, so scrolling down to it fills the window instead of
      // squeezing the grid into a letterbox.
      setViewportH(below >= MIN_VIEWPORT_H ? below : viewH - VIEWPORT_GAP * 2);
    };

    // First pass on the next frame, once the rows and filters above have laid out.
    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    // Content above us moves our top edge (filters wrapping, the sync banner
    // appearing). Our own height can't move an edge above us, so re-measuring
    // settles in one pass rather than oscillating.
    const ro = new ResizeObserver(measure);
    ro.observe(scroller?.firstElementChild ?? document.body);
    if (scroller) ro.observe(scroller);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      ro.disconnect();
    };
  }, [fillViewport]);

  // Header cells carry the sticky positioning themselves rather than leaning on
  // <thead>/<tr>: preflight sets `border-collapse: collapse`, under which a
  // sticky row's background and bottom border don't travel with it. Hence the
  // background here and an inset shadow standing in for the border. No-ops
  // until `maxHeight` makes the viewport scrollable.
  const stickyHeadCls = 'sticky top-0 bg-background shadow-[inset_0_-1px_0_hsl(var(--border))]';

  // ── Sorting ──
  // Controlled by the page (it owns the ordering so exports match the grid).
  const sortOn = !!sort && !!onSortChange;
  const sortedColLabel = sortOn ? (columns.find((c) => c.key === sort!.key)?.header ?? sort!.key) : '';
  // Clicking a sortable header sorts by it; clicking the one already active flips
  // direction. A newly picked column always starts ascending.
  const toggleSort = (key: string) => {
    if (!onSortChange) return;
    onSortChange(sort?.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });
  };

  // Header casing, applied to BOTH the th and the sort button inside it.
  const headCaseCls = uppercaseHeaders ? 'uppercase tracking-[.06em]' : '';

  // Effective width for a column: user-set override → column default → auto.
  const widthOf = (c: ColumnDef<T>): number | undefined => prefs.widths[c.key] ?? c.width;

  // Drag the right edge of a header to resize that column (persisted per user).
  const startResize = (e: React.MouseEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
    // `offsetWidth` is the column's LAYOUT width, which is the unit `setWidth`
    // stores and CSS applies. `clientX` is a glass coordinate, so the drag
    // distance is converted with the same scale the shell is drawn at —
    // otherwise, on a scaled laptop, the column jumped narrower on grab (a
    // rendered width written back as a layout width) and then trailed the
    // cursor by the scale factor for the rest of the drag.
    const scale = th.offsetWidth > 0 ? th.getBoundingClientRect().width / th.offsetWidth : 1;
    const startW = th.offsetWidth;
    const startX = e.clientX;
    const move = (me: MouseEvent) =>
      prefs.setWidth(key, startW + (me.clientX - startX) / (scale > 0 ? scale : 1));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div className="relative overflow-hidden rounded-2xl border bg-card shadow-sm">
      {/* Newer rows are on their way and the current ones are still readable.
          A hairline at the top edge of the card, because the alternative — the
          one this replaces — was emptying the grid to prove a request was in
          flight. Hidden from assistive tech: `aria-busy` on the table below is
          the accessible version of the same fact. */}
      {busy && rows.length > 0 && (
        <div aria-hidden className="absolute inset-x-0 top-0 z-30 h-[2px] overflow-hidden bg-primary/10">
          <div className="h-full w-1/3 animate-[dt-sweep_1.1s_ease-in-out_infinite] rounded-full bg-primary/60" />
        </div>
      )}
      {/* `searchOn` is in the condition so a table with no title still gets its
          header bar — otherwise Pipeline, which passes neither title nor toolbar,
          would be the one leads table with no search box and no Columns button. */}
      {(title || subtitle || toolbar || searchOn || (selectionOn && selectedRows.length > 0)) && (
        <div className="flex flex-wrap items-center justify-between gap-2.5 border-b px-[18px] py-4">
          <div>
            {title && <h3 className="font-display text-[14px] font-semibold">{title}</h3>}
            {subtitle && <div className="text-[11.5px] text-muted-foreground">{subtitle}</div>}
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Selection actions — edit/delete symbols above the table, top-right. */}
            {selectionOn && selectedRows.length > 0 && (
              <div className="flex items-center gap-2 rounded-md border bg-primary/5 px-2.5 py-1">
                <span className="text-[12.5px] font-semibold">{selectedRows.length} selected</span>
                {onEditSelected && (
                  <button
                    onClick={() => onEditSelected(selectedRows)}
                    disabled={selectedRows.length !== 1}
                    title={selectedRows.length !== 1 ? 'Select a single record to edit' : editLabel}
                    aria-label={editLabel}
                    className="grid h-8 w-8 place-items-center rounded-md border bg-card text-foreground hover:bg-muted disabled:opacity-40"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                )}
                {onDeleteSelected && (
                  <button
                    onClick={runDelete}
                    disabled={deleting}
                    title={deleteLabel}
                    aria-label={deleteLabel}
                    className="grid h-8 w-8 place-items-center rounded-md border border-[var(--tone-red-line)] bg-[var(--tone-red-bg-2)] text-[var(--tone-red-fg)] hover:bg-[#f9e7e3] disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
                {bulkActions?.(selectedRows, clearSelection)}
                <button onClick={clearSelection} title="Clear selection" aria-label="Clear selection" className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}
            {toolbar}
            {/* Table search — collapsed to an icon until asked for, so it costs a
                header row nothing on the tables nobody searches. Stays expanded
                while a query is live: collapsing it would hide the reason the
                grid is showing four rows out of four hundred. */}
            {searchOn && (
              searchOpen || query ? (
                <div className="flex items-center gap-[7px] rounded-md border bg-card px-3 py-2 text-[12.5px] font-medium">
                  <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') closeSearch(); }}
                    placeholder={searchPlaceholder}
                    aria-label={`Search ${title ?? 'table'}`}
                    className="w-[180px] border-none bg-transparent font-medium outline-none placeholder:text-muted-foreground"
                  />
                  <button
                    onClick={closeSearch}
                    title="Clear search"
                    aria-label="Clear search"
                    className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setSearchOpen(true)}
                  title="Search this table"
                  aria-label="Search this table"
                  className="grid h-[38px] w-[38px] place-items-center rounded-md border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Search className="h-3.5 w-3.5" />
                </button>
              )
            )}
            {/* Sort direction — sits immediately left of the Column Chooser. Shows
                which column is ordering the grid and flips asc/desc; the active
                arrow is the highlighted one. */}
            {sortOn && (
              <div className="flex items-center gap-1 rounded-md border bg-card px-1.5 py-1">
                <span className="max-w-[110px] truncate pl-1 pr-0.5 text-[11.5px] text-muted-foreground" title={sortedColLabel}>
                  {sortedColLabel}
                </span>
                <button
                  onClick={() => onSortChange?.({ key: sort!.key, dir: 'asc' })}
                  title="Sort ascending"
                  aria-label="Sort ascending"
                  aria-pressed={sort!.dir === 'asc'}
                  className={`grid h-6 w-6 place-items-center rounded ${sort!.dir === 'asc' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => onSortChange?.({ key: sort!.key, dir: 'desc' })}
                  title="Sort descending"
                  aria-label="Sort descending"
                  aria-pressed={sort!.dir === 'desc'}
                  className={`grid h-6 w-6 place-items-center rounded ${sort!.dir === 'desc' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            <ColumnsButton onClick={() => setPanelOpen(true)} customized={prefs.customized} />
          </div>
        </div>
      )}

      {/* Scrolls on both axes. Capping the height is what makes the header stick
          and keeps the horizontal scrollbar on screen; uncapped, the element
          just grows and neither engages. */}
      <div ref={scrollRef} className="overflow-auto" style={viewportH ? { maxHeight: viewportH } : undefined}>
        <table aria-busy={busy || undefined} className="w-full whitespace-nowrap text-[12.5px]">
          <thead className="sticky top-0 z-20">
            <tr className="border-b text-left text-[11.5px] font-semibold uppercase tracking-[.06em] text-muted-foreground">
              {showCheckbox && (
                <th className={`w-10 px-4 py-[var(--row-py-head)] ${stickyHeadCls}`}>
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label="Select all rows"
                    className="h-4 w-4 cursor-pointer accent-[var(--brand)] align-middle"
                  />
                </th>
              )}
              {cols.map((c) => {
                const w = widthOf(c);
                return (
                  <th
                    key={c.key}
                    style={w ? { width: w, minWidth: w, maxWidth: w } : undefined}
                    className={`group/th relative px-4 py-[var(--row-py-head)] font-semibold ${headCaseCls} ${stickyHeadCls} ${c.headerClassName ?? ''}`}
                  >
                    {sortOn && c.sortable ? (
                      // Click the header to order by that column; the active one
                      // carries the direction arrow, the rest a muted hint.
                      <button
                        onClick={() => toggleSort(c.key)}
                        title={`Sort by ${c.header}`}
                        // The uppercase class is repeated here on purpose: the
                        // browser reset sets `text-transform: none` on <button>,
                        // which would otherwise cancel the casing inherited from
                        // the <th> and leave only the unsortable headers in caps.
                        className={`flex w-full items-center gap-1 font-semibold ${headCaseCls} ${c.headerClassName?.includes('text-right') ? 'justify-end' : ''} ${
                          sort!.key === c.key ? 'text-foreground' : 'hover:text-foreground'
                        }`}
                      >
                        <span className={w ? 'truncate' : undefined}>{c.header}</span>
                        {sort!.key === c.key ? (
                          sort!.dir === 'asc' ? (
                            <ArrowUp className="h-3 w-3 shrink-0 text-primary" />
                          ) : (
                            <ArrowDown className="h-3 w-3 shrink-0 text-primary" />
                          )
                        ) : (
                          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/th:opacity-40" />
                        )}
                      </button>
                    ) : (
                      <span className={w ? 'block truncate' : undefined}>{c.header}</span>
                    )}
                    <span
                      onMouseDown={(e) => startResize(e, c.key)}
                      title="Drag to resize"
                      className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize select-none bg-transparent hover:bg-primary/40"
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {/* The placeholder appears only when there is nothing behind it.
                While rows exist they stay on screen through every refetch —
                see the `loading` / `refreshing` props. */}
            {state === 'placeholder' && (
              <tr><td colSpan={bodyColSpan} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {/* An empty grid because the SEARCH matched nothing is a different
                fact from an empty table, and says so — otherwise "No records."
                reads as no data and hides the query that caused it. */}
            {state === 'empty' && (
              <tr>
                <td colSpan={bodyColSpan} className="px-4 py-8 text-center text-muted-foreground">
                  {query && allRows.length > 0 ? (
                    <>
                      No records match “{query}”.{' '}
                      <button onClick={closeSearch} className="font-semibold text-primary hover:underline">
                        Clear search
                      </button>
                    </>
                  ) : (
                    emptyText
                  )}
                </td>
              </tr>
            )}
            {rows.map((row, i) => {
              const key = getRowKey(row);
              const pickable = canSelectRow(row);
              return (
                <TableRow
                  key={key}
                  row={row}
                  index={i}
                  rowKey={key}
                  cols={cols}
                  widths={prefs.widths}
                  selected={selected.has(key)}
                  pickable={pickable}
                  showCheckbox={showCheckbox}
                  notSelectableReason={pickable ? undefined : rowNotSelectableReason?.(row)}
                  rowMode={rowSelectMode}
                  clickable={rowClickable}
                  dragOn={dragOn}
                  dragging={dragging}
                  rowClassName={rowClassName}
                  onRowClick={activateRow}
                  onToggle={toggleRow}
                  onDragStart={startDrag}
                  onDragOver={extendDrag}
                />
              );
            })}
          </tbody>
          {rows.length > 0 && cols.some((c) => c.footer) && (
            <tfoot>
              <tr className="border-t bg-muted/30 font-semibold">
                {showCheckbox && <td className="w-10 px-4 py-3" />}
                {cols.map((c) => {
                  const w = widthOf(c);
                  return (
                    <td key={c.key} style={w ? { maxWidth: w } : undefined} className={`px-4 py-3 ${w ? 'overflow-hidden text-ellipsis' : ''} ${c.cellClassName ?? ''}`}>{c.footer ? c.footer(rows) : null}</td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <CustomizePanel open={panelOpen} onClose={() => setPanelOpen(false)} prefs={prefs} />

      {confirmDelete && (
        <ConfirmDialog
          title="Confirm Delete"
          message={
            deleteConfirm
              ? deleteConfirm(confirmDelete)
              : `Are you sure you want to delete the selected ${confirmDelete.length === 1 ? 'record' : `${confirmDelete.length} records`}? This action cannot be undone.`
          }
          confirmLabel={deleteLabel}
          onConfirm={doDelete}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

/** Standalone "Columns" button (matches the app's filter-bar styling). */
export function ColumnsButton({ onClick, customized }: { onClick: () => void; customized?: boolean }) {
  return (
    <button
      onClick={onClick}
      title="Customize columns"
      className="inline-flex items-center gap-[7px] rounded-md border bg-card px-3 py-2 text-[12.5px] font-medium hover:bg-muted"
    >
      <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
      Columns
      {customized && <span className="h-1.5 w-1.5 rounded-full bg-primary" title="Customized" />}
    </button>
  );
}

/**
 * Self-contained Customize Columns control (button + side panel) for tables
 * that render their own markup (e.g. dashboard widgets). Share the same `prefs`
 * object you use to render the table.
 */
export function CustomizeColumnsControl<T>({ prefs }: { prefs: ColumnPrefs<T> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ColumnsButton onClick={() => setOpen(true)} customized={prefs.customized} />
      <CustomizePanel open={open} onClose={() => setOpen(false)} prefs={prefs} />
    </>
  );
}

function CustomizePanel<T>({
  open,
  onClose,
  prefs,
}: {
  open: boolean;
  onClose: () => void;
  prefs: ReturnType<typeof useColumnPrefs<T>>;
}) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/30 transition-opacity duration-200 ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      />
      {/* Side panel */}
      <aside
        className={`fixed inset-y-0 right-0 z-50 flex w-[320px] max-w-[88vw] flex-col bg-card shadow-2xl transition-transform duration-200 ${open ? 'translate-x-0' : 'translate-x-full'}`}
        aria-hidden={!open}
      >
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h3 className="font-display text-[14px] font-semibold">Customize Columns</h3>
            <p className="text-[11.5px] text-muted-foreground">Show/hide &amp; reorder · configure tracking &amp; search</p>
          </div>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {/* ── Visible columns: show/hide + drag to reorder ── */}
          <SectionLabel>Visible Columns</SectionLabel>
          {prefs.ordered.map((col) => {
            const hidden = prefs.isHidden(col.key);
            const isOver = overKey === col.key && dragKey !== col.key;
            // A pinned column is always leftmost, so it can't be dragged and
            // nothing can be dropped in front of it. Shown as fixed rather than
            // left draggable — a drag that silently snaps back reads as a bug.
            const fixed = col.required || col.pinFirst;
            return (
              <div
                key={col.key}
                draggable={!fixed}
                onDragStart={() => setDragKey(col.key)}
                onDragEnd={() => { setDragKey(null); setOverKey(null); }}
                onDragOver={(e) => { if (col.pinFirst) return; e.preventDefault(); setOverKey(col.key); }}
                onDrop={(e) => { e.preventDefault(); if (dragKey && !col.pinFirst) prefs.reorder(dragKey, col.key); setDragKey(null); setOverKey(null); }}
                className={`mb-1.5 flex items-center gap-2.5 rounded-lg border px-3 py-2.5 transition-colors ${isOver ? 'border-primary bg-primary/5' : 'border-transparent bg-background'} ${dragKey === col.key ? 'opacity-50' : ''}`}
              >
                <GripVertical className={`h-4 w-4 shrink-0 ${fixed ? 'text-muted-foreground/30' : 'cursor-grab text-muted-foreground'}`} />
                <label className="flex flex-1 cursor-pointer items-center justify-between gap-2 text-[12.5px]">
                  <span className={hidden && !col.required ? 'text-muted-foreground' : 'font-medium'}>
                    {col.header || '—'}
                    {col.pinFirst && <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">pinned first</span>}
                  </span>
                  <input
                    type="checkbox"
                    checked={col.required || !hidden}
                    disabled={col.required}
                    onChange={() => prefs.toggle(col.key)}
                    className="h-4 w-4 accent-[var(--brand)] disabled:opacity-40"
                  />
                </label>
              </div>
            );
          })}

          {/* ── Trackable columns: which columns are change-tracked ── */}
          {prefs.trackableColumns.length > 0 && (
            <>
              <SectionLabel hint="Columns whose changes are recorded on the timeline">Trackable Columns</SectionLabel>
              {prefs.trackableColumns.map((col) => (
                <ConfigRow
                  key={col.key}
                  label={col.header || '—'}
                  checked={prefs.isTracked(col.key)}
                  onChange={() => prefs.toggleTracked(col.key)}
                />
              ))}
            </>
          )}


        </div>

        <div className="flex items-center justify-between gap-2 border-t px-5 py-3.5">
          <button
            onClick={prefs.reset}
            disabled={!prefs.customized}
            className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-2 text-[12.5px] font-medium hover:bg-muted disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset to default
          </button>
          <button onClick={onClose} className="rounded-md bg-primary px-4 py-2 text-[12.5px] font-semibold text-primary-foreground hover:opacity-90">Done</button>
        </div>
      </aside>
    </>
  );
}

/** Small uppercase divider label for a section in the Customize panel. */
function SectionLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-1.5 mt-4 px-1 first:mt-0">
      <div className="text-[11px] font-semibold uppercase tracking-[.08em] text-muted-foreground">{children}</div>
      {hint && <div className="mt-0.5 text-[10.5px] text-muted-foreground/80">{hint}</div>}
    </div>
  );
}

/** A plain checkbox row (no drag handle) used by the Trackable / Searchable sections. */
function ConfigRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="mb-1.5 flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-transparent bg-background px-3 py-2.5 text-[12.5px] hover:border-border">
      <span className={checked ? 'font-medium' : 'text-muted-foreground'}>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-4 w-4 accent-[var(--brand)]"
      />
    </label>
  );
}
