'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { CustomizeColumnsControl, useColumnPrefs, type ColumnDef } from '@/components/data-table';

export interface Column<T> {
  key: string;
  header: string;
  /** Optional custom cell renderer; defaults to String(row[key]). */
  cell?: (row: T) => React.ReactNode;
  /** Extra classes for alignment, e.g. 'text-right'. */
  className?: string;
}

interface WidgetCardProps<T> {
  title: string;
  columns: Column<T>[];
  rows: T[];
  /**
   * How many records there really are. A widget fetches only what it shows, so
   * `rows.length` is a count only when the feed isn't capped — pass the real
   * total where it is, or the footer reports "10" on a day with two hundred.
   */
  total?: number;
  /** Empty-state message. */
  emptyMessage?: string;
  /** The full list behind the widget — "View all" in the header and footer. */
  href?: string;
}

/** Rows a widget shows. It is a glance, not a list. */
const SHOWN = 10;

/**
 * A dashboard list: the first rows of something, and the way to the rest.
 *
 * It used to carry a "More" menu, a "Sort" button and page arrows that did
 * nothing — controls that looked live and weren't. They are gone; what a
 * widget offers now is the count and "View all", which opens the module the
 * list comes from.
 */
export function WidgetCard<T>({
  title,
  columns,
  rows,
  total,
  emptyMessage = 'No records found.',
  href,
}: WidgetCardProps<T>) {
  const count = Math.max(total ?? rows.length, rows.length);
  const shown = Math.min(rows.length, SHOWN);

  // Adapt the widget's lightweight Column type to the shared ColumnDef so the
  // same per-user Customize Columns control works here too.
  const colDefs = useMemo<ColumnDef<T>[]>(
    () =>
      columns.map((c, i) => ({
        key: c.key,
        header: c.header,
        required: i === 0,
        headerClassName: c.className,
        cellClassName: c.className,
        render: c.cell ? c.cell : (row: T) => String((row as Record<string, unknown>)[c.key] ?? ''),
      })),
    [columns],
  );
  const prefs = useColumnPrefs(`widget:${title}`, colDefs);
  const cols = prefs.visible;

  return (
    // `min-w-0` is what makes the scroll container below actually scroll. This
    // section is a grid item on the dashboard, and a grid item's default
    // `min-width: auto` is its MIN-CONTENT width — which, with every cell
    // `whitespace-nowrap`, is the table's full width. So a single long note or
    // business name stretched the tile, inflated its `1fr` track, and pushed the
    // whole dashboard sideways with the right-hand column cut off. Pinned to 0,
    // the track decides the width and the wide table scrolls inside the tile,
    // which is what the `overflow-x-auto` below was always for.
    <section className="flex min-w-0 flex-col rounded-lg border bg-card shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <h2 className="text-sm font-semibold">
          {title}
          <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground">{count.toLocaleString()}</span>
        </h2>
        <div className="flex items-center gap-2">
          <CustomizeColumnsControl prefs={prefs} />
          {href && (
            <Link href={href} className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="min-h-[220px] flex-1 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-y bg-muted/40 text-left text-xs font-medium text-muted-foreground">
              {cols.map((col) => (
                <th key={col.key} className={`whitespace-nowrap px-4 py-2 font-medium ${col.headerClassName ?? ''}`}>
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={cols.length}
                  className="px-4 py-12 text-center text-sm text-muted-foreground"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.slice(0, SHOWN).map((row, i) => (
                <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                  {cols.map((col) => (
                    <td
                      key={col.key}
                      className={`whitespace-nowrap px-4 py-2.5 ${col.cellClassName ?? ''}`}
                    >
                      {col.render(row, i)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Footer — how much of the list this is, and the way to the rest. */}
      <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
        <span>
          {count === 0 ? 'Nothing to show' : count > shown ? `Showing ${shown} of ${count.toLocaleString()}` : `Showing all ${count.toLocaleString()}`}
        </span>
        {href && count > shown && (
          <Link href={href} className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
            View all {count.toLocaleString()} <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
    </section>
  );
}
