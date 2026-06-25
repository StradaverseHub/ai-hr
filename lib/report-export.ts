// ADR-0047 — multi-format report export. A neutral report shape is fed to three serializers; the
// route builds {columns, rows} once and dispatches by format. Pure functions, so each is unit-testable.
//
// Formats:
//   - CSV  — reuses lib/csv.ts#toCsv (byte-identical to the pre-ADR-0047 export).
//   - XLSX — a zero-dependency SpreadsheetML / HTML-table `.xls` workbook (application/vnd.ms-excel);
//            Excel / Numbers / LibreOffice open it natively. Chosen over the multi-MB `exceljs` to keep
//            the codebase's zero-dep posture (ADR-0047 §6). Unicode-safe (UTF-8).
//   - PDF  — reuses pdf-lib + the WinAnsi `safe()` guard from lib/payslip-pdf.ts. PDF is the
//            human-readable summary format and is LOSSY for non-Latin names (safe() → '?'); XLSX/CSV
//            are the lossless tabular exports (ADR-0047 §7).
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { toCsv } from './csv';

/** Neutral report shape. `comp`-derived columns must be built into BOTH `columns` and every row by the
 *  caller so lengths always match (XLSX/PDF tables are unforgiving of ragged rows). */
export type ReportData = {
  filename: string; // ascii-safe base (no extension)
  title: string;
  columns: string[];
  rows: (string | number | null)[][];
};

export type ReportFormat = 'csv' | 'xlsx' | 'pdf';
export type SerializedReport = { bytes: Uint8Array; contentType: string; ext: string };

const enc = new TextEncoder();
const cell = (v: string | number | null): string => (v == null ? '' : String(v));

/** RM-formatted comp columns are number-shaped strings; treat a cell as numeric if it parses cleanly. */
const isNumeric = (v: string | number | null): boolean =>
  v != null && v !== '' && typeof v !== 'object' && /^-?\d+(\.\d+)?$/.test(String(v));

// ── CSV ────────────────────────────────────────────────────────────────────
export function toCsvReport(d: ReportData): SerializedReport {
  const bytes = enc.encode(toCsv([d.columns, ...d.rows]));
  return { bytes, contentType: 'text/csv; charset=utf-8', ext: 'csv' };
}

// ── XLSX (zero-dep SpreadsheetML / HTML-table .xls) ──────────────────────────
const xmlEsc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function toXlsxReport(d: ReportData): SerializedReport {
  const head = d.columns
    .map((c) => `<th style="background:#eef;border:1px solid #ccc;font-weight:bold;text-align:left">${xmlEsc(c)}</th>`)
    .join('');
  const body =
    d.rows.length === 0
      ? '' // empty report → header-only sheet (still a valid, openable workbook)
      : d.rows
          .map(
            (r) =>
              '<tr>' +
              r
                .map((c) => {
                  const txt = xmlEsc(cell(c));
                  return isNumeric(c)
                    ? `<td style="border:1px solid #ddd;text-align:right" x:num="${txt}">${txt}</td>`
                    : `<td style="border:1px solid #ddd">${txt}</td>`;
                })
                .join('') +
              '</tr>',
          )
          .join('');
  // SpreadsheetML-flavoured HTML workbook. The xmlns + <!--[if gte mso 9]> worksheet name make Excel
  // treat it as a real sheet; the .xls extension + vnd.ms-excel type route it to the spreadsheet app.
  const html =
    `<html xmlns:o="urn:schemas-microsoft-com:office:office" ` +
    `xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">` +
    `<head><meta charset="utf-8"/>` +
    `<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>` +
    `<x:Name>${xmlEsc(d.title).slice(0, 31)}</x:Name>` +
    `<x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>` +
    `</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->` +
    `</head><body><table>` +
    `<caption style="font-weight:bold;text-align:left">${xmlEsc(d.title)}</caption>` +
    `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
  return { bytes: enc.encode(html), contentType: 'application/vnd.ms-excel; charset=utf-8', ext: 'xls' };
}

// ── PDF (pdf-lib + WinAnsi safe() guard) ─────────────────────────────────────
// Helvetica is WinAnsi (Latin-1): guard non-Latin codepoints so a CJK/Tamil roster never crashes the
// render. Documented as lossy for non-Latin names (ADR-0047 §7) — the substitution is intentional.
const safe = (s: string): string => (s ?? '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

export async function toPdfReport(d: ReportData): Promise<SerializedReport> {
  const doc = await PDFDocument.create();
  doc.setTitle(d.title);
  doc.setProducer('AI HR');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const M = 36;
  const pageW = 841.89; // A4 landscape — roster tables are wide
  const pageH = 595.28;
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.45, 0.45, 0.5);
  const lineCol = rgb(0.85, 0.85, 0.88);
  const headerSize = 8;
  const rowSize = 8;
  const rowH = 14;

  const nCols = Math.max(d.columns.length, 1);
  const usableW = pageW - 2 * M;
  const colW = usableW / nCols;

  let page = doc.addPage([pageW, pageH]);
  let y = pageH - M;

  const drawText = (s: string, x: number, size: number, f = font, color = ink) =>
    page.drawText(safe(s), { x, y, size, font: f, color });
  const hr = (yy: number) =>
    page.drawLine({ start: { x: M, y: yy }, end: { x: pageW - M, y: yy }, thickness: 0.6, color: lineCol });
  const truncate = (s: string, f: typeof font, size: number, maxW: number): string => {
    let t = safe(s);
    if (f.widthOfTextAtSize(t, size) <= maxW) return t;
    while (t.length > 1 && f.widthOfTextAtSize(t + '…', size) > maxW) t = t.slice(0, -1);
    return t + '…';
  };

  // Title
  drawText(d.title, M, 13, bold);
  y -= 20;

  const drawHeader = () => {
    d.columns.forEach((c, i) => drawText(truncate(c, bold, headerSize, colW - 4), M + i * colW, headerSize, bold, muted));
    y -= 6;
    hr(y);
    y -= rowH;
  };
  drawHeader();

  if (d.rows.length === 0) {
    drawText('No records', M, rowSize, font, muted);
  } else {
    for (const r of d.rows) {
      if (y < M + rowH) {
        page = doc.addPage([pageW, pageH]);
        y = pageH - M;
        drawHeader();
      }
      for (let i = 0; i < nCols; i++) {
        const v = r[i];
        drawText(truncate(cell(v ?? null), font, rowSize, colW - 4), M + i * colW, rowSize, font, ink);
      }
      y -= rowH;
    }
  }

  const bytes = await doc.save();
  return { bytes, contentType: 'application/pdf', ext: 'pdf' };
}

/** Dispatch a neutral report to the requested format. */
export function serializeReport(d: ReportData, format: ReportFormat): SerializedReport | Promise<SerializedReport> {
  if (format === 'xlsx') return toXlsxReport(d);
  if (format === 'pdf') return toPdfReport(d);
  return toCsvReport(d);
}
