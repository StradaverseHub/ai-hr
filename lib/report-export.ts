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
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { toCsv } from './csv';

export type ColAlign = 'left' | 'center' | 'right';

/**
 * Presentation layout carried alongside the tabular data (c440b365 report properties + AI designer).
 * Every field is optional so pre-existing callers (analytics/OT exports) keep working unchanged — a
 * ReportData with no `layout` renders exactly as before.
 *   - `align` / `widths` are per-COLUMN (index-aligned to `columns`); the runner resolves them from the
 *     spec's per-field maps + the field-type defaults so serializers never re-derive alignment.
 *   - `freeze` = count of leading columns kept as the frozen/repeated block (Excel pane + PDF marker).
 */
export type ReportLayout = {
  subtitle?: string | null;
  description?: string | null;
  header?: string | null;
  footer?: string | null;
  watermark?: string | null;
  companyLogo?: string | null; // data-URI image OR a short text mark
  orientation?: 'portrait' | 'landscape';
  paperSize?: 'A4' | 'A3' | 'Letter' | 'Legal';
  margins?: 'narrow' | 'normal' | 'wide';
  align?: ColAlign[];
  widths?: number[]; // relative weights (index-aligned); undefined ⇒ equal widths
  freeze?: number;
};

/** Neutral report shape. `comp`-derived columns must be built into BOTH `columns` and every row by the
 *  caller so lengths always match (XLSX/PDF tables are unforgiving of ragged rows). */
export type ReportData = {
  filename: string; // ascii-safe base (no extension)
  title: string;
  columns: string[];
  rows: (string | number | null)[][];
  layout?: ReportLayout;
};

export type ReportFormat = 'csv' | 'xlsx' | 'pdf' | 'docx';
export type SerializedReport = { bytes: Uint8Array; contentType: string; ext: string };

/** A4/A3/Letter/Legal in PDF points (72/inch), landscape-normalised at the call site. */
const PAPER_PT: Record<NonNullable<ReportLayout['paperSize']>, [number, number]> = {
  A4: [595.28, 841.89],
  A3: [841.89, 1190.55],
  Letter: [612, 792],
  Legal: [612, 1008],
};
const MARGIN_PT: Record<NonNullable<ReportLayout['margins']>, number> = { narrow: 24, normal: 36, wide: 54 };

/** Resolve per-column alignment: explicit layout.align wins, else the numeric heuristic. */
const alignOf = (d: ReportData, i: number, v: string | number | null): ColAlign =>
  d.layout?.align?.[i] ?? (isNumeric(v) ? 'right' : 'left');
/** Header alignment mirrors the column body alignment (numbers/currency right, etc.). */
const headerAlignOf = (d: ReportData, i: number): ColAlign => d.layout?.align?.[i] ?? 'left';

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
  const L = d.layout;
  const totalW = (L?.widths ?? []).reduce((a, b) => a + (b || 0), 0);
  const head = d.columns
    .map((c, i) => {
      const a = headerAlignOf(d, i);
      const w = L?.widths && totalW > 0 ? `;width:${Math.round((L.widths[i] / totalW) * 100)}%` : '';
      const frozen = L?.freeze && i < L.freeze ? ';background:#dde' : ';background:#eef';
      return `<th style="border:1px solid #ccc;font-weight:bold;text-align:${a}${frozen}${w}">${xmlEsc(c)}</th>`;
    })
    .join('');
  const body =
    d.rows.length === 0
      ? '' // empty report → header-only sheet (still a valid, openable workbook)
      : d.rows
          .map(
            (r) =>
              '<tr>' +
              r
                .map((c, i) => {
                  const txt = xmlEsc(cell(c));
                  const a = alignOf(d, i, c);
                  return isNumeric(c)
                    ? `<td style="border:1px solid #ddd;text-align:${a}" x:num="${txt}">${txt}</td>`
                    : `<td style="border:1px solid #ddd;text-align:${a}">${txt}</td>`;
                })
                .join('') +
              '</tr>',
          )
          .join('');
  const logo =
    L?.companyLogo && L.companyLogo.startsWith('data:')
      ? `<img src="${xmlEsc(L.companyLogo)}" style="max-height:48px;float:right"/>`
      : L?.companyLogo
        ? `<div style="float:right;font-weight:bold;color:#556">${xmlEsc(L.companyLogo)}</div>`
        : '';
  const meta =
    (L?.header ? `<div style="color:#556;font-size:9pt">${xmlEsc(L.header)}</div>` : '') +
    (L?.subtitle ? `<div style="color:#556">${xmlEsc(L.subtitle)}</div>` : '') +
    (L?.description ? `<div style="color:#778;font-size:9pt">${xmlEsc(L.description)}</div>` : '');
  const footer = L?.footer ? `<div style="color:#778;font-size:9pt;margin-top:6px">${xmlEsc(L.footer)}</div>` : '';
  // Freeze N leading columns as an Excel split pane (top row always; +N cols when freeze set).
  const frozenCols = L?.freeze ?? 0;
  const paneOpts = frozenCols > 0
    ? `<x:FreezePanes/><x:SplitVertical>${frozenCols}</x:SplitVertical><x:LeftColumnRightPane>${frozenCols}</x:LeftColumnRightPane>`
    : '';
  // SpreadsheetML-flavoured HTML workbook. The xmlns + <!--[if gte mso 9]> worksheet name make Excel
  // treat it as a real sheet; the .xls extension + vnd.ms-excel type route it to the spreadsheet app.
  const html =
    `<html xmlns:o="urn:schemas-microsoft-com:office:office" ` +
    `xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">` +
    `<head><meta charset="utf-8"/>` +
    `<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>` +
    `<x:Name>${xmlEsc(d.title).slice(0, 31)}</x:Name>` +
    `<x:WorksheetOptions><x:DisplayGridlines/>${paneOpts}</x:WorksheetOptions>` +
    `</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->` +
    `</head><body>${logo}` +
    `<div style="font-weight:bold;font-size:13pt">${xmlEsc(d.title)}</div>${meta}` +
    `<table>` +
    `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${footer}</body></html>`;
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

  const L = d.layout;
  const M = MARGIN_PT[L?.margins ?? 'normal'];
  // Paper size honoured (default A4); landscape swaps the axes — roster tables are wide, so default landscape.
  const [pw, ph] = PAPER_PT[L?.paperSize ?? 'A4'];
  const landscape = (L?.orientation ?? 'landscape') === 'landscape';
  const pageW = landscape ? Math.max(pw, ph) : Math.min(pw, ph);
  const pageH = landscape ? Math.min(pw, ph) : Math.max(pw, ph);
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.45, 0.45, 0.5);
  const lineCol = rgb(0.85, 0.85, 0.88);
  const headerSize = 8;
  const rowSize = 8;
  const rowH = 14;

  const nCols = Math.max(d.columns.length, 1);
  const usableW = pageW - 2 * M;
  // Column widths: honour relative weights when provided, else equal split. Returns [x, width] per column.
  const weights = L?.widths && L.widths.length === nCols && L.widths.some((w) => w > 0) ? L.widths : null;
  const totalWeight = weights ? weights.reduce((a, b) => a + (b || 0), 0) : nCols;
  const colBox = (i: number): { x: number; w: number } => {
    if (!weights) return { x: M + i * (usableW / nCols), w: usableW / nCols };
    let x = M;
    for (let k = 0; k < i; k++) x += (weights[k] / totalWeight) * usableW;
    return { x, w: (weights[i] / totalWeight) * usableW };
  };

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
  // Align text within a column box: left = x, center/right shift by the measured glyph width.
  const alignedX = (text: string, f: typeof font, size: number, box: { x: number; w: number }, a: ColAlign): number => {
    if (a === 'left') return box.x;
    const tw = f.widthOfTextAtSize(safe(text), size);
    if (a === 'center') return box.x + Math.max(0, (box.w - 4 - tw) / 2);
    return box.x + Math.max(0, box.w - 4 - tw); // right
  };

  // Diagonal watermark behind the content (repeated faintly, if set).
  const drawWatermark = () => {
    if (!L?.watermark) return;
    const wm = safe(L.watermark).toUpperCase();
    page.drawText(wm, {
      x: pageW / 2 - font.widthOfTextAtSize(wm, 48) / 2,
      y: pageH / 2,
      size: 48,
      font: bold,
      color: rgb(0.92, 0.92, 0.95),
      rotate: degrees(30),
    });
  };
  drawWatermark();

  // Company logo (text mark top-right; data-URI images are not embeddable via the WinAnsi path — text mark
  // is the zero-dep fallback that both PDF and the office formats share).
  if (L?.companyLogo && !L.companyLogo.startsWith('data:')) {
    const mark = safe(L.companyLogo);
    page.drawText(mark, { x: pageW - M - bold.widthOfTextAtSize(mark, 10), y, size: 10, font: bold, color: muted });
  }

  // Title + subtitle + description + header line
  drawText(d.title, M, 13, bold);
  y -= 16;
  if (L?.subtitle) { drawText(L.subtitle, M, 9, font, muted); y -= 12; }
  if (L?.header) { drawText(L.header, M, 8, font, muted); y -= 11; }
  if (L?.description) { drawText(truncate(L.description, font, 8, usableW), M, 8, font, muted); y -= 11; }
  y -= 4;

  const drawHeader = () => {
    d.columns.forEach((c, i) => {
      const box = colBox(i);
      const a = headerAlignOf(d, i);
      const t = truncate(c, bold, headerSize, box.w - 4);
      drawText(t, alignedX(t, bold, headerSize, box, a), headerSize, bold, muted);
    });
    y -= 6;
    hr(y);
    y -= rowH;
  };
  drawHeader();

  const footerH = L?.footer ? 14 : 0;
  const newPage = () => {
    page = doc.addPage([pageW, pageH]);
    y = pageH - M;
    drawWatermark();
    drawHeader();
  };

  if (d.rows.length === 0) {
    drawText('No records', M, rowSize, font, muted);
  } else {
    for (const r of d.rows) {
      if (y < M + rowH + footerH) newPage();
      for (let i = 0; i < nCols; i++) {
        const v = r[i];
        const box = colBox(i);
        const a = alignOf(d, i, v ?? null);
        const t = truncate(cell(v ?? null), font, rowSize, box.w - 4);
        drawText(t, alignedX(t, font, rowSize, box, a), rowSize, font, ink);
      }
      y -= rowH;
    }
  }

  // Footer on every page (drawn at the bottom margin of each page that exists).
  if (L?.footer) {
    for (const p of doc.getPages()) {
      p.drawText(safe(L.footer), { x: M, y: M - 6, size: 7, font, color: muted });
    }
  }

  const bytes = await doc.save();
  return { bytes, contentType: 'application/pdf', ext: 'pdf' };
}

// ── Word (.docx — a true, zero-dep OOXML WordprocessingML document) ───────────
// c440b365 gap-10: the reporter asked specifically for Microsoft Word (.docx). A .docx is a ZIP of XML
// parts; we hand-roll a minimal STORE-method (no-compression) ZIP + a CRC-32 so no dependency is needed.
// Word/Pages/LibreOffice open the result as a native editable .docx with a real table, per-column
// alignment, title/subtitle/description/header/footer and a text company mark — honouring the AI layout.

// CRC-32 (IEEE) — table-driven, computed lazily once.
let CRC_TABLE: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

type ZipEntry = { name: string; data: Uint8Array };

/** Build a STORE-method (uncompressed) ZIP archive from entries. Sufficient for OOXML packages. */
function buildZip(entries: ZipEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
  const u32 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  const concat = (...a: Uint8Array[]) => {
    const total = a.reduce((s, x) => s + x.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const x of a) { out.set(x, p); p += x.length; }
    return out;
  };
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;
    const local = concat(
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), nameBytes, e.data,
    );
    parts.push(local);
    central.push(concat(
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), nameBytes,
    ));
    offset += local.length;
  }
  const cd = concat(...central);
  const end = concat(
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(cd.length), u32(offset), u16(0),
  );
  return concat(...parts, cd, end);
}

const WJC: Record<ColAlign, string> = { left: 'left', center: 'center', right: 'right' };
const wPara = (text: string, a: ColAlign, boldRun = false): string =>
  `<w:p><w:pPr><w:jc w:val="${WJC[a]}"/></w:pPr>` +
  `<w:r>${boldRun ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;

export function toDocxReport(d: ReportData): SerializedReport {
  const L = d.layout;
  const nCols = Math.max(d.columns.length, 1);
  const weights = L?.widths && L.widths.length === nCols ? L.widths : d.columns.map(() => 1);
  const totalW = weights.reduce((a, b) => a + (b || 1), 0);
  const gridCols = weights.map((w) => `<w:gridCol w:w="${Math.max(300, Math.round((w / totalW) * 9000))}"/>`).join('');

  const headerRow =
    '<w:tr>' +
    d.columns
      .map((c, i) => {
        const a = headerAlignOf(d, i);
        return `<w:tc><w:tcPr><w:shd w:val="clear" w:fill="EEEEF5"/></w:tcPr>${wPara(c, a, true)}</w:tc>`;
      })
      .join('') +
    '</w:tr>';
  const bodyRows =
    d.rows.length === 0
      ? `<w:tr><w:tc>${wPara('No records', 'left')}</w:tc></w:tr>`
      : d.rows
          .map(
            (r) =>
              '<w:tr>' +
              d.columns
                .map((_c, i) => {
                  const v = r[i] ?? null;
                  return `<w:tc>${wPara(cell(v), alignOf(d, i, v))}</w:tc>`;
                })
                .join('') +
              '</w:tr>',
          )
          .join('');

  const tbl =
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>` +
    `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>`)
      .join('')}</w:tblBorders></w:tblPr>` +
    `<w:tblGrid>${gridCols}</w:tblGrid>${headerRow}${bodyRows}</w:tbl>`;

  const preamble =
    (L?.companyLogo && !L.companyLogo.startsWith('data:') ? wPara(L.companyLogo, 'right', true) : '') +
    wPara(d.title, 'left', true) +
    (L?.header ? wPara(L.header, 'left') : '') +
    (L?.subtitle ? wPara(L.subtitle, 'left') : '') +
    (L?.description ? wPara(L.description, 'left') : '') +
    (L?.watermark ? wPara(`— ${L.watermark} —`, 'center') : '');
  const footer = L?.footer ? wPara(L.footer, 'center') : '';
  const landscape = (L?.orientation ?? 'landscape') === 'landscape';
  const sect = landscape
    ? '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr>'
    : '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';

  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${preamble}${tbl}${footer}<w:p>${sect}</w:p></w:body></w:document>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;

  const bytes = buildZip([
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: 'word/document.xml', data: enc.encode(document) },
  ]);
  return {
    bytes,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: 'docx',
  };
}

/** Dispatch a neutral report to the requested format. */
export function serializeReport(d: ReportData, format: ReportFormat): SerializedReport | Promise<SerializedReport> {
  if (format === 'xlsx') return toXlsxReport(d);
  if (format === 'pdf') return toPdfReport(d);
  if (format === 'docx') return toDocxReport(d);
  return toCsvReport(d);
}
