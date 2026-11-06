import * as XLSX from 'xlsx';
import { checkPayItemArchive } from './pay-component-workbook';

const sheets = {
  Shifts: ['Shift Code', 'Shift Name', 'Shift Type', 'Time In', 'Time Out', 'Normal Working Minutes', 'Description', 'Category', 'Colour', 'Rounding Minutes'],
  Breaks: ['Shift Code', 'Break Type', 'Break Start', 'Break End', 'Flexible Minutes', 'Paid'],
} as const;

export const SHIFT_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 2000;

export function shiftImportWorkbook() {
  const book = XLSX.utils.book_new();
  for (const [name, columns] of Object.entries(sheets)) {
    const sheet = XLSX.utils.aoa_to_sheet([Array.from(columns)]);
    sheet['!cols'] = columns.map(column => ({ wch: Math.max(16, column.length + 3) }));
    XLSX.utils.book_append_sheet(book, sheet, name);
  }
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Shift import instructions'],
    ['Shift Code is required and identifies an existing shift for update. An update keeps fields left blank.'],
    ['New shifts require Shift Name. Shift Type defaults to normal. Enter clock times as text (HH:MM).'],
    ['Shift Type values: normal, semi_flexi, full_flexi. Flexible shifts require Normal Working Minutes.'],
    ['Add one Breaks row per break. If a shift has any Breaks rows, they replace its current break list.'],
    ['Break Type values: in_shift, before_shift, after_shift. Paid values: yes or no.'],
    ['Leave Flexible Minutes blank for a fixed break.'],
  ]), 'Instructions');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export type ShiftWorkbookRow = { row: number; values: Record<string, string> };

export function readShiftImportWorkbook(bytes: Buffer) {
  if (bytes.length > SHIFT_IMPORT_MAX_BYTES) throw new Error('The workbook exceeds the 2 MB limit.');
  checkPayItemArchive(bytes);
  const book = XLSX.read(bytes, { type: 'buffer', sheets: ['Shifts', 'Breaks'], cellFormula: true });
  const read = (name: keyof typeof sheets): ShiftWorkbookRow[] => {
    const sheet = book.Sheets[name];
    if (!sheet) throw new Error(`The workbook must contain a ${name} sheet.`);
    const columns = sheets[name];
    columns.forEach((heading, column) => {
      const cell = sheet[XLSX.utils.encode_cell({ r: 0, c: column })];
      if (cell?.f || String(cell?.v ?? '').trim() !== heading) throw new Error(`${name}: restore the template heading "${heading}".`);
    });
    const rows = new Map<number, Record<string, string>>();
    for (const [address, value] of Object.entries(sheet)) {
      if (address.startsWith('!')) continue;
      const cell = value as XLSX.CellObject;
      const { r, c } = XLSX.utils.decode_cell(address);
      if (r === 0) continue;
      const text = String(cell?.v ?? '').trim();
      if (!text && !cell?.f) continue;
      if (r > MAX_ROWS || rows.size >= MAX_ROWS && !rows.has(r)) throw new Error(`${name}: use at most ${MAX_ROWS} data rows.`);
      if (c >= columns.length || cell?.f || cell?.t === 'e') throw new Error(`${name} row ${r + 1}: use plain values in the template columns.`);
      const values = rows.get(r) ?? {};
      values[columns[c]] = text;
      rows.set(r, values);
    }
    return [...rows].sort(([a], [b]) => a - b).map(([row, values]) => ({ row: row + 1, values }));
  };
  return { shifts: read('Shifts'), breaks: read('Breaks') };
}

export type ShiftImportIssue = { sheet: 'Shifts' | 'Breaks'; row: number; field: string; message: string };

export function shiftImportErrorWorkbook(issues: ShiftImportIssue[]) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Sheet', 'Row', 'Field', 'Reason'],
    ...issues.map(issue => [issue.sheet, issue.row, issue.field, issue.message]),
  ]), 'Errors');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
