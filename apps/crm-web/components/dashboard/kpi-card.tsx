'use client';

import Link from 'next/link';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { KpiDelta } from '@/lib/kpi-delta';

export interface KpiProps {
  icon: LucideIcon;
  iconBg: string;
  iconColor: string;
  value: React.ReactNode;
  label: string;
  /**
   * Was the stagger for an entry animation, which is gone: replayed on every
   * visit, it made each page's cards pop in a beat after the page itself.
   * Still accepted so the existing call sites keep compiling.
   */
  index?: number;
  /**
   * Still accepted so the existing call sites keep compiling, but no longer drawn.
   * The standard tile is one row — icon, figure, caption — and a trend pill or
   * sparkline would make some cards taller than their neighbours, which is the
   * inconsistency this card exists to remove. Extra detail belongs in `label`
   * instead, the way the Calls dashboard writes "Connected · 0%".
   */
  trend?: string;
  trendDir?: 'up' | 'down';
  spark?: number[];
  sparkColor?: string;
  /** No longer meaningful — the tile is compact by definition. */
  compact?: boolean;
  /**
   * Makes the card a link to the list behind its number — "Balance Leads"
   * opens the leads it counted. Only where such a list exists; a card without
   * one stays a plain tile rather than opening something that disagrees with it.
   */
  href?: string;
  /**
   * The ▲/▼ against the previous period (see lib/kpi-delta). Sits beside the
   * figure rather than under it, so a card with one stays the height of its
   * neighbours.
   */
  delta?: KpiDelta | null;
}

const DELTA_TONE: Record<KpiDelta['tone'], string> = {
  better: 'text-[var(--tone-teal-fg)]',
  worse: 'text-[var(--tone-red-fg-2)]',
  same: 'text-muted-foreground',
};
const ARROW: Record<KpiDelta['direction'], string> = { up: '▲', down: '▼', flat: '=' };

/**
 * The one summary card used by every module.
 *
 * The layout is deliberately fixed — icon on the left, value and label stacked to
 * its right — so a row of these reads as a single band whatever screen it's on,
 * and only the content differs between modules. This mirrors the Calls dashboard,
 * which is the reference design.
 */
export function KpiCard({ icon: Icon, iconBg, iconColor, value, label, href, delta }: KpiProps) {
  // Rendered as it is, with no entry animation — the figures are what someone
  // navigates to the page to read, so they arrive with it.
  const tile = 'group/kpi flex items-center gap-2.5 overflow-hidden rounded-xl border bg-card px-3 py-2.5 shadow-sm transition-all hover:-translate-y-[1px] hover:shadow-md';
  const body = (
    <>
      <div
        className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[8px]"
        style={{ background: iconBg, color: iconColor }}
      >
        <Icon className="h-[13px] w-[13px]" />
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5">
          <div className="font-display text-[18px] font-semibold leading-none tracking-tight">{value}</div>
          {delta && (
            <span title={delta.title} className={`whitespace-nowrap text-[10.5px] font-semibold leading-none ${DELTA_TONE[delta.tone]}`}>
              <span aria-hidden>{ARROW[delta.direction]} </span>
              {delta.text}
              <span className="sr-only">, {delta.title}</span>
            </span>
          )}
        </div>
        {/* Long captions truncate rather than wrapping, which would make this tile
            taller than the others in the row; the full text stays on the tooltip. */}
        <div className="mt-[3px] truncate text-[11px] font-medium text-muted-foreground" title={label}>
          {label}
        </div>
      </div>
      {/* A quiet "this opens something" cue, strongest on hover. */}
      {href && (
        <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground/40 transition-colors group-hover/kpi:text-muted-foreground" aria-hidden />
      )}
    </>
  );
  return href ? (
    <Link href={href} className={`${tile} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50`}>
      {body}
    </Link>
  ) : (
    <div className={tile}>{body}</div>
  );
}

/**
 * The row a page's KPI cards sit in — the one place its spacing is set.
 *
 * Every module wrote this container by hand, and they had drifted: the lead
 * pages had been tightened (12px gaps, 12px below) while the rest kept 16px
 * gaps and 20px below. One definition keeps them alike.
 *
 * `min` is the narrowest a card may get before the row wraps — each page keeps
 * the width it was designed with (180 or 190). The class strings are spelled
 * out rather than built, so Tailwind can see them.
 *
 * `bottom={false}` drops the margin underneath, for a row that sits inside a
 * section which spaces itself (the dashboard).
 */
export function KpiGrid({
  children,
  min = 190,
  bottom = true,
  className = '',
}: {
  children: ReactNode;
  min?: 180 | 190;
  bottom?: boolean;
  className?: string;
}) {
  const columns =
    min === 180
      ? '[grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]'
      : '[grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]';
  return <div className={`grid gap-3 ${bottom ? 'mb-3' : ''} ${columns} ${className}`}>{children}</div>;
}
