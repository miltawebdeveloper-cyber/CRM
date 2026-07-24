'use client';

import { motion } from 'framer-motion';
import { type LucideIcon } from 'lucide-react';

export interface KpiProps {
  icon: LucideIcon;
  iconBg: string;
  iconColor: string;
  value: React.ReactNode;
  label: string;
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
}

/**
 * The one summary card used by every module.
 *
 * The layout is deliberately fixed — icon on the left, value and label stacked to
 * its right — so a row of these reads as a single band whatever screen it's on,
 * and only the content differs between modules. This mirrors the Calls dashboard,
 * which is the reference design.
 */
export function KpiCard({ icon: Icon, iconBg, iconColor, value, label, index = 0 }: KpiProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: index * 0.03 }}
      className="flex items-center gap-2.5 overflow-hidden rounded-xl border bg-card px-3 py-2.5 shadow-sm transition-all hover:-translate-y-[1px] hover:shadow-md"
    >
      <div
        className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[8px]"
        style={{ background: iconBg, color: iconColor }}
      >
        <Icon className="h-[13px] w-[13px]" />
      </div>
      <div className="min-w-0">
        <div className="font-display text-[16px] font-semibold leading-none tracking-tight">{value}</div>
        {/* Long captions truncate rather than wrapping, which would make this tile
            taller than the others in the row; the full text stays on the tooltip. */}
        <div className="mt-[3px] truncate text-[10px] font-medium text-muted-foreground" title={label}>
          {label}
        </div>
      </div>
    </motion.div>
  );
}
