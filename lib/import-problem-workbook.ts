/**
 * Boards c074c6b8 / d3ba1e9f: the Error Log workbook (.xlsx) for any import, built from the same
 * ImportProblemLine list and translator the on-screen problem table uses (lib/import-problem-lines.ts), so the
 * file and the screen say the same thing.
 *
 * Environment-neutral (SheetJS only): runs on the server for downloads and in the browser for a check-screen
 * download built from what is already on screen. For very large logs streamed from storage, add a streaming
 * writer here that reuses importProblemCells and the same sheet layout; do not create a second format.
 *
 * Layout: an "Errors" sheet (frozen header, column widths, wrapped text, every cell guarded against formula
 * injection) and, when `summary` is given, a "Summary" sheet of label/value pairs (batch, file, counts, and a
 * note when the list was cut short). Styling technique moved from systemLabelErrorWorkbook unchanged.
 */
import * as XLSX from 'xlsx';
import {
  importProblemCells, importProblemColumns, importProblemHeaders, sortProblemLines,
  type ImportProblemColumn, type ImportProblemLine, type ImportProblemTranslator,
} from './import-problem-lines';

/** Formula-injection guard for every text cell (same rule as csvSafeCell, including TAB and CR). */
export const problemCellSafe = (s: string): string => (/^[\s]*[=+\-@\t\r]/.test(s) ? "'" + s : s);

const WIDTH: Record<ImportProblemColumn, number> = {
  sheet: 22, row: 10, category: 22, reference: 22, employeeName: 26, field: 24, value: 28,
  problem: 60, correction: 48, stage: 16, result: 18, errorReference: 18,
};

export type ImportProblemWorkbookInput = {
  lines: readonly ImportProblemLine[];
  t: ImportProblemTranslator;
  /** Optional Summary sheet rows: [label, value], already translated. */
  summary?: readonly (readonly [string, string | number])[];
  /** Force a column set (e.g. to keep a stable layout across runs); defaults to the informative columns. */
  columns?: readonly ImportProblemColumn[];
};

/** The Errors sheet's rows (header first) — exported so parity tests can compare with the screen. */
export function importProblemSheetRows(input: ImportProblemWorkbookInput): string[][] {
  const lines = sortProblemLines(input.lines);
  const columns = input.columns ?? importProblemColumns(lines);
  return [importProblemHeaders(columns, input.t), ...lines.map(l => importProblemCells(l, columns, input.t))];
}

export function importProblemWorkbook(input: ImportProblemWorkbookInput): Uint8Array {
  const lines = sortProblemLines(input.lines);
  const columns = input.columns ?? importProblemColumns(lines);
  const rowColumn = columns.indexOf('row');
  const data: (string | number)[][] = importProblemSheetRows({ ...input, lines, columns }).map((cells, r) =>
    cells.map((cell, c) => (r > 0 && c === rowColumn && /^\d+$/.test(cell) ? Number(cell) : problemCellSafe(cell))),
  );
  const widths = columns.map(c => WIDTH[c]);
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(data);
  sheet['!cols'] = widths.map(wch => ({ wch }));
  // Conservative wrapped-height estimate (not font metrics); long rows remain manually expandable.
  sheet['!rows'] = data.map((row, index) => ({ hpt: index === 0 ? 24 : Math.min(240, Math.max(32,
    8 + 15 * Math.max(...row.map((value, column) => String(value).split(/\r\n|\r|\n/).reduce((n, line) => n + Math.max(1, Math.ceil([...line].length / Math.max(1, widths[column] - 4))), 0))),
  )) }));
  XLSX.utils.book_append_sheet(wb, sheet, 'Errors');
  if (input.summary?.length) {
    const s = XLSX.utils.aoa_to_sheet(input.summary.map(([k, v]) => [problemCellSafe(k), typeof v === 'number' ? v : problemCellSafe(v)]));
    s['!cols'] = [{ wch: 28 }, { wch: 80 }];
    XLSX.utils.book_append_sheet(wb, s, 'Summary');
  }
  return styleErrorsSheet(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer, rowColumn);
}

const encoder = new TextEncoder(), decoder = new TextDecoder();
const columnLetter = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : columnLetter(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

/**
 * The installed SheetJS writer serializes widths/heights but not cell alignment or panes, so wrap text,
 * top-align and freeze the header by editing this freshly generated archive. No uploaded archive or business
 * value is rewritten here.
 */
function styleErrorsSheet(bytes: ArrayBuffer, rowColumn: number): Uint8Array {
  const zip = XLSX.CFB.read(new Uint8Array(bytes), { type: 'array' });
  const part = (name: string): string => {
    const entry = XLSX.CFB.find(zip, '/' + name); // CFB resolves a leading slash against its Root Entry.
    if (!entry?.content) throw new Error('Error workbook layout is unavailable.');
    return decoder.decode(entry.content as Uint8Array);
  };
  let styles = part('xl/styles.xml');
  const cellXfs = /<cellXfs\b[^>]*\bcount="(\d+)"[^>]*>/.exec(styles);
  if (!cellXfs || !styles.includes('</cellXfs>')) throw new Error('Error workbook styles are unavailable.');
  const first = Number(cellXfs[1]);
  const wrapped = [0, 49].map(numFmtId => `<xf numFmtId="${numFmtId}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>`).join('');
  styles = styles.replace(cellXfs[0], cellXfs[0].replace(/count="\d+"/, `count="${first + 2}"`)).replace('</cellXfs>', wrapped + '</cellXfs>');
  const rowLetter = rowColumn >= 0 ? columnLetter(rowColumn) : null;
  let xml = part('xl/worksheets/sheet1.xml').replace(/<c\b[^>]*>/g, opening => {
    const closed = opening.endsWith('/>'), attributes = opening.slice(2, closed ? -2 : -1).replace(/\s+s="[^"]*"/g, '');
    const address = /\br="([A-Z]+)(\d+)"/.exec(attributes);
    const style = first + (address?.[1] === rowLetter && address[2] !== '1' ? 0 : 1);
    return '<c' + attributes + ` s="${style}"` + (closed ? '/>' : '>');
  });
  const pane = '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
  xml = /<sheetViews>[\s\S]*?<\/sheetViews>/.test(xml) ? xml.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, pane) : xml.replace(/(<dimension\b[^>]*\/>)/, `$1${pane}`);
  XLSX.CFB.utils.cfb_add(zip, '/xl/styles.xml', encoder.encode(styles));
  XLSX.CFB.utils.cfb_add(zip, '/xl/worksheets/sheet1.xml', encoder.encode(xml));
  return new Uint8Array(XLSX.CFB.write(zip, { type: 'array', fileType: 'zip', compression: true }) as ArrayLike<number>);
}
