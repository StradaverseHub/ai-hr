import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { readSpreadsheetArchive } from '../lib/spreadsheet-archive';
import {
  HIDDEN_VALUE, IMPORT_PROBLEM_VALUE_MAX, importProblemCells, importProblemColumns, sortProblemLines, type ImportProblemLine,
} from '../lib/import-problem-lines';
import { importProblemSheetRows, importProblemWorkbook } from '../lib/import-problem-workbook';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';

/** A translator over the real catalogue, the way next-intl resolves a dotted key within a namespace. */
const translator = (catalogue: Record<string, unknown>) => (key: string): string => {
  const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], catalogue.importProblems);
  if (typeof v !== 'string') throw new Error(`missing importProblems.${key}`);
  return v;
};
const LOCALES = { en, ms, zh, ta, th, vi } as Record<string, Record<string, unknown>>;

const lines: ImportProblemLine[] = [
  { sheet: 'Employees', row: 9, reference: 'EMP-0011', employeeName: 'Aina', field: 'Department', value: 'NOPE', problem: 'Department code does not exist in the system.', correction: 'Choose a Department from the Reference sheet.', stage: 'check', result: 'refused' },
  { sheet: 'Employees', row: 6, reference: 'EMP-0008', field: 'NRIC', value: HIDDEN_VALUE, problem: 'Invalid NRIC.', stage: 'check', result: 'refused' },
  { row: null, problem: 'The column "Employee ID" is missing.', stage: 'file', result: 'not_saved' },
  { sheet: 'Family', row: 3, reference: 'EMP-0001', problem: '=HYPERLINK("http://x")', stage: 'save', result: 'stopped' },
];

describe('shared import problem lines (boards c074c6b8 / d3ba1e9f)', () => {
  it('orders whole-file problems first, then sheet in first-appearance order, then Excel row', () => {
    expect(sortProblemLines(lines).map(l => [l.sheet ?? '-', l.row])).toEqual([['-', null], ['Employees', 6], ['Employees', 9], ['Family', 3]]);
  });

  it('groups sheetless lines by category in first-appearance order (System Labels)', () => {
    const l = (category: string, row: number): ImportProblemLine => ({ category, row, problem: 'p', stage: 'check', result: 'refused' });
    expect(sortProblemLines([l('Departments', 9), l('Positions', 3), l('Departments', 4)]).map(x => [x.category, x.row]))
      .toEqual([['Departments', 4], ['Departments', 9], ['Positions', 3]]);
  });

  it('shows only informative columns, always row, problem and result', () => {
    expect(importProblemColumns([{ row: 2, problem: 'x', stage: 'check', result: 'refused' }])).toEqual(['row', 'problem', 'stage', 'result']);
    expect(importProblemColumns(lines)).toEqual(['sheet', 'row', 'reference', 'employeeName', 'field', 'value', 'problem', 'correction', 'stage', 'result']);
  });

  it('never repeats a hidden value and bounds long values', () => {
    const t = translator(en), cols = importProblemColumns(lines);
    const cells = importProblemCells(lines[1], cols, t);
    expect(cells[cols.indexOf('value')]).toBe('(hidden)');
    expect(cells.join(' ')).not.toContain('HIDDEN');
    const long = importProblemCells({ row: 2, value: 'x'.repeat(500), problem: 'p', stage: 'check', result: 'refused' }, ['value'], t)[0];
    expect([...long]).toHaveLength(IMPORT_PROBLEM_VALUE_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it.each(Object.keys(LOCALES))('the workbook says exactly what the screen says (%s)', async locale => {
    const t = translator(LOCALES[locale]), sorted = sortProblemLines(lines), cols = importProblemColumns(sorted);
    const screen = sorted.map(l => importProblemCells(l, cols, t));
    const book = XLSX.read(importProblemWorkbook({ lines, t }), { type: 'array' });
    expect(book.SheetNames).toEqual(['Errors']);
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(book.Sheets.Errors, { header: 1, raw: false, defval: '' }) as string[][];
    expect(rows[0]).toEqual(cols.map(c => t(`headers.${c}`)));
    // Formula-guarded cells carry a leading apostrophe in the file only; compare with it removed.
    expect(rows.slice(1).map(r => r.map(String).map(c => c.replace(/^'(?=[\s]*[=+\-@\t\r])/, '')))).toEqual(screen);
    expect(importProblemSheetRows({ lines, t }).slice(1)).toEqual(screen);
  });

  it('guards formulas, keeps Excel rows numeric, freezes the header and writes a well-formed archive', async () => {
    const t = translator(en), bytes = importProblemWorkbook({ lines, t, summary: [['Import', 'Batch 7'], ['Problems', 4]] });
    readSpreadsheetArchive(Buffer.from(bytes), { maxBytes: 5_000_000, maxExpandedBytes: 8_000_000, maxEntries: 160 });
    const book = XLSX.read(bytes, { type: 'array', cellFormula: true });
    expect(book.SheetNames).toEqual(['Errors', 'Summary']);
    const sheet = book.Sheets.Errors, cols = importProblemColumns(lines);
    const cellsInSheet = Object.keys(sheet).filter(k => !k.startsWith('!'));
    expect(cellsInSheet.some(k => sheet[k].f)).toBe(false);
    const problemCol = XLSX.utils.encode_col(cols.indexOf('problem')), rowCol = XLSX.utils.encode_col(cols.indexOf('row'));
    expect(sheet[`${problemCol}5`].v).toBe('\'=HYPERLINK("http://x")');
    expect(sheet[`${rowCol}3`].t).toBe('n');
    expect(sheet[`${rowCol}2`].v).toBe('Whole file');
    const xml = await (await JSZip.loadAsync(bytes)).file('xl/worksheets/sheet1.xml')!.async('string');
    expect(xml).toContain('state="frozen"');
    expect(xml).toMatch(/<c r="[A-Z]+2"[^>]* s="\d+"/);
  });

  it('every locale defines the whole shared vocabulary', () => {
    const keys = (o: unknown, p = ''): string[] => typeof o === 'string' ? [p] : Object.entries(o as object).flatMap(([k, v]) => keys(v, p ? `${p}.${k}` : k));
    const want = keys(en.importProblems).sort();
    for (const [locale, catalogue] of Object.entries(LOCALES)) expect(keys(catalogue.importProblems).sort(), locale).toEqual(want);
  });
});
