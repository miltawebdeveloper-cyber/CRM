'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Upload, Check, AlertTriangle, Undo2, Filter, Loader2, RefreshCw } from 'lucide-react';
import * as XLSX from 'xlsx';
import { importApi, type LeadRow, type ImportCheckResult } from '@/lib/crm';
import { leadsApi } from '@/lib/leads';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ImportDuplicatesDialog, type CheckFieldsState } from '@/components/import-duplicates-dialog';
import { PageHead } from '@/components/page-head';
import { TIMEZONE_CODES } from '@/lib/timezone';

/** Server message if there is one, else the transport error. */
function errorText(err: unknown): string {
  const res = (err as { response?: { status?: number; data?: { message?: string | string[] } } })?.response;
  if (res?.status === 413) return 'The file is too large to send in one request. Split it into smaller batches and import again.';
  const msg = res?.data?.message;
  if (Array.isArray(msg)) return msg.join(', ');
  return msg ?? (err as Error)?.message ?? 'Unknown error.';
}

/**
 * Canonical lead column order (matches the upload sheet).
 */
const COLUMNS: { key: keyof LeadRow; label: string; aliases: string[] }[] = [
  { key: 'leadId', label: 'Lead ID', aliases: ['lead id', 'leadid'] },
  { key: 'leadGenerationId', label: 'Lead Generation ID', aliases: ['lead generation id', 'leadgenerationid', 'lead gen id'] },
  { key: 'createdAt', label: 'Created Date', aliases: ['created date', 'createddate', 'created_at'] },
  { key: 'leadSource', label: 'Lead Source', aliases: ['lead source', 'leadsource'] },
  { key: 'businessName', label: 'Company Name', aliases: ['company name', 'company', 'business name', 'businessname', 'business'] },
  { key: 'contactName', label: 'Contact Person', aliases: ['contact person', 'contactname', 'contact person 1', 'primary contact'] },
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
/**
 * Zone codes an import may carry, read off the shared list so a spreadsheet
 * column saying `HST` is accepted the moment Hawaii becomes a supported zone —
 * rather than being silently dropped by a copy of the list that was never
 * updated. Anything unrecognised still normalises to undefined, leaving the lead
 * honestly zone-less instead of guessing Eastern for it.
 */
const TIMEZONES: readonly string[] = TIMEZONE_CODES;

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

const normHeader = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

interface ParsedFile {
  headers: string[];
  cells: string[][];
}

export const NOT_MAPPED = -1;
type Mapping = Record<string, number>;

function parseFile(text: string): ParsedFile {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { headers: [], cells: [] };
  return { headers: splitCsvLine(lines[0]), cells: lines.slice(1).map(splitCsvLine) };
}

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

  // Duplicate detection configuration fields
  const [dupCheckFields, setDupCheckFields] = useState<CheckFieldsState>({
    businessName: true,
    phone: true,
    email: true,
  });

  const activeCheckFields = useMemo(() => {
    const fields: string[] = [];
    if (dupCheckFields.businessName) fields.push('businessName');
    if (dupCheckFields.phone) fields.push('phone');
    if (dupCheckFields.email) fields.push('email');
    return fields;
  }, [dupCheckFields]);

  // Per-row decisions for duplicate rows: row index -> 'import' | 'skip'
  const [dupDecisions, setDupDecisions] = useState<Record<number, 'import' | 'skip'>>({});

  const rows = useMemo(() => (file.headers.length ? buildRows(file, mapping) : []), [file, mapping]);

  const importMut = useMutation({
    mutationFn: (params: { skipDuplicates?: boolean; skipRowIndexes?: number[] }) =>
      importApi.bulk(rows, params.skipDuplicates, params.skipRowIndexes, activeCheckFields),
    // An import's "Assigned To" column hands leads straight to employees, so it
    // moves the same things a manual assignment does. Nothing was refreshed here
    // at all, which left every lead list and the Calling Panel showing the book as
    // it was before the file landed.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['metrics', 'summary'] });
      qc.invalidateQueries({ queryKey: ['assignments-summary'] });
      qc.invalidateQueries({ queryKey: ['caller-leads'] });
      qc.invalidateQueries({ queryKey: ['caller-dash'] });
    },
  });

  const [dupResult, setDupResult] = useState<ImportCheckResult | null>(null);

  const check = useMutation({
    mutationFn: () => importApi.check(rows, activeCheckFields),
    onSuccess: (res) => {
      setDupResult(res);
      if (res.duplicateRecords > 0) {
        // Initialize all duplicate rows to 'skip' decision by default
        const initialDecisions: Record<number, 'import' | 'skip'> = {};
        for (const d of res.duplicateRows) {
          initialDecisions[d.index] = 'skip';
        }
        setDupDecisions(initialDecisions);
      } else {
        // No duplicates found - proceed directly to import all
        importMut.mutate({ skipDuplicates: false });
      }
    },
  });

  const startImport = () => {
    importMut.reset();
    check.mutate();
  };
  const importing = check.isPending || importMut.isPending;

  const [confirmRollback, setConfirmRollback] = useState(false);
  const rollback = useMutation({
    mutationFn: (ids: string[]) => leadsApi.bulkDelete(ids),
    meta: { successMessage: 'Imported leads removed' },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['metrics', 'summary'] });
    },
  });

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
    setDupDecisions({});
  }

  const setField = (key: string, idx: number) => setMapping((m) => ({ ...m, [key]: idx }));

  function loadFile(file: File) {
    const isExcel = /\.(xlsx|xls)$/i.test(file.name);
    if (!isExcel) { file.text().then(load); return; }
    file.arrayBuffer().then((buf) => {
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      load(XLSX.utils.sheet_to_csv(sheet));
    });
  }

  const toggleCheckField = (field: keyof CheckFieldsState) => {
    setDupCheckFields((prev) => ({ ...prev, [field]: !prev[field] }));
    setDupResult(null);
  };

  const toggleDupDecision = (index: number, action: 'import' | 'skip') => {
    setDupDecisions((prev) => ({ ...prev, [index]: action }));
  };

  // Bulk Actions
  const handleImportAllDuplicates = () => {
    if (!dupResult) return;
    const decisions: Record<number, 'import' | 'skip'> = {};
    for (const d of dupResult.duplicateRows) {
      decisions[d.index] = 'import';
    }
    setDupDecisions(decisions);
    setDupResult(null);
    importMut.mutate({ skipDuplicates: false });
  };

  const handleSkipAllDuplicates = () => {
    if (!dupResult) return;
    const decisions: Record<number, 'import' | 'skip'> = {};
    for (const d of dupResult.duplicateRows) {
      decisions[d.index] = 'skip';
    }
    setDupDecisions(decisions);
    setDupResult(null);
    importMut.mutate({ skipDuplicates: true });
  };

  const handleCustomImport = (skipRowIndexes: number[]) => {
    setDupResult(null);
    importMut.mutate({ skipDuplicates: false, skipRowIndexes });
  };

  const handleApplyCurrentDecisions = () => {
    if (!dupResult) return;
    const skipIndexes = dupResult.duplicateRows
      .filter((d) => (dupDecisions[d.index] ?? 'skip') === 'skip')
      .map((d) => d.index);
    handleCustomImport(skipIndexes);
  };

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

      {/* Duplicate Validation Settings */}
      {file.headers.length > 0 && (
        <div className="mt-[18px] rounded-2xl border bg-card p-[18px] shadow-sm">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b pb-3">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-primary" />
              <h3 className="font-display text-[15px] font-semibold">Duplicate Validation Settings</h3>
            </div>
            <span className="text-[12px] text-muted-foreground">Configure validation fields for duplicate detection</span>
          </div>
          <div className="flex flex-wrap items-center gap-6 pt-1 text-[13px]">
            <label className="flex cursor-pointer items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={dupCheckFields.businessName}
                onChange={() => toggleCheckField('businessName')}
                className="h-4 w-4 rounded border-muted-foreground/30 accent-primary"
              />
              <span>Company / Business Name</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={dupCheckFields.phone}
                onChange={() => toggleCheckField('phone')}
                className="h-4 w-4 rounded border-muted-foreground/30 accent-primary"
              />
              <span>Phone Number</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={dupCheckFields.email}
                onChange={() => toggleCheckField('email')}
                className="h-4 w-4 rounded border-muted-foreground/30 accent-primary"
              />
              <span>Email Address</span>
            </label>
          </div>
        </div>
      )}

      {/* Column Mapping Section */}
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

      {/* File Preview */}
      {rows.length > 0 && (
        <div className="mt-[18px] overflow-hidden rounded-2xl border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b px-[18px] py-4">
            <div><h3 className="font-display text-[15px] font-semibold">Preview</h3><div className="text-xs text-muted-foreground">{rows.length} rows · first 10 shown</div></div>
            <button onClick={startImport} disabled={importing} className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[13px] font-semibold text-primary-foreground disabled:opacity-60">
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {check.isPending ? 'Checking Duplicates…' : importMut.isPending ? 'Importing…' : `Import ${rows.length} Leads`}
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-[13px]">
              <thead><tr className="border-b bg-background text-left text-[11px] uppercase tracking-[.06em] text-muted-foreground">{COLUMNS.map((c) => <th key={c.key} className="px-4 py-2.5 font-semibold">{c.label}</th>)}</tr></thead>
              <tbody>
                {rows.slice(0, 10).map((r, i) => {
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

      {/* DEDICATED DUPLICATE RECORDS REVIEW SECTION AT THE BOTTOM OF THE SCREEN */}
      {dupResult && dupResult.duplicateRows.length > 0 && (
        <div className="mt-[24px] overflow-hidden rounded-2xl border border-[#e8c68a] bg-card shadow-md">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e8c68a] bg-[#fbf3e2]/60 px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#f5dfb8] text-[#8a5d0a]">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-display text-[16px] font-semibold text-[#664304]">Duplicate Records Review & Comparison</h3>
                <p className="text-[12.5px] text-[#8a5d0a]">
                  Review detected duplicates below. Compare imported file records with existing CRM leads, and choose bulk or individual actions before completing import.
                </p>
              </div>
            </div>

            {/* Bulk Action Controls in Dedicated Section */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleImportAllDuplicates}
                disabled={importing}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#a6c74d] bg-[#f4f9e8] px-3.5 py-2 text-[12.5px] font-semibold text-[#266929] shadow-2xs hover:bg-[#e6f2d2] disabled:opacity-50"
              >
                <Check className="h-4 w-4" /> Import All Duplicates
              </button>
              <button
                type="button"
                onClick={handleSkipAllDuplicates}
                disabled={importing}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#e0b4ae] bg-[#fdf3f1] px-3.5 py-2 text-[12.5px] font-semibold text-[#9e2b21] shadow-2xs hover:bg-[#fae4e1] disabled:opacity-50"
              >
                Skip All Duplicates
              </button>
            </div>
          </div>

          {/* Comparison Grid */}
          <div className="overflow-x-auto p-6">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="pb-2.5 pr-4 font-semibold">Imported Record (File Row)</th>
                  <th className="pb-2.5 pr-4 font-semibold">Matched On</th>
                  <th className="pb-2.5 pr-4 font-semibold">Existing CRM Lead</th>
                  <th className="pb-2.5 text-right font-semibold">Row Action Decision</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {dupResult.duplicateRows.map((d) => {
                  const decision = dupDecisions[d.index] ?? 'skip';
                  return (
                    <tr key={d.index} className={`transition-colors ${decision === 'import' ? 'bg-[#f4f9e8]/60' : 'bg-[#fbf3e2]/30'}`}>
                      <td className="py-3 pr-4">
                        <div className="font-semibold text-foreground">{d.row.businessName || '—'}</div>
                        <div className="font-mono text-[11.5px] text-muted-foreground">
                          {d.row.phone || '—'} {d.row.email ? `· ${d.row.email}` : ''}
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        <span className="inline-flex rounded-full bg-[#f4e4c1] px-2.5 py-0.5 text-[11px] font-semibold text-[#8a5d0a]">
                          {d.matchedOn.join(', ')}
                        </span>
                      </td>
                      <td className="py-3 pr-4">
                        {d.existing ? (
                          <div>
                            <div className="flex items-center gap-1.5 font-semibold">
                              <span className="font-mono text-[11.5px] text-primary">{d.existing.leadId}</span>
                              <span>{d.existing.businessName}</span>
                            </div>
                            <div className="text-[11.5px] text-muted-foreground">
                              {d.existing.phone} {d.existing.email ? `· ${d.existing.email}` : ''} · Assigned: {d.existing.assignedTo ?? 'Unassigned'}
                            </div>
                          </div>
                        ) : (
                          <span className="italic text-muted-foreground">Duplicate within file (earlier row)</span>
                        )}
                      </td>
                      <td className="py-3 text-right">
                        <div className="inline-flex rounded-lg border bg-background p-0.5 shadow-2xs">
                          <button
                            type="button"
                            onClick={() => toggleDupDecision(d.index, 'import')}
                            className={`rounded-md px-3 py-1.5 text-[12px] font-semibold transition-all ${
                              decision === 'import'
                                ? 'bg-[#266929] text-white shadow-2xs'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            Import
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleDupDecision(d.index, 'skip')}
                            className={`rounded-md px-3 py-1.5 text-[12px] font-semibold transition-all ${
                              decision === 'skip'
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

          {/* Footer Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/40 px-6 py-4">
            <div className="text-xs text-muted-foreground">
              Selected decisions: <b className="text-foreground">{dupResult.duplicateRows.filter((d) => dupDecisions[d.index] === 'import').length}</b> to import, <b className="text-foreground">{dupResult.duplicateRows.filter((d) => (dupDecisions[d.index] ?? 'skip') === 'skip').length}</b> to skip.
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleApplyCurrentDecisions}
                disabled={importing}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-[13px] font-semibold text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-60"
              >
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Complete Import Based on Review Choices
              </button>
            </div>
          </div>
        </div>
      )}

      {importMut.isSuccess && (
        <div className="mt-4 rounded-md bg-[#e4f2e4] px-4 py-3 text-sm text-[#317d34]">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium">
            <span>Total: <b className="tabular-nums">{importMut.data.totalRows}</b></span>
            <span>New: <b className="tabular-nums">{importMut.data.newRecords}</b></span>
            <span>Duplicates: <b className="tabular-nums">{importMut.data.duplicateRecords}</b></span>
            <span>Imported: <b className="tabular-nums">{importMut.data.imported + importMut.data.updated}</b> (created {importMut.data.imported} · updated {importMut.data.updated})</span>
            <span>Skipped: <b className="tabular-nums">{importMut.data.skipped}</b></span>
          </div>
          <div className="mt-1 text-xs">
            Assigned successfully: <b>{importMut.data.assignedSuccessfully}</b>
            {importMut.data.assignmentFailed > 0 && (
              <> · <span className="font-semibold text-[#a8431f]">Assignment failed: {importMut.data.assignmentFailed}</span></>
            )}
          </div>
          {importMut.data.errors.length > 0 && <ul className="mt-1 list-inside list-disc text-xs">{importMut.data.errors.slice(0, 5).map((e) => <li key={e.row}>Row {e.row}: {e.reason}</li>)}</ul>}

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
          busy={importing}
          decisions={dupDecisions}
          onToggleDecision={toggleDupDecision}
          onImportAll={handleImportAllDuplicates}
          onSkipAll={handleSkipAllDuplicates}
          onCustomImport={handleCustomImport}
          onCancel={() => setDupResult(null)}
          checkFields={dupCheckFields}
          onToggleCheckField={toggleCheckField}
        />
      )}

      {importMut.isError && (
        <div className="mt-4 rounded-md bg-[#fbeeec] px-4 py-3 text-sm text-[#a8431f]">
          Import failed — nothing was saved. {errorText(importMut.error)}
        </div>
      )}
    </div>
  );
}
