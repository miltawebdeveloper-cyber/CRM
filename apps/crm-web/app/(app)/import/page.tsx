'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Upload, Check, AlertTriangle, Undo2 } from 'lucide-react';
import * as XLSX from 'xlsx';
import { importApi, type LeadRow } from '@/lib/crm';
import { leadsApi } from '@/lib/leads';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ImportDuplicatesDialog } from '@/components/import-duplicates-dialog';
import { PageHead } from '@/components/page-head';

/** Server message if there is one, else the transport error. A 413 here means the
 *  sheet exceeded the API's request-body limit — worth naming, since the fix is a
 *  smaller batch rather than anything about the data itself. */
function errorText(err: unknown): string {
  const res = (err as { response?: { status?: number; data?: { message?: string | string[] } } })?.response;
  if (res?.status === 413) return 'The file is too large to send in one request. Split it into smaller batches and import again.';
  const msg = res?.data?.message;
  if (Array.isArray(msg)) return msg.join(', ');
  return msg ?? (err as Error)?.message ?? 'Unknown error.';
}

/**
 * Canonical lead column order (matches the upload sheet). Drives parsing,
 * the preview header, and the sample. `aliases` are matched case-insensitively
 * against the file header so minor naming differences still map.
 */
const COLUMNS: { key: keyof LeadRow; label: string; aliases: string[] }[] = [
  { key: 'leadId', label: 'Lead ID', aliases: ['lead id', 'leadid'] },
  { key: 'leadGenerationId', label: 'Lead Generation ID', aliases: ['lead generation id', 'leadgenerationid', 'lead gen id'] },
  { key: 'createdAt', label: 'Created Date', aliases: ['created date', 'createddate', 'created_at'] },
  { key: 'leadSource', label: 'Lead Source', aliases: ['lead source', 'leadsource'] },
  { key: 'businessName', label: 'Company Name', aliases: ['company name', 'company', 'business name', 'businessname', 'business'] },
  { key: 'contactName', label: 'Contact Person', aliases: ['contact person', 'contactname', 'contact person 1', 'primary contact'] },
  // Renamed from "Contact Person 2" — the old spellings stay as aliases so sheets
  // already in circulation keep importing into the same column.
  { key: 'contactName2', label: 'Designation', aliases: ['designation', 'contact person 2', 'contactname2', 'secondary contact'] },
  { key: 'phone', label: 'Phone', aliases: ['phone', 'phone number', 'mobile'] },
  { key: 'altPhone', label: 'Alt Phone', aliases: ['alt phone', 'altphone', 'alternate phone'] },
  { key: 'email', label: 'Email', aliases: ['email', 'e-mail'] },
  { key: 'website', label: 'Website', aliases: ['website', 'site', 'web'] },
  { key: 'socialMedia', label: 'Social Media', aliases: ['social media', 'socialmedia', 'social', 'linkedin'] },
  { key: 'country', label: 'Country', aliases: ['country'] },
  { key: 'state', label: 'State', aliases: ['state'] },
  { key: 'city', label: 'City', aliases: ['city'] },
  { key: 'timezone', label: 'Time Zone', aliases: ['time zone', 'timezone', 'tz'] },
  { key: 'industry', label: 'Industry', aliases: ['industry'] },
  { key: 'companySize', label: 'Company Size', aliases: ['company size', 'companysize'] },
  { key: 'foundedYear', label: 'Founded Year', aliases: ['founded year', 'foundedyear'] },
  { key: 'address', label: 'Address', aliases: ['address'] },
  { key: 'caller', label: 'Assigned To', aliases: ['assigned to', 'caller', 'agent'] },
  { key: 'callStatus', label: 'Call Status', aliases: ['call status', 'callstatus'] },
  { key: 'firstContact', label: 'First Contact', aliases: ['first contact', 'firstcontact'] },
  { key: 'lastContact', label: 'Last Contact', aliases: ['last contact', 'lastcontact'] },
  { key: 'nextFollowUpDate', label: 'Next Follow-up', aliases: ['next follow up', 'next followup', 'next follow-up date'] },
  { key: 'followupCount', label: 'Follow-up Count', aliases: ['follow-up count', 'followup count'] },
  { key: 'meetingDate', label: 'Meeting Date', aliases: ['meeting date', 'meetingdate'] },
  { key: 'lostReason', label: 'Lost Reason', aliases: ['lost reason', 'lostreason'] },
];

const STATUS_MAP: Record<string, string> = {
  new: 'new',
  'in progress': 'in_progress',
  in_progress: 'in_progress',
  contacted: 'contacted',
  interested: 'interested',
  closed: 'closed',
  'closed won': 'closed',
  rejected: 'rejected',
};
const TIMEZONES = ['EST', 'CST', 'MST', 'PST'];

/** Split one CSV line, respecting double-quoted fields (so commas inside
 * COMMENTS don't break the row). Doubled quotes ("") become a literal quote. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function normalize(key: keyof LeadRow, raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  if (key === 'timezone') { const u = v.toUpperCase(); return TIMEZONES.includes(u) ? u : undefined; }
  if (key === 'status') return STATUS_MAP[v.toLowerCase()] ?? undefined;
  return v;
}

// Header matching is by NAME, not position — columns can be in any order.
// Normalize away case, spaces, and separators so "COMPANY NAME", "company_name",
// "Company-Name" and "companyname" all map to the same column.
const normHeader = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The uploaded file, kept raw so the mapping can be changed without re-reading it. */
interface ParsedFile {
  /** Header labels exactly as they appear in the file. */
  headers: string[];
  /** Data rows, still as raw strings. */
  cells: string[][];
}

/** CRM field key → index into `headers`. NOT_MAPPED means "don't import this field". */
export const NOT_MAPPED = -1;
type Mapping = Record<string, number>;

function parseFile(text: string): ParsedFile {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { headers: [], cells: [] };
  return { headers: splitCsvLine(lines[0]), cells: lines.slice(1).map(splitCsvLine) };
}

/**
 * Best-guess mapping from the file's headers, matched by NAME (not position) so
 * any column order works. It's only a starting point — every field can be
 * re-pointed by hand afterwards, which is what makes an arbitrary sheet importable.
 */
function autoMap(headers: string[]): Mapping {
  const norm = headers.map(normHeader);
  const mapping: Mapping = {};
  for (const col of COLUMNS) {
    const aliases = col.aliases.map(normHeader);
    mapping[col.key] = norm.findIndex((h) => h !== '' && aliases.includes(h));
  }
  return mapping;
}

function buildRows(file: ParsedFile, mapping: Mapping): LeadRow[] {
  return file.cells.map((cells) => {
    const row: Record<string, string | undefined> = {};
    for (const col of COLUMNS) {
      const i = mapping[col.key] ?? NOT_MAPPED;
      row[col.key] = i >= 0 ? normalize(col.key, cells[i] ?? '') : undefined;
    }
    return {
      leadId: row.leadId,
      leadGenerationId: row.leadGenerationId,
      createdAt: row.createdAt,
      leadSource: row.leadSource,
      businessName: row.businessName ?? '',
      contactName: row.contactName,
      contactName2: row.contactName2,
      phone: row.phone ?? '',
      altPhone: row.altPhone,
      email: row.email,
      website: row.website,
      socialMedia: row.socialMedia,
      country: row.country,
      state: row.state ?? '',
      city: row.city ?? '',
      timezone: row.timezone,
      industry: row.industry,
      companySize: row.companySize,
      foundedYear: row.foundedYear,
      address: row.address,
      caller: row.caller,
      callStatus: row.callStatus,
      firstContact: row.firstContact,
      lastContact: row.lastContact,
      nextFollowUpDate: row.nextFollowUpDate,
      followupCount: row.followupCount ? parseInt(row.followupCount, 10) : undefined,
      meetingDate: row.meetingDate,
      lostReason: row.lostReason,
    };
  });
}

const SAMPLE = `${COLUMNS.map((c) => c.label).join(',')}
L-99001,GEN-8802,2026-07-01,Google Ads,Acme Tax LLC,John Carter,Finance Manager,+13055551234,+13055555678,john@acme.com,https://acmetax.com,@acmetax,USA,Florida,Miami,EST,Accounting,10-50,2010,"123 Main St",Lisa - MAS21072,Contacted,2026-06-01,2026-07-01,2026-07-15,3,2026-07-10,
L-99002,GEN-8803,2026-07-02,Referral,Bay Books Inc,Mia Wong,Operations Head,+14155559876,,mia@baybooks.com,https://baybooks.com,,USA,California,San Francisco,PST,Bookkeeping,50-200,1995,"456 Market St",caller2@crm.local,In Progress,2026-06-05,2026-07-02,2026-07-20,5,2026-07-12,`;

export default function ImportPage() {
  const qc = useQueryClient();
  const [file, setFile] = useState<ParsedFile>({ headers: [], cells: [] });
  const [mapping, setMapping] = useState<Mapping>({});
  const [raw, setRaw] = useState('');

  // Rows are derived from the mapping, so re-pointing a field updates the preview
  // (and what gets imported) immediately — no need to re-upload the file.
  const rows = useMemo(() => (file.headers.length ? buildRows(file, mapping) : []), [file, mapping]);
  const importMut = useMutation({ mutationFn: (skipDuplicates: boolean) => importApi.bulk(rows, skipDuplicates) });

  // Duplicate gate (requirement 15). Clicking Import first scans the rows against
  // the CRM (and against each other); only if duplicates are found do we stop to
  // ask. A clean file imports straight through with no extra click.
  const [dupResult, setDupResult] = useState<import('@/lib/crm').ImportCheckResult | null>(null);
  const check = useMutation({
    mutationFn: () => importApi.check(rows),
    onSuccess: (res) => {
      if (res.duplicateRecords > 0) setDupResult(res);
      else importMut.mutate(false); // nothing to warn about — import as-is
    },
  });
  const startImport = () => { importMut.reset(); check.mutate(); };
  const importing = check.isPending || importMut.isPending;

  // Import rollback: delete exactly the leads this import created, and refresh the
  // lead lists + dashboard counts so the removal shows everywhere at once.
  const [confirmRollback, setConfirmRollback] = useState(false);
  const rollback = useMutation({
    mutationFn: (ids: string[]) => leadsApi.bulkDelete(ids),
    meta: { successMessage: 'Imported leads removed' },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['metrics', 'summary'] });
    },
  });

  // File columns nobody is reading yet — surfaced so it's obvious what's going
  // unused, and which of them you might want to point a field at.
  const unmapped = useMemo(() => {
    const used = new Set(Object.values(mapping).filter((i) => i >= 0));
    return file.headers.filter((h, i) => h.trim() !== '' && !used.has(i));
  }, [file, mapping]);

  function load(text: string) {
    setRaw(text);
    const parsed = parseFile(text);
    setFile(parsed);
    setMapping(autoMap(parsed.headers));
    importMut.reset();
    rollback.reset();
    setConfirmRollback(false);
    setDupResult(null);
  }

  const setField = (key: string, idx: number) => setMapping((m) => ({ ...m, [key]: idx }));

  // Accept CSV or Excel (.xlsx/.xls) — Excel sheets are converted to CSV and
  // run through the same quote-aware parser + column-alias mapping.
  function loadFile(file: File) {
    const isExcel = /\.(xlsx|xls)$/i.test(file.name);
    if (!isExcel) { file.text().then(load); return; }
    file.arrayBuffer().then((buf) => {
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      load(XLSX.utils.sheet_to_csv(sheet));
    });
  }

  return (
    <div>

      <div className="grid gap-[18px] lg:grid-cols-2">
        <label className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-[#bbd3bc] bg-background p-[34px] text-center transition-colors hover:border-[#a6c74d]">
          <div className="mb-3 grid h-[52px] w-[52px] place-items-center rounded-[14px] bg-[#d8eed9] text-[#266929]"><Upload className="h-6 w-6" /></div>
          <div className="font-semibold">Drop your file here or <span className="text-primary">browse</span></div>
          <div className="mt-1 text-[12.5px] text-muted-foreground">CSV or Excel (.xlsx/.xls) up to 25MB</div>
          <input type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); }} />
        </label>
        <div className="rounded-2xl border bg-card p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[13px] font-semibold">Or paste CSV</span>
            <button onClick={() => load(SAMPLE)} className="text-[12px] font-semibold text-primary">Load sample</button>
          </div>
          <textarea value={raw} onChange={(e) => load(e.target.value)} rows={6} placeholder="Paste rows with the standard lead columns…" className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs" />
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            Columns: {COLUMNS.map((c) => c.label).join(' · ')}
          </p>
        </div>
      </div>

      {file.headers.length > 0 && (
        <div className="mt-[18px] rounded-2xl border bg-card p-[18px] shadow-sm">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-display text-[15px] font-semibold">Column mapping</h3>
            <button
              onClick={() => setMapping(autoMap(file.headers))}
              className="rounded-md border bg-card px-2.5 py-1.5 text-[12px] font-semibold hover:bg-muted"
            >
              Reset to auto-detected
            </button>
          </div>
          {/* Every field is optional: nothing here is marked Required, and leaving
              a field (including any date) unmapped simply skips it on import. */}
          <p className="mb-3 text-[12px] text-muted-foreground">
            Matched by column name, so your file&apos;s column order doesn&apos;t matter. Change any
            row to point a CRM field at a different column. All fields are optional — leave anything
            you don&apos;t have set to <span className="font-medium">Don&apos;t import</span>.
          </p>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {COLUMNS.map((col) => {
              const idx = mapping[col.key] ?? NOT_MAPPED;
              return (
                <label key={col.key} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-[12.5px]">
                  <span className="shrink-0 font-medium">{col.label}</span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    {idx >= 0 && <Check className="h-3.5 w-3.5 shrink-0 text-[#317d34]" />}
                    <select
                      value={idx}
                      onChange={(e) => setField(col.key, Number(e.target.value))}
                      aria-label={`Source column for ${col.label}`}
                      className={`min-w-0 max-w-[170px] cursor-pointer truncate rounded border bg-background px-1.5 py-1 text-[12px] outline-none ${idx < 0 ? 'text-muted-foreground/70' : ''}`}
                    >
                      <option value={NOT_MAPPED}>Don&apos;t import</option>
                      {file.headers.map((h, i) => (
                        <option key={`${h}-${i}`} value={i}>{h.trim() || `Column ${i + 1}`}</option>
                      ))}
                    </select>
                  </span>
                </label>
              );
            })}
          </div>

          {unmapped.length > 0 && (
            <div className="mt-3 flex items-start gap-2 rounded-md bg-[#fbf3e2] px-3 py-2 text-[12.5px] text-[#8a6a12]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Not imported — no CRM field is pointed at {unmapped.length > 1 ? 'these columns' : 'this column'}:{' '}
                {unmapped.join(', ')}. Pick {unmapped.length > 1 ? 'them' : 'it'} above if you want {unmapped.length > 1 ? 'them' : 'it'} imported.
              </span>
            </div>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-[18px] overflow-hidden rounded-2xl border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b px-[18px] py-4">
            <div><h3 className="font-display text-[15px] font-semibold">Preview</h3><div className="text-xs text-muted-foreground">{rows.length} rows · first 10 shown</div></div>
            <button onClick={startImport} disabled={importing} className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[13px] font-semibold text-primary-foreground disabled:opacity-60">
              <Check className="h-4 w-4" /> {check.isPending ? 'Checking…' : importMut.isPending ? 'Importing…' : `Import ${rows.length}`}
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-[13px]">
              <thead><tr className="border-b bg-background text-left text-[11px] uppercase tracking-[.06em] text-muted-foreground">{COLUMNS.map((c) => <th key={c.key} className="px-4 py-2.5 font-semibold">{c.label}</th>)}</tr></thead>
              <tbody>
                {rows.slice(0, 10).map((r, i) => {
                  // Highlight rows the last scan flagged as duplicates.
                  const dup = dupResult?.duplicateRows.some((d) => d.index === i);
                  return (
                  <tr key={i} className={`border-b last:border-0 ${dup ? 'bg-[#fbf3e2]/50' : ''}`}>
                    {COLUMNS.map((c) => <td key={c.key} className="px-4 py-2 text-muted-foreground">{(r as unknown as Record<string, string | undefined>)[c.key] ?? '—'}</td>)}
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {importMut.isSuccess && (
        <div className="mt-4 rounded-md bg-[#e4f2e4] px-4 py-3 text-sm text-[#317d34]">
          {/* Requirement 15 summary: Total / New / Duplicate / Imported / Skipped. */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium">
            <span>Total: <b className="tabular-nums">{importMut.data.totalRows}</b></span>
            <span>New: <b className="tabular-nums">{importMut.data.newRecords}</b></span>
            <span>Duplicates: <b className="tabular-nums">{importMut.data.duplicateRecords}</b></span>
            <span>Imported: <b className="tabular-nums">{importMut.data.imported + importMut.data.updated}</b> (created {importMut.data.imported} · updated {importMut.data.updated})</span>
            <span>Skipped: <b className="tabular-nums">{importMut.data.skipped}</b></span>
          </div>
          {/* Assignment is reported separately from the row counts: a sheet can
              import every row cleanly and still fail to hand the leads to anyone,
              which would otherwise look like a completely successful import. */}
          <div className="mt-1 text-xs">
            Assigned successfully: <b>{importMut.data.assignedSuccessfully}</b>
            {importMut.data.assignmentFailed > 0 && (
              <> · <span className="font-semibold text-[#a8431f]">Assignment failed: {importMut.data.assignmentFailed}</span></>
            )}
          </div>
          {importMut.data.errors.length > 0 && <ul className="mt-1 list-inside list-disc text-xs">{importMut.data.errors.slice(0, 5).map((e) => <li key={e.row}>Row {e.row}: {e.reason}</li>)}</ul>}

          {/* Undo Import — removes ONLY the leads this import created (never the
              pre-existing ones it merely updated), so a wrong file can be pulled
              back in one click. Gone once the batch is rolled back. */}
          {importMut.data.createdIds.length > 0 && !rollback.isSuccess && (
            <div className="mt-2 border-t border-[#bfe0c0] pt-2">
              <button
                onClick={() => setConfirmRollback(true)}
                disabled={rollback.isPending}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#e0b4ae] bg-card px-3 py-1.5 text-[12.5px] font-semibold text-[#9e2b21] hover:bg-[#fdf3f1] disabled:opacity-60"
              >
                <Undo2 className="h-3.5 w-3.5" /> Undo import ({importMut.data.createdIds.length} added)
              </button>
            </div>
          )}
          {rollback.isSuccess && (
            <div className="mt-2 border-t border-[#bfe0c0] pt-2 text-xs text-[#a8431f]">
              Removed {rollback.data.deleted} imported lead(s). Existing leads were left unchanged.
            </div>
          )}
        </div>
      )}

      {confirmRollback && importMut.data && (
        <ConfirmDialog
          title="Cancel Imported Leads"
          message="Are you sure you want to remove all leads imported in this batch? This action cannot be undone."
          confirmLabel="Remove Imported Leads"
          onConfirm={async () => { await rollback.mutateAsync(importMut.data!.createdIds); }}
          onClose={() => setConfirmRollback(false)}
        />
      )}

      {dupResult && (
        <ImportDuplicatesDialog
          result={dupResult}
          busy={importMut.isPending}
          onSkip={() => { setDupResult(null); importMut.mutate(true); }}
          onImportAnyway={() => { setDupResult(null); importMut.mutate(false); }}
          onCancel={() => setDupResult(null)}
        />
      )}

      {/* A failed import only raised a toast before, which is easy to miss and gone
          by the time you look — so the whole upload appeared to do nothing. Show it
          in place, next to the Import button that triggered it. */}
      {importMut.isError && (
        <div className="mt-4 rounded-md bg-[#fbeeec] px-4 py-3 text-sm text-[#a8431f]">
          Import failed — nothing was saved. {errorText(importMut.error)}
        </div>
      )}
    </div>
  );
}
