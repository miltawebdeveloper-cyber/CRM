'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Upload, Check, AlertTriangle } from 'lucide-react';
import * as XLSX from 'xlsx';
import { importApi, type LeadRow } from '@/lib/crm';
import { PageHead } from '@/components/page-head';

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
  { key: 'contactName2', label: 'Contact Person 2', aliases: ['contact person 2', 'contactname2', 'secondary contact'] },
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

interface ParseResult {
  rows: LeadRow[];
  /** Per canonical column: the file header it matched (or null = not in file). */
  matched: { label: string; header: string | null }[];
  /** File headers that didn't map to any known column (ignored on import). */
  unrecognized: string[];
}

function parseCsv(text: string): ParseResult {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], matched: [], unrecognized: [] };
  const original = splitCsvLine(lines[0]);
  const headers = original.map(normHeader);
  const colIdx = COLUMNS.map((col) => {
    const aliases = col.aliases.map(normHeader);
    return headers.findIndex((h) => h !== '' && aliases.includes(h));
  });

  const matched = COLUMNS.map((col, ci) => ({ label: col.label, header: colIdx[ci] >= 0 ? original[colIdx[ci]] : null }));
  const usedIdx = new Set(colIdx.filter((i) => i >= 0));
  const unrecognized = original.filter((h, i) => h.trim() !== '' && !usedIdx.has(i));

  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, string | undefined> = {};
    COLUMNS.forEach((col, ci) => {
      const i = colIdx[ci];
      row[col.key] = i >= 0 ? normalize(col.key, cells[i] ?? '') : undefined;
    });
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
  return { rows, matched, unrecognized };
}

const SAMPLE = `${COLUMNS.map((c) => c.label).join(',')}
L-99001,GEN-8802,2026-07-01,Google Ads,Acme Tax LLC,John Carter,Jane Doe,+13055551234,+13055555678,john@acme.com,https://acmetax.com,@acmetax,USA,Florida,Miami,EST,Accounting,10-50,2010,"123 Main St",caller1@crm.local,Contacted,2026-06-01,2026-07-01,2026-07-15,3,2026-07-10,
L-99002,GEN-8803,2026-07-02,Referral,Bay Books Inc,Mia Wong,Alex Smith,+14155559876,,mia@baybooks.com,https://baybooks.com,,USA,California,San Francisco,PST,Bookkeeping,50-200,1995,"456 Market St",caller2@crm.local,In Progress,2026-06-05,2026-07-02,2026-07-20,5,2026-07-12,`;

export default function ImportPage() {
  const [rows, setRows] = useState<LeadRow[]>([]);
  const [matched, setMatched] = useState<{ label: string; header: string | null }[]>([]);
  const [unrecognized, setUnrecognized] = useState<string[]>([]);
  const [raw, setRaw] = useState('');
  const importMut = useMutation({ mutationFn: () => importApi.bulk(rows) });

  function load(text: string) {
    setRaw(text);
    const res = parseCsv(text);
    setRows(res.rows);
    setMatched(res.matched);
    setUnrecognized(res.unrecognized);
    importMut.reset();
  }

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

      {rows.length > 0 && (
        <div className="mt-[18px] rounded-2xl border bg-card p-[18px] shadow-sm">
          <h3 className="mb-3 font-display text-[15px] font-semibold">Detected column mapping</h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {matched.map((m) => (
              <div key={m.label} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-[12.5px]">
                <span className="font-medium">{m.label}</span>
                {m.header ? (
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Check className="h-3.5 w-3.5 text-[#317d34]" />{m.header}</span>
                ) : (
                  <span className="text-muted-foreground/60">not in file</span>
                )}
              </div>
            ))}
          </div>
          {unrecognized.length > 0 && (
            <div className="mt-3 flex items-start gap-2 rounded-md bg-[#fbf3e2] px-3 py-2 text-[12.5px] text-[#8a6a12]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Ignored unrecognized column{unrecognized.length > 1 ? 's' : ''}: {unrecognized.join(', ')}</span>
            </div>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-[18px] overflow-hidden rounded-2xl border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b px-[18px] py-4">
            <div><h3 className="font-display text-[15px] font-semibold">Preview</h3><div className="text-xs text-muted-foreground">{rows.length} rows · first 10 shown</div></div>
            <button onClick={() => importMut.mutate()} disabled={importMut.isPending} className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[13px] font-semibold text-primary-foreground disabled:opacity-60">
              <Check className="h-4 w-4" /> {importMut.isPending ? 'Importing…' : `Import ${rows.length}`}
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-[13px]">
              <thead><tr className="border-b bg-background text-left text-[11px] uppercase tracking-[.06em] text-muted-foreground">{COLUMNS.map((c) => <th key={c.key} className="px-4 py-2.5 font-semibold">{c.label}</th>)}</tr></thead>
              <tbody>
                {rows.slice(0, 10).map((r, i) => (
                  <tr key={i} className="border-b last:border-0">
                    {COLUMNS.map((c) => <td key={c.key} className="px-4 py-2 text-muted-foreground">{(r as unknown as Record<string, string | undefined>)[c.key] ?? '—'}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {importMut.isSuccess && (
        <div className="mt-4 rounded-md bg-[#e4f2e4] px-4 py-3 text-sm text-[#317d34]">
          Created {importMut.data.imported} · updated {importMut.data.updated} (existing) · {importMut.data.errors.length} errors
          {importMut.data.errors.length > 0 && <ul className="mt-1 list-inside list-disc text-xs">{importMut.data.errors.slice(0, 5).map((e) => <li key={e.row}>Row {e.row}: {e.reason}</li>)}</ul>}
        </div>
      )}
    </div>
  );
}
