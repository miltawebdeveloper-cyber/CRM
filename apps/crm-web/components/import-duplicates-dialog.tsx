'use client';

import { AlertTriangle, Check, Loader2, X, Filter } from 'lucide-react';
import type { ImportCheckResult } from '@/lib/crm';

export interface CheckFieldsState {
  businessName: boolean;
  phone: boolean;
  email: boolean;
}

export function ImportDuplicatesDialog({
  result,
  busy,
  onImportAll,
  onSkipAll,
  onCustomImport,
  onCancel,
  decisions,
  onToggleDecision,
  checkFields,
  onToggleCheckField,
}: {
  result: ImportCheckResult;
  busy: boolean;
  onImportAll: () => void;
  onSkipAll: () => void;
  onCustomImport: (skipRowIndexes: number[]) => void;
  onCancel: () => void;
  decisions: Record<number, 'import' | 'skip'>;
  onToggleDecision: (index: number, action: 'import' | 'skip') => void;
  checkFields?: CheckFieldsState;
  onToggleCheckField?: (field: keyof CheckFieldsState) => void;
}) {
  const skipCount = Object.values(decisions).filter((d) => d === 'skip').length;
  const importCount = result.duplicateRows.length - skipCount;

  const handleApplyCustom = () => {
    const skipIndexes = result.duplicateRows
      .filter((d) => decisions[d.index] === 'skip')
      .map((d) => d.index);
    onCustomImport(skipIndexes);
  };

  return (
    <>
      <div onClick={() => !busy && onCancel()} className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-xs" />
      <div className="fixed inset-0 z-[61] grid place-items-center p-4" role="dialog" aria-modal="true" aria-label="Duplicate Lead Management">
        <div onClick={(e) => e.stopPropagation()} className="flex max-h-[90vh] w-full max-w-[920px] flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl">
          {/* Header */}
          <div className="flex items-start justify-between border-b px-6 py-4">
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#fbf3e2] text-[#8a5d0a]">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-display text-[16px] font-semibold">Duplicate Lead Resolution</h3>
                <p className="mt-0.5 text-[13px] text-muted-foreground">
                  Detected {result.duplicateRecords} duplicate records in your import file. Review and choose bulk or individual actions.
                </p>
              </div>
            </div>
            <button
              onClick={onCancel}
              disabled={busy}
              className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Validation Fields Settings */}
          {checkFields && onToggleCheckField && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/20 px-6 py-2.5 text-[12.5px]">
              <div className="flex items-center gap-1.5 font-medium text-muted-foreground">
                <Filter className="h-3.5 w-3.5 text-primary" />
                <span>Duplicate Validation Fields:</span>
              </div>
              <div className="flex items-center gap-4 font-medium">
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={checkFields.businessName}
                    onChange={() => onToggleCheckField('businessName')}
                    className="h-3.5 w-3.5 rounded border-muted-foreground/30 accent-primary"
                  />
                  <span>Company Name</span>
                </label>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={checkFields.phone}
                    onChange={() => onToggleCheckField('phone')}
                    className="h-3.5 w-3.5 rounded border-muted-foreground/30 accent-primary"
                  />
                  <span>Phone</span>
                </label>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={checkFields.email}
                    onChange={() => onToggleCheckField('email')}
                    className="h-3.5 w-3.5 rounded border-muted-foreground/30 accent-primary"
                  />
                  <span>Email</span>
                </label>
              </div>
            </div>
          )}

          {/* Summary Cards & Bulk Actions */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/40 px-6 py-3">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <Stat label="Total File" value={result.total} />
              <Stat label="Unique New" value={result.newRecords} tone="good" />
              <Stat label="Duplicates" value={result.duplicateRecords} tone="warn" />
              <Stat label="Selected to Import" value={result.newRecords + importCount} tone="good" />
              <Stat label="Selected to Skip" value={skipCount} tone="neutral" />
            </div>

            {/* Bulk Action Buttons */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onImportAll}
                disabled={busy}
                className="rounded-lg border border-[#a6c74d] bg-[#f4f9e8] px-3 py-1.5 text-[12px] font-semibold text-[#266929] hover:bg-[#e6f2d2] disabled:opacity-50"
              >
                Import All Duplicates
              </button>
              <button
                type="button"
                onClick={onSkipAll}
                disabled={busy}
                className="rounded-lg border border-[#e0b4ae] bg-[#fdf3f1] px-3 py-1.5 text-[12px] font-semibold text-[#9e2b21] hover:bg-[#fae4e1] disabled:opacity-50"
              >
                Skip All Duplicates
              </button>
            </div>
          </div>

          {/* Comparison Table */}
          <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="border-b text-left text-[10.5px] uppercase tracking-wider text-muted-foreground">
                  <th className="pb-2 pr-3 font-semibold">Imported Record (File)</th>
                  <th className="pb-2 pr-3 font-semibold">Matched On</th>
                  <th className="pb-2 pr-3 font-semibold">Existing CRM Record</th>
                  <th className="pb-2 text-right font-semibold">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {result.duplicateRows.map((d) => {
                  const currentAction = decisions[d.index] ?? 'skip';
                  return (
                    <tr key={d.index} className={`transition-colors ${currentAction === 'import' ? 'bg-[#f4f9e8]/50' : 'bg-[#fbf3e2]/30'}`}>
                      {/* Imported Record Details */}
                      <td className="py-2.5 pr-3">
                        <div className="font-semibold text-foreground">{d.row.businessName || '—'}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">
                          {d.row.phone || '—'} {d.row.email ? `· ${d.row.email}` : ''}
                        </div>
                      </td>

                      {/* Matched On Badge */}
                      <td className="py-2.5 pr-3">
                        <span className="inline-flex rounded-full bg-[#f4e4c1] px-2.5 py-0.5 text-[10.5px] font-semibold text-[#8a5d0a]">
                          {d.matchedOn.join(', ')}
                        </span>
                      </td>

                      {/* Existing CRM Record Details */}
                      <td className="py-2.5 pr-3">
                        {d.existing ? (
                          <div>
                            <div className="flex items-center gap-1.5 font-semibold">
                              <span className="font-mono text-[11px] text-primary">{d.existing.leadId}</span>
                              <span>{d.existing.businessName}</span>
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {d.existing.phone} {d.existing.email ? `· ${d.existing.email}` : ''} · Assigned: {d.existing.assignedTo ?? 'Unassigned'}
                            </div>
                          </div>
                        ) : (
                          <span className="italic text-muted-foreground">Duplicate within file (earlier row)</span>
                        )}
                      </td>

                      {/* Per-Record Toggle Action */}
                      <td className="py-2.5 text-right">
                        <div className="inline-flex rounded-lg border bg-background p-0.5 shadow-2xs">
                          <button
                            type="button"
                            onClick={() => onToggleDecision(d.index, 'import')}
                            className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-all ${
                              currentAction === 'import'
                                ? 'bg-[#266929] text-white shadow-2xs'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            Import
                          </button>
                          <button
                            type="button"
                            onClick={() => onToggleDecision(d.index, 'skip')}
                            className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-all ${
                              currentAction === 'skip'
                                ? 'bg-[#9e2b21] text-white shadow-2xs'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            Skip
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Dialog Footer Actions */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-card px-6 py-3.5">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded-lg border bg-background px-4 py-2 text-[13px] font-medium hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onImportAll}
                disabled={busy}
                className="rounded-lg border px-4 py-2 text-[13px] font-medium hover:bg-muted disabled:opacity-50"
              >
                Import All ({result.total})
              </button>
              <button
                type="button"
                onClick={onSkipAll}
                disabled={busy}
                className="rounded-lg border px-4 py-2 text-[13px] font-medium hover:bg-muted disabled:opacity-50"
              >
                Skip All ({result.newRecords} Unique Only)
              </button>
              <button
                type="button"
                onClick={handleApplyCustom}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Complete Import ({result.newRecords + importCount} Leads)
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'warn' | 'neutral' }) {
  const color = tone === 'good' ? 'text-[#317d34]' : tone === 'warn' ? 'text-[#a8431f]' : tone === 'neutral' ? 'text-foreground' : '';
  return (
    <div className="rounded-md border bg-background px-2.5 py-1 text-center">
      <span className={`text-[14px] font-semibold tabular-nums ${color}`}>{value}</span>
      <span className="ml-1 text-[10.5px] uppercase tracking-wider text-muted-foreground">{label}</span>
    </div>
  );
}
