'use client';

import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Upload, Check, AlertTriangle, Undo2, Filter, Loader2, Download, GitCompare, History } from 'lucide-react';
import * as XLSX from 'xlsx';
import { importApi, type LeadRow, type ImportCheckResult, type ImportMatchedLead } from '@/lib/crm';
import { leadsApi } from '@/lib/leads';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageHead } from '@/components/page-head';
import { downloadCsv } from '@/lib/export';
import { formatDate } from '@/lib/display-settings';
import { TIMEZONE_CODES } from '@/lib/timezone';

/**
 * Which fields the duplicate check compares on — mirrors the API's `checkFields`.
 *
 * Phone and Email only, and both compared exactly. Company name used to be a
 * third option here; a name is not a contact point, and matching on one is what
 * put franchise branches and two unrelated firms trading under the same word in
 * front of the user as "duplicates" to rule on.
 */
export interface CheckFieldsState {
  phone: boolean;
  email: boolean;
}

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

/**
 * Columns a merge can rule on: the ones the import writes AND the review can
 * show the CRM's side of.
 *
 * Lead ID and Created Date are identity, not content. "Assigned To" is left out
 * on purpose — ownership follows its own rules on import (a lead is never taken
 * off the employee holding it, and one assigned today is locked), so offering it
 * as a field to pick would promise a choice the import would then overrule.
 */
const MERGE_FIELDS = [
  'businessName', 'contactName', 'contactName2', 'phone', 'altPhone', 'email', 'website',
  'socialMedia', 'country', 'state', 'city', 'timezone', 'industry', 'companySize',
  'foundedYear', 'address', 'callStatus', 'lostReason', 'leadGenerationId', 'leadSource',
] as const;
const LABEL_BY_KEY = new Map(COLUMNS.map((c) => [c.key as string, c.label]));

/**
 * The fields where this row and the lead it would update actually disagree.
 *
 * Only differences are offered. A column the file leaves empty is never written
 * anyway, and one that already matches has no decision in it — listing either
 * would bury the handful of real conflicts in a wall of identical rows.
 */
function mergeDiff(row: LeadRow, existing: ImportMatchedLead) {
  const r = row as unknown as Record<string, unknown>;
  const e = existing as unknown as Record<string, unknown>;
  const out: { key: string; label: string; fileValue: string; crmValue: string }[] = [];
  for (const key of MERGE_FIELDS) {
    const fileValue = String(r[key] ?? '').trim();
    if (!fileValue) continue;
    const crmValue = String(e[key] ?? '').trim();
    if (crmValue.toLowerCase() === fileValue.toLowerCase()) continue;
    out.push({ key, label: LABEL_BY_KEY.get(key) ?? key, fileValue, crmValue });
  }
  return out;
}

/** The exact header row the mapper auto-detects, in the sheet's own order. */
const TEMPLATE_HEADERS = COLUMNS.map((c) => c.label);

/**
 * A worked row per shape worth showing: one fully populated, one with the
 * optional columns left blank, so both "fill everything in" and "I only have
 * a name and a number" are demonstrated. Values are written in the forms the
 * parser actually accepts — ISO dates, a zone CODE, an "Assigned To" in each
 * of the two spellings employees are matched by.
 *
 * Shared by "Load sample" and the downloadable template so the two can never
 * drift into disagreeing about what a valid file looks like.
 */
const TEMPLATE_EXAMPLE: string[][] = [
  ['L-99001', 'GEN-8802', '2026-07-01', 'Google Ads', 'Acme Tax LLC', 'John Carter', 'Finance Manager', '+13055551234', '+13055555678', 'john@acme.com', 'https://acmetax.com', '@acmetax', 'USA', 'Florida', 'Miami', 'EST', 'Accounting', '10-50', '2010', '123 Main St', 'Lisa - MAS21072', 'Contacted', '2026-06-01', '2026-07-01', '2026-07-15', '3', '2026-07-10', ''],
  ['L-99002', 'GEN-8803', '2026-07-02', 'Referral', 'Bay Books Inc', 'Mia Wong', 'Operations Head', '+14155559876', '', 'mia@baybooks.com', 'https://baybooks.com', '', 'USA', 'California', 'San Francisco', 'PST', 'Bookkeeping', '50-200', '1995', '456 Market St', 'caller2@crm.local', 'In Progress', '2026-06-05', '2026-07-02', '2026-07-20', '5', '2026-07-12', ''],
];

/** What the API does with each column, for the template's guide sheet. */
const TEMPLATE_NOTES: string[][] = [
  ['Company Name', 'Acme Tax LLC', 'Strongly recommended — a lead imported without one has nothing to show in the lists. Compared by the duplicate check on the trading name, so "Acme Tax LLC" and "The Acme Tax Co." count as the same company.'],
  ['Phone', '+1 305 555 1234', 'Any format — matched on the last 10 digits. A row whose number is already in the CRM UPDATES that lead rather than creating a second one.'],
  ['Alt Phone', '+1 305 555 5678', 'Also read by the duplicate check, against both phone columns on both sides.'],
  ['Email', 'john@acme.com', 'The duplicate check ignores +tags, and dots on Gmail addresses only.'],
  ['Time Zone', TIMEZONE_CODES.join(' / '), 'Must be one of these codes. Anything else is left BLANK rather than guessed — a lead with no zone is asked for one before a callback can be booked, which is safer than booking on the wrong clock.'],
  ['Assigned To', 'Lisa   ·   lisa@crm.local   ·   Lisa - MAS21072', "The employee's name or login email; a trailing \" - CODE\" is ignored. A name that matches nobody is reported row by row and the lead imports unassigned. An import never takes a lead off the employee already holding it."],
  ['Dates', '2026-07-15', 'Created Date, First Contact, Last Contact, Next Follow-up, Meeting Date. Use YYYY-MM-DD; a date that cannot be read is left blank rather than failing the row.'],
  ['Follow-up Count', '3', 'Whole number.'],
  ['Lead ID', 'L-99001', 'Leave blank and the CRM assigns the next one. A value matching an existing lead updates that lead.'],
  ['Status', '(not a column)', 'Not imported from a file — every lead this creates starts as New, and status is moved from the CRM.'],
];

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const SAMPLE = [TEMPLATE_HEADERS, ...TEMPLATE_EXAMPLE].map((r) => r.map(csvCell).join(',')).join('\n');

const TEMPLATE_FILENAME = 'ranger-crm-lead-import-template';

/**
 * The template as a workbook: a "Leads" sheet holding the header row alone, and
 * a "Field guide" sheet carrying the notes and the worked example.
 *
 * The example is deliberately NOT in the fillable sheet. An example row left in
 * a template is an example row that gets imported, and "Acme Tax LLC" landing in
 * the book is a worse outcome than a user having to look at the second tab. It
 * cannot reach the CRM from there either: the uploader reads a workbook's FIRST
 * sheet, so anything on the guide is inert.
 */
function downloadTemplateXlsx() {
  const wb = XLSX.utils.book_new();

  const leads = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS]);
  leads['!cols'] = TEMPLATE_HEADERS.map((h) => ({ wch: Math.max(14, h.length + 3) }));
  XLSX.utils.book_append_sheet(wb, leads, 'Leads');

  const guide = XLSX.utils.aoa_to_sheet([
    ['Ranger CRM — lead import template'],
    ['Fill in the "Leads" tab, one lead per row, then upload it on the Import screen.'],
    ['Every column is optional and the column ORDER does not matter — columns are matched by their heading, and anything unrecognised is reported before the import runs.'],
    [],
    ['Column', 'Example', 'How it is used'],
    ...TEMPLATE_NOTES,
    [],
    ['Worked example — the same headings as the Leads tab, filled in.'],
    TEMPLATE_HEADERS,
    ...TEMPLATE_EXAMPLE,
  ]);
  guide['!cols'] = [{ wch: 20 }, { wch: 34 }, { wch: 96 }];
  XLSX.utils.book_append_sheet(wb, guide, 'Field guide');

  XLSX.writeFile(wb, `${TEMPLATE_FILENAME}.xlsx`);
}

export default function ImportPage() {
  const qc = useQueryClient();
  const [file, setFile] = useState<ParsedFile>({ headers: [], cells: [] });
  const [mapping, setMapping] = useState<Mapping>({});
  const [raw, setRaw] = useState('');

  // Duplicate detection configuration fields
  const [dupCheckFields, setDupCheckFields] = useState<CheckFieldsState>({
    phone: true,
    email: true,
  });

  /**
   * Off by default. The exact rule is the rule; this loosens it for the files
   * that need it — a sheet whose numbers are written in a different style to the
   * CRM's, where an exact compare finds nothing and every row reads as new.
   */
  const [ignorePhoneFormatting, setIgnorePhoneFormatting] = useState(false);

  /**
   * Also off by default, and noisier than the contact-point rules: it groups two
   * DIFFERENT people at one firm, which is frequently two legitimate leads.
   * Useful when a file is one company's contact list; wrong for most books.
   */
  const [matchCompanyDomain, setMatchCompanyDomain] = useState(false);

  /**
   * Also off by default. Company name counts only WITH the city and the state —
   * all three or nothing — which is what keeps two branches of one franchise
   * apart while catching the same office re-listed under a new number.
   */
  const [matchLocation, setMatchLocation] = useState(false);

  const activeCheckFields = useMemo(() => {
    const fields: string[] = [];
    if (dupCheckFields.phone) fields.push('phone');
    if (dupCheckFields.email) fields.push('email');
    return fields;
  }, [dupCheckFields]);

  const matchOptions = useMemo(
    () => ({ checkFields: activeCheckFields, ignorePhoneFormatting, matchCompanyDomain, matchLocation }),
    [activeCheckFields, ignorePhoneFormatting, matchCompanyDomain, matchLocation],
  );

  // Per-row decisions for duplicate rows: row index -> 'import' | 'skip'
  const [dupDecisions, setDupDecisions] = useState<Record<number, 'import' | 'skip'>>({});

  /**
   * Per-row merge choices: row index → the fields the CRM should KEEP.
   *
   * Only the exceptions are stored. An import already overwrites every column
   * the file fills in, so an empty set is exactly today's behaviour and a field
   * appears here only because someone said "keep what the CRM has". Applied by
   * blanking that field in the row before it is sent, which is the same thing
   * the import already does with any column a file leaves empty — it skips it.
   */
  const [mergeKeep, setMergeKeep] = useState<Record<number, Set<string>>>({});
  const [mergeOpen, setMergeOpen] = useState<number | null>(null);

  const rows = useMemo(() => (file.headers.length ? buildRows(file, mapping) : []), [file, mapping]);

  /**
   * The rows as they will actually be sent, with every field the reviewer chose
   * to keep from the CRM blanked out.
   *
   * Blanking is the whole mechanism: the import writes a column only when the
   * row carries a value for it, so an empty field leaves whatever the lead
   * already had. That means a merge needs no second write path and cannot drift
   * from the import's own update rules — it IS the import's update rules, handed
   * a narrower row.
   */
  const rowsToSend = useMemo(() => {
    const touched = Object.entries(mergeKeep).filter(([, keep]) => keep.size > 0);
    if (touched.length === 0) return rows;
    const copy = rows.map((r) => ({ ...r }));
    for (const [idx, keep] of touched) {
      const row = copy[Number(idx)] as unknown as Record<string, unknown>;
      if (!row) continue;
      for (const field of keep) row[field] = undefined;
    }
    return copy;
  }, [rows, mergeKeep]);

  const importMut = useMutation({
    mutationFn: (params: { skipDuplicates?: boolean; skipRowIndexes?: number[] }) =>
      importApi.bulk(rowsToSend, params.skipDuplicates, params.skipRowIndexes, matchOptions),
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
    mutationFn: () => importApi.check(rows, matchOptions),
    onSuccess: (res) => {
      if (res.duplicateRecords > 0) {
        setDupResult(res);
        setMergeKeep({});
        setMergeOpen(null);
        // Skip is the default for a row nobody has ruled on. A row that WAS
        // ruled on before opens on that ruling instead — re-answering the same
        // question from scratch every time the file is re-run is the work this
        // is here to save. It is still only a default; changing it is what gets
        // remembered next.
        const initialDecisions: Record<number, 'import' | 'skip'> = {};
        for (const d of res.duplicateRows) {
          initialDecisions[d.index] = d.priorDecision?.decision === 'import' ? 'import' : 'skip';
        }
        setDupDecisions(initialDecisions);
      } else {
        // A clean file has nothing to review, so it must not leave a result behind:
        // holding one here put an empty "Detected 0 duplicate records" dialog over
        // the page on every clean import, which the user then had to dismiss to see
        // that the import had already succeeded underneath it.
        setDupResult(null);
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
    setMergeKeep({});
    setMergeOpen(null);
  }

  /** Flip one field of one row between "take the file's value" and "keep the CRM's". */
  const toggleMergeField = (index: number, field: string) =>
    setMergeKeep((prev) => {
      const keep = new Set(prev[index] ?? []);
      if (keep.has(field)) keep.delete(field);
      else keep.add(field);
      return { ...prev, [index]: keep };
    });

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

  /**
   * Unchecking the last remaining box is refused rather than obeyed. An empty
   * field list means "compare on everything" to the API, so turning both off
   * would quietly compare both — a screen reading "duplicate detection is off"
   * while it is fully on. The last checked box is disabled to say so up front.
   */
  const onlyOneFieldLeft = activeCheckFields.length === 1;
  const toggleCheckField = (field: keyof CheckFieldsState) => {
    setDupCheckFields((prev) => {
      const next = { ...prev, [field]: !prev[field] };
      return !next.phone && !next.email ? prev : next;
    });
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
      <PageHead>
        <button
          onClick={downloadTemplateXlsx}
          className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[13px] font-semibold hover:bg-muted"
        >
          <Download className="h-4 w-4" /> Template (Excel)
        </button>
        <button
          onClick={() => downloadCsv(TEMPLATE_FILENAME, TEMPLATE_HEADERS, [])}
          className="inline-flex items-center gap-2 rounded-md border bg-card px-[15px] py-[9px] text-[13px] font-semibold hover:bg-muted"
        >
          <Download className="h-4 w-4" /> Template (CSV)
        </button>
      </PageHead>

      <div className="grid gap-[18px] lg:grid-cols-2">
        <label className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-[#bbd3bc] bg-background p-[34px] text-center transition-colors hover:border-[#a6c74d]">
          <div className="mb-3 grid h-[52px] w-[52px] place-items-center rounded-[14px] bg-[#d8eed9] text-[#266929]"><Upload className="h-6 w-6" /></div>
          <div className="font-semibold">Drop your file here or <span className="text-primary">browse</span></div>
          <div className="mt-1 text-[12.5px] text-muted-foreground">CSV or Excel (.xlsx/.xls) up to 25MB</div>
          <div className="mt-1 text-[12px] text-muted-foreground">Don&apos;t have a file yet? Download the template above.</div>
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
            <span className="text-[12px] text-muted-foreground">A row is a duplicate on an exact match — never on a partial one</span>
          </div>
          <div className="flex flex-wrap items-center gap-6 pt-1 text-[13px]">
            {(
              [
                { field: 'phone' as const, label: 'Phone Number', hint: 'Compared as written, including Alt Phone' },
                { field: 'email' as const, label: 'Email Address', hint: 'Case-insensitive; +tags and Gmail dots ignored' },
              ]
            ).map(({ field, label, hint }) => {
              const locked = dupCheckFields[field] && onlyOneFieldLeft;
              return (
                <label
                  key={field}
                  title={locked ? 'At least one field has to be compared.' : hint}
                  className={`flex items-center gap-2 font-medium ${locked ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  <input
                    type="checkbox"
                    checked={dupCheckFields[field]}
                    disabled={locked}
                    onChange={() => toggleCheckField(field)}
                    className="h-4 w-4 rounded border-muted-foreground/30 accent-primary disabled:opacity-60"
                  />
                  <span>{label}</span>
                  <span className="text-[11.5px] font-normal text-muted-foreground">{hint}</span>
                </label>
              );
            })}
          </div>
          <label
            className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-dashed bg-muted/30 px-3 py-2.5 text-[12.5px]"
            title="Compare numbers by their last 10 digits instead of as written"
          >
            <input
              type="checkbox"
              checked={ignorePhoneFormatting}
              disabled={!dupCheckFields.phone}
              onChange={() => { setIgnorePhoneFormatting((v) => !v); setDupResult(null); }}
              className="mt-0.5 h-4 w-4 rounded border-muted-foreground/30 accent-primary disabled:opacity-50"
            />
            <span className={dupCheckFields.phone ? '' : 'opacity-50'}>
              <span className="font-medium">Also match numbers written differently</span>
              <span className="block text-[11.5px] leading-relaxed text-muted-foreground">
                Compares the last 10 digits, so <span className="font-mono">+1 (305) 555-1234</span> and{' '}
                <span className="font-mono">3055551234</span> count as one number. Looser than an exact match — worth
                turning on for a file whose numbers are written in a different style to the CRM&apos;s.
              </span>
            </span>
          </label>

          <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-lg border border-dashed bg-muted/30 px-3 py-2.5 text-[12.5px]">
            <input
              type="checkbox"
              checked={matchCompanyDomain}
              onChange={() => { setMatchCompanyDomain((v) => !v); setDupResult(null); }}
              className="mt-0.5 h-4 w-4 rounded border-muted-foreground/30 accent-primary"
            />
            <span>
              <span className="font-medium">Also match the company domain</span>
              <span className="block text-[11.5px] leading-relaxed text-muted-foreground">
                Taken from the email and the website, so <span className="font-mono">@acmetax.com</span> and{' '}
                <span className="font-mono">acmetax.com</span> are one firm. Noisier than the rules above — it flags two{' '}
                <b className="font-semibold">different people</b> at one company, which is often two real leads. Gmail
                and other mailbox providers are ignored.
              </span>
            </span>
          </label>

          <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-lg border border-dashed bg-muted/30 px-3 py-2.5 text-[12.5px]">
            <input
              type="checkbox"
              checked={matchLocation}
              onChange={() => { setMatchLocation((v) => !v); setDupResult(null); }}
              className="mt-0.5 h-4 w-4 rounded border-muted-foreground/30 accent-primary"
            />
            <span>
              <span className="font-medium">Also match company name with city and state</span>
              <span className="block text-[11.5px] leading-relaxed text-muted-foreground">
                All three together, so <span className="font-mono">Acme Tax · Miami · FL</span> already in the CRM
                flags a row for the same firm even when its number is new, while{' '}
                <span className="font-mono">Acme Tax · Austin · TX</span> stays a separate lead. Case, punctuation and{' '}
                <span className="font-mono">Florida</span> vs <span className="font-mono">FL</span> are ignored. Rows
                missing any of the three are not compared on location.
              </span>
            </span>
          </label>

          <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
            Company name is never compared on its own — two firms trading under the same word are two leads. Rows are
            checked against both the leads already in the CRM and the earlier rows of this file.
          </p>
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
                {/* What the file would do to the book, counting every row and not
                    just the flagged ones — a row nobody flagged can still land on
                    an existing lead, and that was nowhere on this screen. */}
                <p className="mt-1.5 text-[12px] text-[#8a5d0a]">
                  Importing all {dupResult.total} rows would update{' '}
                  <b className="tabular-nums">{dupResult.willUpdateRecords}</b> existing{' '}
                  {dupResult.willUpdateRecords === 1 ? 'lead' : 'leads'} and create{' '}
                  <b className="tabular-nums">{dupResult.willCreateRecords}</b> new{' '}
                  {dupResult.willCreateRecords === 1 ? 'one' : 'ones'}.
                </p>
                {dupResult.decidedBefore > 0 && (
                  <p className="mt-1 inline-flex items-center gap-1.5 text-[12px] font-medium text-[#8a5d0a]">
                    <History className="h-3.5 w-3.5" />
                    <b className="tabular-nums">{dupResult.decidedBefore}</b> of these were ruled on before — those rows
                    open on that answer.
                  </p>
                )}
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
                  const diff = d.willUpdate ? mergeDiff(rows[d.index], d.willUpdate) : [];
                  const kept = mergeKeep[d.index]?.size ?? 0;
                  return (
                  <Fragment key={d.index}>
                    <tr className={`transition-colors ${decision === 'import' ? 'bg-[#f4f9e8]/60' : 'bg-[#fbf3e2]/30'}`}>
                      <td className="py-3 pr-4">
                        <div className="font-semibold text-foreground">{d.row.businessName || '—'}</div>
                        <div className="font-mono text-[11.5px] text-muted-foreground">
                          {d.row.phone || '—'} {d.row.email ? `· ${d.row.email}` : ''}
                        </div>
                        {/* Why this row opened on the answer it did. */}
                        {d.priorDecision && (
                          <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
                            <History className="h-3 w-3" />
                            Last time: {d.priorDecision.decision === 'import' ? 'imported' : 'skipped'}
                            {d.priorDecision.decidedBy ? ` by ${d.priorDecision.decidedBy}` : ''} ·{' '}
                            {formatDate(d.priorDecision.decidedAt)}
                          </div>
                        )}
                      </td>
                      <td className="py-3 pr-4">
                        <span className="inline-flex rounded-full bg-[#f4e4c1] px-2.5 py-0.5 text-[11px] font-semibold text-[#8a5d0a]">
                          {d.matchedOn.join(', ')}
                        </span>
                      </td>
                      <td className="py-3 pr-4">
                        {d.existing.length > 0 ? (
                          <div className="space-y-2">
                            {d.existing.map((ex) => (
                              <div key={ex.leadId}>
                                <div className="flex flex-wrap items-center gap-1.5 font-semibold">
                                  <span className="font-mono text-[11.5px] text-primary">{ex.leadId}</span>
                                  <span>{ex.businessName || <span className="italic text-muted-foreground">Unnamed lead</span>}</span>
                                </div>
                                <div className="font-mono text-[11.5px] text-muted-foreground">
                                  {ex.phone || '—'}{ex.altPhone ? ` · ${ex.altPhone}` : ''}{ex.email ? ` · ${ex.email}` : ''}
                                </div>
                                <div className="text-[11.5px] text-muted-foreground">
                                  Assigned: {ex.assignedTo ?? 'Unassigned'}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="italic text-muted-foreground">Duplicate within file (earlier row)</span>
                        )}
                      </td>
                      <td className="py-3 text-right">
                        {/* Spelled out because "duplicate" and "creates a second
                            lead" are different questions. A row flagged on its
                            email whose phone matches nothing creates a NEW lead;
                            a row matching by phone is written into the one it
                            found. The user was deciding without either fact. */}
                        <div className="mb-1.5 text-[11.5px] text-muted-foreground">
                          {d.willUpdate ? (
                            <>Import updates <span className="font-mono text-primary">{d.willUpdate.leadId}</span></>
                          ) : (
                            <>Import creates a <b className="font-semibold text-[#8a5d0a]">new lead</b></>
                          )}
                        </div>
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

                        {/* The merge is only offered where it can act: a row that
                            will CREATE a lead has nothing to merge against. */}
                        {d.willUpdate && diff.length > 0 && (
                          <div className="mt-1.5">
                            <button
                              type="button"
                              onClick={() => setMergeOpen(mergeOpen === d.index ? null : d.index)}
                              className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1 text-[11.5px] font-semibold hover:bg-muted"
                            >
                              <GitCompare className="h-3.5 w-3.5" />
                              {mergeOpen === d.index ? 'Hide' : 'Compare'} {diff.length} difference{diff.length === 1 ? '' : 's'}
                              {kept > 0 && <span className="text-[#266929]">· {kept} kept</span>}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>

                    {mergeOpen === d.index && d.willUpdate && (
                      <tr>
                        <td colSpan={4} className="bg-muted/30 px-4 py-4">
                          <div className="mb-2 text-[12px] text-muted-foreground">
                            Importing this row writes into{' '}
                            <span className="font-mono text-primary">{d.willUpdate.leadId}</span>{' '}
                            <b className="text-foreground">{d.willUpdate.businessName}</b>. Every column below differs —
                            choose which side wins. Columns the file leaves empty are never written either way.
                          </div>
                          <table className="w-full border-collapse text-[12px]">
                            <thead>
                              <tr className="border-b text-left text-[10.5px] uppercase tracking-wider text-muted-foreground">
                                <th className="pb-1.5 pr-3 font-semibold">Field</th>
                                <th className="pb-1.5 pr-3 font-semibold">Currently in CRM</th>
                                <th className="pb-1.5 pr-3 font-semibold">In this file</th>
                                <th className="pb-1.5 text-right font-semibold">Keep</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y">
                              {diff.map((f) => {
                                const keepCrm = mergeKeep[d.index]?.has(f.key) ?? false;
                                return (
                                  <tr key={f.key}>
                                    <td className="py-1.5 pr-3 font-medium">{f.label}</td>
                                    <td className={`py-1.5 pr-3 ${keepCrm ? 'font-semibold text-[#266929]' : 'text-muted-foreground line-through'}`}>
                                      {f.crmValue || <span className="italic no-underline">empty</span>}
                                    </td>
                                    <td className={`py-1.5 pr-3 ${keepCrm ? 'text-muted-foreground line-through' : 'font-semibold text-[#266929]'}`}>
                                      {f.fileValue}
                                    </td>
                                    <td className="py-1.5 text-right">
                                      <div className="inline-flex rounded-md border bg-background p-0.5">
                                        <button
                                          type="button"
                                          onClick={() => keepCrm && toggleMergeField(d.index, f.key)}
                                          className={`rounded px-2 py-1 text-[11px] font-semibold ${!keepCrm ? 'bg-[#266929] text-white' : 'text-muted-foreground hover:text-foreground'}`}
                                        >
                                          File
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => !keepCrm && toggleMergeField(d.index, f.key)}
                                          className={`rounded px-2 py-1 text-[11px] font-semibold ${keepCrm ? 'bg-[#266929] text-white' : 'text-muted-foreground hover:text-foreground'}`}
                                        >
                                          CRM
                                        </button>
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
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

      {importMut.isError && (
        <div className="mt-4 rounded-md bg-[#fbeeec] px-4 py-3 text-sm text-[#a8431f]">
          Import failed — nothing was saved. {errorText(importMut.error)}
        </div>
      )}
    </div>
  );
}
