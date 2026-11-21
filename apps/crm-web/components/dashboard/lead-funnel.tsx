'use client';

import Link from 'next/link';

export interface FunnelStage {
  key: string;
  label: string;
  value: number;
  /** The list behind this stage, where one shows exactly what it counts. */
  href?: string;
}

/** A step as a percentage of the one before it, to one decimal; null with nothing to measure against. */
export function stepShare(value: number, previous: number | null): number | null {
  if (previous === null || previous <= 0) return null;
  return Math.round((value / previous) * 1000) / 10;
}

/**
 * Where leads stall: each stage of the book on one bar, and the share of the
 * stage before it that made it through.
 *
 * A meter list rather than a drawn funnel — one row per stage, its name, a bar
 * against the first stage, and its figure — so every number is readable as
 * text (the list is its own table view) and the bars share one baseline, which
 * compares stages more exactly than a funnel's tapering shapes do. One hue on
 * a lighter track of the same ramp; a stage at zero draws only the track.
 *
 * Every stage after the first is a subset of the one before (contacted leads
 * are assigned leads, converted ones were contacted, onboarding ones were
 * converted), so the bars only ever shrink and "% of previous" never tops 100.
 */
export function LeadFunnel({ stages, dimmed = false }: { stages: FunnelStage[]; dimmed?: boolean }) {
  const base = stages[0]?.value ?? 0;
  return (
    <div className={`mt-3 rounded-xl border bg-card px-4 py-3 shadow-sm transition-opacity ${dimmed ? 'opacity-60' : ''}`}>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[12.5px] font-semibold">Lead funnel</h3>
        <span className="text-[11px] text-muted-foreground">Bars against {stages[0]?.label.toLowerCase() ?? 'the first stage'}; % of the step before</span>
      </div>
      <ol>
        {stages.map((stage, i) => {
          const previous = i > 0 ? stages[i - 1] : null;
          const step = stepShare(stage.value, previous ? previous.value : null);
          const width = base > 0 ? Math.min(100, (stage.value / base) * 100) : 0;
          const row = (
            <>
              <span className="truncate text-[12.5px] font-medium">{stage.label}</span>
              {/* Below sm the bar drops under the name so it keeps its length. */}
              <span className="col-span-3 row-start-2 h-2 overflow-hidden rounded-full bg-[var(--brand-surface)] sm:col-span-1 sm:row-start-auto" aria-hidden>
                <span
                  className="block h-full rounded-full bg-[var(--brand)]"
                  style={{ width: `${width}%`, minWidth: stage.value > 0 ? 3 : 0 }}
                />
              </span>
              <span className="text-right text-[12.5px] font-semibold tabular-nums">{stage.value.toLocaleString()}</span>
              <span className="text-right text-[11px] tabular-nums text-muted-foreground">
                {step !== null && previous ? `${step}% of ${previous.label.toLowerCase()}` : ''}
              </span>
            </>
          );
          const grid =
            'grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 sm:grid-cols-[110px_1fr_64px_128px]';
          return (
            <li key={stage.key}>
              {stage.href ? (
                <Link href={stage.href} className={`${grid} transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50`}>
                  {row}
                </Link>
              ) : (
                <div className={grid}>{row}</div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
