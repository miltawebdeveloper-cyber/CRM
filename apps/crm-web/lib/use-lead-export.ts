'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { leadsApi, type Lead, type LeadListQuery, type LeadPage } from './leads';
import { EXPORT_HEADERS, exportRows } from './lead-export';
import { downloadCsv, downloadXlsx } from './export';
import { pushToast } from './toast';

/**
 * Exporting a lead list of any size.
 *
 * Exports used to stop at 5,000 rows — one request at the API's bulk ceiling —
 * and say how many were left out. Now the filtered list is read in 5,000-row
 * chunks until all of it is in hand, then written as one file.
 *
 * In the browser rather than as a server job on purpose: the file's columns
 * are defined in `lead-export` (each heading beside the value that fills it,
 * dates on the lead's clock, outcome labels), and building it on the server
 * would mean a second copy of that to keep in step, plus somewhere to hold a
 * large file until it is fetched. The cost is that leaving the page cancels the
 * export — which it says.
 */

/** The API's per-request ceiling for a bulk read (`limit`). */
export const EXPORT_CHUNK = 5_000;

/** An Excel sheet holds 1,048,576 rows, one of them the header. */
export const XLSX_MAX_ROWS = 1_048_575;

type FetchPage = (query: LeadListQuery, signal?: AbortSignal) => Promise<LeadPage>;

/**
 * Every lead the query matches, chunk by chunk.
 *
 * The list's own ordering is total (it always ends in import order), so chunks
 * line up; a lead added while this runs makes the total grow and is picked up,
 * and one that changes position mid-run can't appear twice — rows are kept
 * once by id.
 */
export async function fetchAllLeads(
  query: LeadListQuery,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
  fetchPage: FetchPage = leadsApi.page,
): Promise<Lead[]> {
  const seen = new Set<string>();
  const rows: Lead[] = [];
  let total = Number.POSITIVE_INFINITY;
  for (let page = 1; rows.length < total; page++) {
    const res = await fetchPage({ ...query, page, pageSize: undefined, limit: EXPORT_CHUNK }, signal);
    total = res.total;
    for (const r of res.rows) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        rows.push(r);
      }
    }
    onProgress?.(rows.length, total);
    // A short chunk is the end, whatever the total said a moment ago — the
    // book shrank while this ran.
    if (res.rows.length < EXPORT_CHUNK) break;
  }
  return rows;
}

export function useLeadExport(query: LeadListQuery, fileBase: string) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Leaving the page abandons the export rather than finishing it unseen.
  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(
    async (kind: 'csv' | 'xlsx') => {
      if (abortRef.current) return;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setProgress({ done: 0, total: 0 });
      try {
        const leads = await fetchAllLeads(query, (done, total) => setProgress({ done, total }), ctrl.signal);
        if (ctrl.signal.aborted) return;
        if (kind === 'xlsx' && leads.length > XLSX_MAX_ROWS) {
          pushToast('error', `Excel holds at most ${XLSX_MAX_ROWS.toLocaleString()} rows and this list has ${leads.length.toLocaleString()}. Export CSV instead, or narrow the filters.`);
          return;
        }
        const data = exportRows(leads);
        if (kind === 'csv') downloadCsv(fileBase, EXPORT_HEADERS, data);
        else await downloadXlsx(fileBase, EXPORT_HEADERS, data);
        pushToast('success', `Exported ${leads.length.toLocaleString()} lead${leads.length === 1 ? '' : 's'}.`);
      } catch {
        if (ctrl.signal.aborted) pushToast('info', 'Export cancelled.');
        else pushToast('error', 'Export failed part-way. Try again, or narrow the filters.');
      } finally {
        abortRef.current = null;
        setProgress(null);
      }
    },
    [query, fileBase],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  return { run, cancel, progress, exporting: progress !== null };
}
