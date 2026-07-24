'use client';

import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ImportCheckResult } from '@/lib/crm';

/**
 * Shown before an import writes anything, when the pre-import scan finds rows that
 * duplicate an existing lead (by Company Name, Phone or Email) or repeat an earlier
 * row in the same file. Lets the user skip the duplicates, import them anyway, or
 * back out — the decision the CRM can't make for them.
 */
export function ImportDuplicatesDialog({
  result,
  busy,
  onSkip,
  onImportAnyway,
  onCancel,
}: {
  result: ImportCheckResult;
  busy: boolean;
  onSkip: () => void;
  onImportAnyway: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div onClick={() => !busy && onCancel()} className="fixed inset-0 z-[60] bg-black/40" />
      <div className="fixed inset-0 z-[61] grid place-items-center p-4" role="dialog" aria-modal="true" aria-label="Duplicate Lead Detected">
        <div onClick={(e) => e.stopPropagation()} className="flex max-h-[86vh] w-full max-w-[760px] flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl">
          <div className="flex items-start gap-3 border-b px-5 py-4">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#fbf3e2] text-[#8a5d0a]">
              <AlertTriangle className="h-[18px] w-[18px]" />
            </div>
            <div>
              <h3 className="font-display text-[15px] font-semibold">Duplicate Lead Detected</h3>
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                One or more leads already exist in the CRM based on Company Name, Phone Number, or Email Address. Do you want to
                continue importing these duplicate records?
              </p>
            </div>
          </div>

          {/* Summary counts */}
          <div className="grid grid-cols-3 gap-2 px-5 py-3 text-center">
            <Stat label="Total records" value={result.total} />
            <Stat label="New records" value={result.newRecords} tone="good" />
            <Stat label="Duplicates" value={result.duplicateRecords} tone="warn" />
          </div>

          {/* Duplicate preview grid */}
          <div className="min-h-0 flex-1 overflow-auto border-t px-5 py-3">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="text-left text-[10.5px] uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-semibold">Company Name</th>
                  <th className="py-2 pr-3 font-semibold">Phone</th>
                  <th className="py-2 pr-3 font-semibold">Email</th>
                  <th className="py-2 pr-3 font-semibold">Existing Lead ID</th>
                  <th className="py-2 pr-3 font-semibold">Assigned To</th>
                  <th className="py-2 pr-3 font-semibold">Created</th>
                  <th className="py-2 font-semibold">Matched On</th>
                </tr>
              </thead>
              <tbody>
                {result.duplicateRows.map((d) => (
                  <tr key={d.index} className="border-t bg-[#fbf3e2]/40">
                    <td className="py-1.5 pr-3">{d.row.businessName || '—'}</td>
                    <td className="py-1.5 pr-3 font-mono text-[11px]">{d.row.phone || '—'}</td>
                    <td className="py-1.5 pr-3">{d.row.email || '—'}</td>
                    {/* existing is null when the row only repeats an earlier row in the file. */}
                    <td className="py-1.5 pr-3 font-mono text-[11px]">{d.existing?.leadId ?? <span className="text-muted-foreground">in file</span>}</td>
                    <td className="py-1.5 pr-3">{d.existing?.assignedTo ?? '—'}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">
                      {d.existing ? new Date(d.existing.createdAt).toLocaleDateString() : '—'}
                    </td>
                    <td className="py-1.5">
                      <span className="rounded-full bg-[#f4e4c1] px-2 py-0.5 text-[10.5px] font-medium text-[#8a5d0a]">
                        {d.matchedOn.join(', ')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3">
            <button
              onClick={onCancel}
              disabled={busy}
              className="rounded-md border bg-card px-3.5 py-2 text-[13px] font-medium hover:bg-muted disabled:opacity-50"
            >
              Cancel Import
            </button>
            <button
              onClick={onImportAnyway}
              disabled={busy}
              className="rounded-md border px-3.5 py-2 text-[13px] font-medium hover:bg-muted disabled:opacity-50"
            >
              Import Anyway
            </button>
            <button
              onClick={onSkip}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Skip Duplicate Leads
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'warn' }) {
  const color = tone === 'good' ? 'text-[#317d34]' : tone === 'warn' ? 'text-[#a8431f]' : '';
  return (
    <div className="rounded-lg bg-muted/50 px-2 py-2">
      <div className={`text-[18px] font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}
