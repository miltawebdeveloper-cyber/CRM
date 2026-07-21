'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SlidersHorizontal, GripVertical, X, RotateCcw, Pencil, Trash2 } from 'lucide-react';
import { useColumnPrefs, type ColumnDef, type ColumnPrefs } from '@/lib/use-column-prefs';

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
  loading?: boolean;
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
}

export function DataTable<T>({
  tableKey,
  columns,
  rows,
  getRowKey,
  title,
  subtitle,
  toolbar,
  loading,
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
}: DataTableProps<T>) {
  // Always create an instance (hooks can't be conditional); prefer the page's
  // shared prefs when provided so config stays in sync with the page's data.
  const ownPrefs = useColumnPrefs(tableKey, columns);
  const prefs = prefsProp ?? ownPrefs;
  const [panelOpen, setPanelOpen] = useState(false);
  const cols = prefs.visible;

  // ── Row selection ── on by default; opt out with selectable={false}.
  const selectionOn = selectable !== false;
  // 'row' mode hides the checkbox column and selects on row click instead.
  const showCheckbox = selectionOn && selectionMode !== 'row';
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);

  // selectedRows filters against the current rows, so keys for rows that have
  // been filtered out simply don't count — no separate pruning needed.
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(getRowKey(r))), [rows, selected, getRowKey]);
  const allSelected = rows.length > 0 && selectedRows.length === rows.length;
  const someSelected = selectedRows.length > 0 && !allSelected;
  const clearSelection = () => setSelected(new Set());
  const toggleRow = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map(getRowKey)));

  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const runDelete = async () => {
    if (!onDeleteSelected || selectedRows.length === 0) return;
    const n = selectedRows.length;
    const msg = deleteConfirm
      ? deleteConfirm(selectedRows)
      : `Delete ${n} selected record${n > 1 ? 's' : ''}? This can’t be undone.`;
    if (typeof window !== 'undefined' && !window.confirm(msg)) return;
    setDeleting(true);
    try {
      await onDeleteSelected(selectedRows);
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
      const viewH = scroller ? scroller.clientHeight : window.innerHeight;
      // Our offset *within the scrolled content*, so the result holds no matter
      // how far the user has scrolled when this runs.
      const offset = scroller
        ? node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
        : node.getBoundingClientRect().top + window.scrollY;
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

  // Effective width for a column: user-set override → column default → auto.
  const widthOf = (c: ColumnDef<T>): number | undefined => prefs.widths[c.key] ?? c.width;

  // Drag the right edge of a header to resize that column (persisted per user).
  const startResize = (e: React.MouseEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
    const startW = th.getBoundingClientRect().width;
    const startX = e.clientX;
    const move = (me: MouseEvent) => prefs.setWidth(key, startW + (me.clientX - startX));
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
    <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      {(title || subtitle || toolbar || (selectionOn && selectedRows.length > 0)) && (
        <div className="flex flex-wrap items-center justify-between gap-2.5 border-b px-[18px] py-4">
          <div>
            {title && <h3 className="font-display text-[15px] font-semibold">{title}</h3>}
            {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
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
                    className="grid h-8 w-8 place-items-center rounded-md border border-[#e0b4ae] bg-[#fdf3f1] text-[#9e2b21] hover:bg-[#f9e7e3] disabled:opacity-50"
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
            <ColumnsButton onClick={() => setPanelOpen(true)} customized={prefs.customized} />
          </div>
        </div>
      )}

      {/* Scrolls on both axes. Capping the height is what makes the header stick
          and keeps the horizontal scrollbar on screen; uncapped, the element
          just grows and neither engages. */}
      <div ref={scrollRef} className="overflow-auto" style={viewportH ? { maxHeight: viewportH } : undefined}>
        <table className="w-full whitespace-nowrap text-[13px]">
          <thead className="sticky top-0 z-20">
            <tr className="border-b text-left text-[11px] uppercase tracking-[.06em] text-muted-foreground">
              {showCheckbox && (
                <th className={`w-10 px-4 py-[11px] ${stickyHeadCls}`}>
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label="Select all rows"
                    className="h-4 w-4 cursor-pointer accent-[#266929] align-middle"
                  />
                </th>
              )}
              {cols.map((c) => {
                const w = widthOf(c);
                return (
                  <th
                    key={c.key}
                    style={w ? { width: w, minWidth: w, maxWidth: w } : undefined}
                    className={`group/th relative px-4 py-[11px] font-semibold ${stickyHeadCls} ${c.headerClassName ?? ''}`}
                  >
                    <span className={w ? 'block truncate' : undefined}>{c.header}</span>
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
            {loading && (
              <tr><td colSpan={bodyColSpan} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={bodyColSpan} className="px-4 py-8 text-center text-muted-foreground">{emptyText}</td></tr>
            )}
            {!loading && rows.map((row, i) => {
              const key = getRowKey(row);
              const isSel = selected.has(key);
              // In 'row' selection mode a row click toggles selection; otherwise
              // it falls back to the caller's onRowClick (if any).
              const rowMode = selectionOn && selectionMode === 'row';
              const handleRowClick = rowMode ? () => toggleRow(key) : onRowClick ? () => onRowClick(row) : undefined;
              return (
              <tr
                key={key}
                onClick={handleRowClick}
                aria-selected={rowMode ? isSel : undefined}
                className={`group border-b last:border-0 hover:bg-muted/50 ${isSel ? 'bg-primary/5' : ''} ${handleRowClick ? 'cursor-pointer' : ''} ${rowClassName}`}
              >
                {showCheckbox && (
                  <td className="w-10 px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isSel}
                      onChange={() => toggleRow(key)}
                      aria-label="Select row"
                      className="h-4 w-4 cursor-pointer accent-[#266929] align-middle"
                    />
                  </td>
                )}
                {cols.map((c) => {
                  const w = widthOf(c);
                  return (
                    <td key={c.key} style={w ? { maxWidth: w } : undefined} className={`px-4 py-3 ${w ? 'overflow-hidden text-ellipsis' : ''} ${c.cellClassName ?? ''}`}>{c.render(row, i)}</td>
                  );
                })}
              </tr>
              );
            })}
          </tbody>
          {!loading && rows.length > 0 && cols.some((c) => c.footer) && (
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
    </div>
  );
}

/** Standalone "Columns" button (matches the app's filter-bar styling). */
export function ColumnsButton({ onClick, customized }: { onClick: () => void; customized?: boolean }) {
  return (
    <button
      onClick={onClick}
      title="Customize columns"
      className="inline-flex items-center gap-[7px] rounded-md border bg-card px-3 py-2 text-[13px] font-medium hover:bg-muted"
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
            <h3 className="font-display text-[15px] font-semibold">Customize Columns</h3>
            <p className="text-xs text-muted-foreground">Show/hide &amp; reorder · configure tracking &amp; search</p>
          </div>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {/* ── Visible columns: show/hide + drag to reorder ── */}
          <SectionLabel>Visible Columns</SectionLabel>
          {prefs.ordered.map((col) => {
            const hidden = prefs.isHidden(col.key);
            const isOver = overKey === col.key && dragKey !== col.key;
            return (
              <div
                key={col.key}
                draggable={!col.required}
                onDragStart={() => setDragKey(col.key)}
                onDragEnd={() => { setDragKey(null); setOverKey(null); }}
                onDragOver={(e) => { e.preventDefault(); setOverKey(col.key); }}
                onDrop={(e) => { e.preventDefault(); if (dragKey) prefs.reorder(dragKey, col.key); setDragKey(null); setOverKey(null); }}
                className={`mb-1.5 flex items-center gap-2.5 rounded-lg border px-3 py-2.5 transition-colors ${isOver ? 'border-primary bg-primary/5' : 'border-transparent bg-background'} ${dragKey === col.key ? 'opacity-50' : ''}`}
              >
                <GripVertical className={`h-4 w-4 shrink-0 ${col.required ? 'text-muted-foreground/30' : 'cursor-grab text-muted-foreground'}`} />
                <label className="flex flex-1 cursor-pointer items-center justify-between gap-2 text-[13px]">
                  <span className={hidden && !col.required ? 'text-muted-foreground' : 'font-medium'}>{col.header || '—'}</span>
                  <input
                    type="checkbox"
                    checked={col.required || !hidden}
                    disabled={col.required}
                    onChange={() => prefs.toggle(col.key)}
                    className="h-4 w-4 accent-[#266929] disabled:opacity-40"
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
            className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-2 text-[13px] font-medium hover:bg-muted disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset to default
          </button>
          <button onClick={onClose} className="rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90">Done</button>
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
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground/80">{hint}</div>}
    </div>
  );
}

/** A plain checkbox row (no drag handle) used by the Trackable / Searchable sections. */
function ConfigRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="mb-1.5 flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-transparent bg-background px-3 py-2.5 text-[13px] hover:border-border">
      <span className={checked ? 'font-medium' : 'text-muted-foreground'}>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-4 w-4 accent-[#266929]"
      />
    </label>
  );
}
