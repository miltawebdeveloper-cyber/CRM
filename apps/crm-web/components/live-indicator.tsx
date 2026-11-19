'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/**
 * Pulsing "Live" pill + relative "updated Xs ago" that ticks every second.
 * `updatedAt` 0/undefined means nothing has loaded yet, said as such rather than
 * claiming the data is fresh ("just now") when there is no data.
 */
export function LiveIndicator({ updatedAt, fetching }: { updatedAt?: number; fetching?: boolean }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="relative flex h-2 w-2">
        <span
          className={cn(
            'absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75',
            fetching ? 'animate-ping' : 'animate-pulse',
          )}
        />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
      </span>
      <span className="font-medium text-green-600">Live</span>
      <span className="text-muted-foreground/60">·</span>
      <span>{updatedAt ? `updated ${ago(updatedAt)}` : 'waiting for data…'}</span>
    </div>
  );
}
