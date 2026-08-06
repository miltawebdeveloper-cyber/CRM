// Client-side export helpers — CSV / Excel download + print-to-PDF.

import * as XLSX from 'xlsx';
import { formatDateTime } from '@/lib/display-settings';

/** Download rows as a real .xlsx workbook (opens natively in Excel). */
export function downloadXlsx(
  filename: string,
  headers: string[],
  rows: (string | number | null | undefined)[][],
  sheetName = 'Sheet1',
) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows.map((r) => r.map((c) => c ?? ''))]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Download an array of objects as a CSV file (opens cleanly in Excel). */
export function downloadCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const csv = [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Open a print window with a simple table so the user can "Save as PDF". */
export function printTable(title: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return;
  const esc = (s: unknown) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
  w.document.write(`<!DOCTYPE html><html><head><title>${esc(title)}</title><style>
    body{font-family:Inter,Arial,sans-serif;color:#14140f;padding:28px}
    h1{font-size:18px;margin:0 0 4px} .sub{color:#6f7268;font-size:12px;margin-bottom:18px}
    table{width:100%;border-collapse:collapse;font-size:12px}
    th{text-align:left;text-transform:uppercase;font-size:10px;letter-spacing:.06em;color:#6f7268;border-bottom:1px solid #e4e2db;padding:8px 10px}
    td{padding:8px 10px;border-bottom:1px solid #f1f2ee}
    tr:nth-child(even){background:#f7f7f4}
  </style></head><body>
    <h1>${esc(title)}</h1><div class="sub">Ranger CRM · ${formatDateTime(new Date())}</div>
    <table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>
  </body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 250);
}
