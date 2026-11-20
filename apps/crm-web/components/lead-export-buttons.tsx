'use client';

import { FileDown, FileSpreadsheet, Loader2, X } from 'lucide-react';
import type { LeadListQuery } from '@/lib/leads';
import { useLeadExport } from '@/lib/use-lead-export';
import { IconAction } from '@/components/icon-action';

/**
 * Export CSV / Export Excel for a lead list — the whole filtered list, however
 * long (see `use-lead-export`).
 *
 * Compact icons like the rest of the page header (see IconAction), each with
 * its own icon: the two used to share one, which only worked while the text
 * beside them said which was which. A running export needs words, though, so
 * while one runs the icons give way to a small status with the count and a
 * cancel — a large book takes a while to read.
 */
export function LeadExportButtons({ query, fileBase, disabled }: { query: LeadListQuery; fileBase: string; disabled?: boolean }) {
  const { run, cancel, progress, exporting } = useLeadExport(query, fileBase);

  if (exporting) {
    const counted = progress && progress.total > 0
      ? `Preparing… ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`
      : 'Preparing…';
    return (
      <>
        <span role="status" aria-live="polite" className="inline-flex h-8 items-center gap-2 rounded-md border bg-card px-3 text-[12px] font-medium text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> {counted}
        </span>
        <IconAction icon={X} label="Cancel export" onClick={cancel} />
      </>
    );
  }

  return (
    <>
      <IconAction icon={FileDown} label="Export CSV" onClick={() => run('csv')} disabled={disabled} />
      <IconAction icon={FileSpreadsheet} label="Export Excel" onClick={() => run('xlsx')} disabled={disabled} />
    </>
  );
}
