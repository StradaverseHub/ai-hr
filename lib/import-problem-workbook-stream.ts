/**
 * Board d3ba1e9f — the streaming form of the Error Log workbook (lib/import-problem-workbook.ts), for a log too
 * large to build in memory: the Bank and Statutory import's 250,000-row file.
 *
 * Same file, written differently. The Errors sheet carries exactly the cells importProblemWorkbook writes for the
 * same lines and columns (headers from importProblemHeaders, cells from importProblemCells, every text cell through
 * problemCellSafe, the Excel row column numeric), the same column widths, row-height estimate, frozen header and
 * wrapped top-aligned style, and the same optional Summary sheet. test/import-problem-workbook-stream.test.ts reads
 * both files back with SheetJS and compares them cell for cell.
 *
 * How it streams: the Errors sheet XML is produced from an async iterator of pages (the caller reads storage in
 * bounded pages) and handed to JSZip as a Node stream; generateNodeStream({streamFiles:true}) writes each entry
 * with a data descriptor, so no part of the archive needs the whole sheet first, and JSZip's pause/resume carries
 * the HTTP consumer's back-pressure to the page reader: a slow download reads storage slowly instead of buffering.
 *
 * Order: unlike importProblemWorkbook this writer cannot sort; pages must arrive in sortProblemLines order (whole-
 * file lines first, then by Excel row), which a reader paging by row number gives naturally. Columns must be fixed
 * up front for the same reason.
 *
 * Server only (node:stream).
 */
import { Readable } from 'node:stream';
import JSZip from 'jszip';
import {
  importProblemCells, importProblemHeaders,
  type ImportProblemColumn, type ImportProblemLine, type ImportProblemTranslator,
} from './import-problem-lines';
import { problemCellSafe } from './import-problem-workbook';

/** Kept equal to lib/import-problem-workbook.ts (asserted by the parity test through the files' column widths). */
const WIDTH: Record<ImportProblemColumn, number> = {
  sheet: 22, row: 10, category: 22, reference: 22, employeeName: 26, field: 24, value: 28,
  problem: 60, correction: 48, stage: 16, result: 18, errorReference: 18,
};

export type ImportProblemWorkbookStreamInput = {
  /** Pages of lines, already in sortProblemLines order. */
  pages: AsyncIterable<readonly ImportProblemLine[]>;
  columns: readonly ImportProblemColumn[];
  t: ImportProblemTranslator;
  summary?: readonly (readonly [string, string | number])[];
};

const columnLetter = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : columnLetter(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));
/** XML text, with the characters XML 1.0 cannot carry written as Excel's _xHHHH_ escapes (as SheetJS writes them). */
const xmlText = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000B-\u001F￾￿]/g, c => `_x${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`);

/** A width in characters as SheetJS writes it (char2width at its default maximum digit width of 6 px). */
const columnWidth = (wch: number) => Math.round(((wch * 6 + 5) / 6) * 256) / 256;

/** The same conservative wrapped-height estimate importProblemWorkbook uses. */
function rowHeight(index: number, row: readonly (string | number)[], widths: readonly number[]): number {
  if (index === 0) return 24;
  return Math.min(240, Math.max(32, 8 + 15 * Math.max(...row.map((value, column) =>
    String(value).split(/\r\n|\r|\n/).reduce((n, line) => n + Math.max(1, Math.ceil([...line].length / Math.max(1, widths[column] - 4))), 0)))));
}

/** Style ids in the styles part below: 1 = wrapped/top (General, the Excel row column), 2 = wrapped/top (Text). */
function rowXml(r: number, cells: readonly (string | number)[], widths: readonly number[], rowColumn: number): string {
  let xml = `<row r="${r}" ht="${rowHeight(r - 1, cells, widths)}" customHeight="1">`;
  cells.forEach((cell, c) => {
    const ref = columnLetter(c) + r, style = r > 1 && c === rowColumn ? 1 : 2;
    xml += typeof cell === 'number'
      ? `<c r="${ref}" s="${style}"><v>${cell}</v></c>`
      : `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlText(cell)}</t></is></c>`;
  });
  return xml + '</row>';
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

async function* errorsSheet(input: ImportProblemWorkbookStreamInput): AsyncGenerator<Buffer> {
  const { columns, t } = input, widths = columns.map(c => WIDTH[c]), rowColumn = columns.indexOf('row');
  const head = importProblemHeaders(columns, t).map(problemCellSafe);
  yield Buffer.from(XML + `<worksheet ${NS}>`
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${columnWidth(w)}" customWidth="1"/>`).join('')}</cols>`
    + '<sheetData>' + rowXml(1, head, widths, rowColumn), 'utf8');
  let r = 1;
  for await (const page of input.pages) {
    let chunk = '';
    for (const line of page) {
      r++;
      const cells = importProblemCells(line, columns, t).map((cell, c) => (c === rowColumn && /^\d+$/.test(cell) ? Number(cell) : problemCellSafe(cell)));
      chunk += rowXml(r, cells, widths, rowColumn);
    }
    if (chunk) yield Buffer.from(chunk, 'utf8');
  }
  yield Buffer.from('</sheetData></worksheet>', 'utf8');
}

function summarySheet(summary: readonly (readonly [string, string | number])[]): string {
  const rows = summary.map(([k, v], i) => {
    const r = i + 1, label = `<c r="A${r}" t="inlineStr"><is><t xml:space="preserve">${xmlText(problemCellSafe(k))}</t></is></c>`;
    const value = typeof v === 'number' ? `<c r="B${r}"><v>${v}</v></c>` : `<c r="B${r}" t="inlineStr"><is><t xml:space="preserve">${xmlText(problemCellSafe(v))}</t></is></c>`;
    return `<row r="${r}">${label}${value}</row>`;
  }).join('');
  return XML + `<worksheet ${NS}><cols><col min="1" max="1" width="${columnWidth(28)}" customWidth="1"/><col min="2" max="2" width="${columnWidth(80)}" customWidth="1"/></cols><sheetData>${rows}</sheetData></worksheet>`;
}

const STYLES = XML + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="1"><font><sz val="12"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
  + '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

/** The Error Log as a Node stream of .xlsx bytes. Read errors from `pages` surface as a stream error. */
export function importProblemWorkbookStream(input: ImportProblemWorkbookStreamInput): Readable {
  const withSummary = !!input.summary?.length;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + (withSummary ? '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' : '')
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>');
  zip.file('_rels/.rels', XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', XML + `<workbook ${NS}><sheets><sheet name="Errors" sheetId="1" r:id="rId1"/>${withSummary ? '<sheet name="Summary" sheetId="2" r:id="rId2"/>' : ''}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + (withSummary ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' : '')
    + '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.file('xl/styles.xml', STYLES);
  if (withSummary) zip.file('xl/worksheets/sheet2.xml', summarySheet(input.summary!));
  // A byte stream (not object mode) with a small buffer: the page reader runs only as fast as the archive is read.
  zip.file('xl/worksheets/sheet1.xml', Readable.from(errorsSheet(input), { objectMode: false, highWaterMark: 64 * 1024 }));
  // JSZip returns a legacy readable-stream; wrap it so consumers get a modern Readable (async iteration, toWeb).
  return new Readable({ highWaterMark: 64 * 1024 }).wrap(zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE' }));
}

/** Collect a stream into one buffer (tests, small logs). */
export async function importProblemWorkbookStreamBytes(input: ImportProblemWorkbookStreamInput): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of importProblemWorkbookStream(input)) parts.push(Buffer.from(part as Buffer));
  return Buffer.concat(parts);
}
