/**
 * CSV formula-injection hardening (Reporting & Analytics — chart-export slice). toCsv now neutralises a
 * cell that begins with = + - @ TAB CR by prefixing a single quote (OWASP mitigation), so an exported
 * employee name like `=HYPERLINK(...)` or `@SUM(...)` can't execute when the "Excel/CSV" download is
 * opened. Plain values are untouched (byte-identical to the pre-slice export).
 */
import { describe, expect, it } from 'vitest';
import { csvSafeCell, toCsv } from '../lib/csv';
import * as XLSX from 'xlsx';
import { problemCellSafe } from '../lib/import-problem-workbook';
import { importProblemWorkbookStreamBytes } from '../lib/import-problem-workbook-stream';
import type { ImportProblemLine } from '../lib/import-problem-lines';

describe('CSV formula-injection sanitisation', () => {
  it('prefixes a single quote on leading-formula cells', () => {
    expect(csvSafeCell('=HYPERLINK("http://evil","x")')).toBe("'=HYPERLINK(\"http://evil\",\"x\")");
    expect(csvSafeCell('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
    expect(csvSafeCell('+1+1')).toBe("'+1+1");
    expect(csvSafeCell('-2+3')).toBe("'-2+3");
    expect(csvSafeCell('\tTabbed')).toBe("'\tTabbed");
  });

  it('leaves ordinary values untouched', () => {
    expect(csvSafeCell('Ann Tan')).toBe('Ann Tan');
    expect(csvSafeCell('ann@acme.test')).toBe('ann@acme.test'); // @ only triggers at position 0
    expect(csvSafeCell('5000.00')).toBe('5000.00');
    expect(csvSafeCell(1234)).toBe('1234');
    expect(csvSafeCell(null)).toBe('');
    expect(csvSafeCell(undefined)).toBe('');
  });

  it('toCsv quotes AND sanitises a malicious cell (quote prefix lands inside the field)', () => {
    const csv = toCsv([['Name'], ['=cmd|"/c calc"!A1']]);
    // The leading = is neutralised with a single quote; the embedded double-quote is RFC-escaped, and
    // because the cell still contains a quote it is wrapped — the formula never reaches the cell start.
    expect(csv).toBe('Name\r\n"\'=cmd|""/c calc""!A1"\r\n');
    expect(csv.includes('\n=')).toBe(false);
    expect(csv.includes(',=')).toBe(false);
  });

  it('does not alter the byte output of a clean roster row', () => {
    expect(toCsv([['Name', 'Dept'], ['Ann', 'Finance']])).toBe('Name,Dept\r\nAnn,Finance\r\n');
  });
});

/** d3ba1e9f — the Excel Error Log carries uploaded names and codes too: the streamed .xlsx never holds a formula. */
describe('xlsx Error Log formula-injection sanitisation', () => {
  it('guards the same leading characters as the CSV guard', () => {
    for (const raw of ['=HYPERLINK("http://evil","x")', '@SUM(A1:A9)', '+1+1', '-2+3', '\tTabbed', '\rCR', ' =spaced']) expect(problemCellSafe(raw)).toBe("'" + raw);
    expect(problemCellSafe('Ann Tan')).toBe('Ann Tan');
  });

  it('writes uploaded text as text cells, never as formulas, in the streamed Error Log', async () => {
    const t = (key: string) => key;
    const lines: ImportProblemLine[] = [{ row: 2, reference: '=HYPERLINK("http://evil","x")', employeeName: '@SUM(A1:A9)', value: '+cmd|/C calc', problem: '-2+3', stage: 'check', result: 'refused' }];
    async function* pages() { yield lines; }
    const bytes = await importProblemWorkbookStreamBytes({ pages: pages(), columns: ['row', 'reference', 'employeeName', 'value', 'problem', 'result'], t });
    const sheet = XLSX.read(bytes, { type: 'buffer', cellFormula: true }).Sheets.Errors;
    const cells = Object.keys(sheet).filter(k => !k.startsWith('!'));
    expect(cells.some(k => sheet[k].f)).toBe(false);
    expect(['B2', 'C2', 'D2', 'E2'].map(k => [sheet[k].t, sheet[k].v])).toEqual([
      ['s', '\'=HYPERLINK("http://evil","x")'], ['s', "'@SUM(A1:A9)"], ['s', "'+cmd|/C calc"], ['s', "'-2+3"],
    ]);
  });
});
