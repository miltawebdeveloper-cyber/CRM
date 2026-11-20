'use client';

import { Upload, X } from 'lucide-react';
import type { LeadListQuery } from '@/lib/leads';
import { useLeadExport } from '@/lib/use-lead-export';

const BTN =
  'inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[12.5px] font-semibold hover:bg-muted disabled:opacity-50';

/**
 * Export CSV / Export Excel for a lead list — the whole filtered list, however
 * long (see `use-lead-export`). While it runs, the button counts up and a
 * Cancel sits beside it, since a large book takes a while to read.
 */
export function LeadExportButtons({ query, fileBase, disabled }: { query: LeadListQuery; fileBase: string; disabled?: boolean }) {
  const { run, cancel, progress, exporting } = useLeadExport(query, fileBase);
  const label = progress && progress.total > 0
    ? `Preparing… ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`
    : 'Preparing…';

  return (
    <>
      <button onClick={() => run('csv')} disabled={disabled || exporting} className={BTN}>
        <Upload className="h-4 w-4" /> {exporting ? label : 'Export CSV'}
      </button>
      {exporting ? (
        <button onClick={cancel} title="Stop the export" className={BTN}>
          <X className="h-4 w-4" /> Cancel
        </button>
      ) : (
        <button onClick={() => run('xlsx')} disabled={disabled} className={BTN}>
          <Upload className="h-4 w-4" /> Export Excel
        </button>
      )}
    </>
  );
}
