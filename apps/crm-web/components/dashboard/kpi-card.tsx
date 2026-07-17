'use client';

import { motion } from 'framer-motion';
import { TrendingUp, TrendingDown, type LucideIcon } from 'lucide-react';
import { Sparkline } from './sparkline';

export interface KpiProps {
  icon: LucideIcon;
  iconBg: string;
  iconColor: string;
  value: React.ReactNode;
  label: string;
  trend?: string;
  trendDir?: 'up' | 'down';
  spark?: number[];
  sparkColor?: string;
  index?: number;
  /**
   * Tighter card for rows carrying many stats at once, where the full-size
   * version wraps and leaves an orphan on its own line.
   */
  compact?: boolean;
}

export function KpiCard({ icon: Icon, iconBg, iconColor, value, label, trend, trendDir = 'up', spark, sparkColor, index = 0, compact = false }: KpiProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.04 }}
      className={`overflow-hidden rounded-2xl border bg-card shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md ${compact ? 'p-3.5' : 'p-[17px]'}`}
    >
      <div className={`flex items-center justify-between ${compact ? 'mb-2' : 'mb-3'}`}>
        <div className={`grid place-items-center rounded-[10px] ${compact ? 'h-[30px] w-[30px]' : 'h-[38px] w-[38px]'}`} style={{ background: iconBg, color: iconColor }}>
          <Icon className={compact ? 'h-[15px] w-[15px]' : 'h-[19px] w-[19px]'} />
        </div>
        {trend && (
          <div
            className={`flex items-center gap-0.5 rounded-full px-2 py-[3px] text-xs font-semibold ${
              trendDir === 'up' ? 'bg-[#e8f3e8] text-[#317d34]' : 'bg-[#fbeeec] text-[#9e2b21]'
            }`}
          >
            {trendDir === 'up' ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {trend}
          </div>
        )}
      </div>
      <div className={`font-display font-semibold leading-none tracking-tight ${compact ? 'text-[20px]' : 'text-[28px]'}`}>{value}</div>
      <div className={`font-medium text-muted-foreground ${compact ? 'mt-1 text-[11px]' : 'mt-1.5 text-[12.5px]'}`}>{label}</div>
      {spark && (
        <div className="mt-3 h-8">
          <Sparkline data={spark} color={sparkColor ?? iconColor} />
        </div>
      )}
    </motion.div>
  );
}
