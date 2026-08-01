'use client';

import { motion } from 'framer-motion';

export interface LeadProgressProps {
  /** Leads reached so far — the numerator. */
  contacted: number;
  /** Leads with an owner — the denominator the bar is a fraction of. */
  assigned: number;
  /**
   * The percentage the API already computed. Passed in rather than recomputed
   * here so the bar and the Progress figure elsewhere on the page are the same
   * claim; falls back to the local ratio only while the query is in flight.
   */
  pct?: number;
  /** Heading, e.g. "Progress" or "My Progress". */
  label?: string;
}

/**
 * How far through the assigned book the contacting has got.
 *
 * The bar is deliberately driven by contacted-over-assigned and nothing else —
 * not by the monthly target, which is a different question with its own card.
 * With nothing assigned there is no fraction to draw, so it renders empty at 0%
 * rather than full or NaN-wide.
 */
export function LeadProgress({ contacted, assigned, pct, label = 'Progress' }: LeadProgressProps) {
  const ratio = assigned > 0 ? (contacted / assigned) * 100 : 0;
  const value = pct ?? Number(ratio.toFixed(2));
  // The fill is clamped separately from the number: a stray value over 100 would
  // otherwise overflow the track, and a negative one would invert it.
  const width = Math.min(Math.max(value, 0), 100);
  const balance = Math.max(assigned - contacted, 0);

  return (
    <div className="rounded-xl border bg-card px-4 py-3 shadow-sm">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-[12px] font-semibold uppercase tracking-[.08em] text-muted-foreground">{label}</span>
        <span className="font-display text-[16px] font-semibold leading-none tracking-tight tabular-nums">
          {value}%
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-[#d8eed9]"
        role="progressbar"
        aria-valuenow={width}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label}: ${contacted} of ${assigned} assigned leads contacted`}
      >
        <motion.span
          className="block h-full rounded-full"
          style={{ background: 'linear-gradient(90deg,#2b732f,#7e9933)' }}
          initial={{ width: 0 }}
          animate={{ width: `${width}%` }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        />
      </div>
      <div className="mt-2 flex justify-between text-[12px] text-muted-foreground tabular-nums">
        <span>{contacted.toLocaleString()} contacted</span>
        <span>{balance.toLocaleString()} left</span>
      </div>
    </div>
  );
}
