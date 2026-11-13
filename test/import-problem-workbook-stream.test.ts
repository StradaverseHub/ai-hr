/**
 * Board d3ba1e9f — the streamed Error Log (lib/import-problem-workbook-stream.ts) is the SAME file as the in-memory
 * one (lib/import-problem-workbook.ts) for the same lines and columns, cell for cell, in every locale; and it streams:
 * a large log is read from its page source only as fast as the archive is consumed.
 */
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { readSpreadsheetArchive } from '../lib/spreadsheet-archive';
import { HIDDEN_VALUE, importProblemColumns, sortProblemLines, type ImportProblemColumn, type ImportProblemLine } from '../lib/import-problem-lines';
import { importProblemWorkbook } from '../lib/import-problem-workbook';
import { importProblemWorkbookStream, importProblemWorkbookStreamBytes } from '../lib/import-problem-workbook-stream';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';

const LOCALES = { en, ms, zh, ta, th, vi } as Record<string, Record<string, unknown>>;
const translator = (catalogue: Record<string, unknown>) => (key: string): string => {
  const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], catalogue.importProblems);
  if (typeof v !== 'string') throw new Error(`missing importProblems.${key}`);
  return v;
};

const lines: ImportProblemLine[] = sortProblemLines([
  { row: null, problem: 'Import stopped. Reference DB-S-0A1B2C.', stage: 'system', result: 'not_saved', errorReference: 'DB-S-0A1B2C' },
  { row: 2, reference: 'EMP-0001', employeeName: 'Aina binti Ali', field: 'Bank Account No', value: HIDDEN_VALUE, problem: 'bank_name and bank_account_no must be provided together', correction: 'Enter the bank name and the bank account number together.', stage: 'check', result: 'refused' },
  { row: 3, reference: '=CMD()', field: 'Card ID', value: '@SUM(A1)', problem: '+formula looking text', stage: 'check', result: 'refused' },
  { row: 4, reference: 'EMP-0004', problem: 'Line one\nline two & <three> "quoted"\u0007bell\rcarriage', stage: 'save', result: 'not_saved' },
  { row: 10, reference: 'EMP-0010', employeeName: '陈小明', value: 'x'.repeat(400), problem: 'Duplicate Card ID in this file.', stage: 'check', result: 'refused' },
]);

async function* pagesOf(all: readonly ImportProblemLine[], size: number) { for (let i = 0; i < all.length; i += size) yield all.slice(i, i + size); }
const sheetRows = (bytes: Uint8Array | Buffer, name: string) =>
  XLSX.utils.sheet_to_json<(string | number)[]>(XLSX.read(bytes, { type: 'buffer' }).Sheets[name], { header: 1, raw: true, defval: '' }) as (string | number)[][];

describe('streamed Error Log (d3ba1e9f)', () => {
  it.each(Object.keys(LOCALES))('has exactly the cells, widths and heights of the in-memory workbook (%s)', async locale => {
    const t = translator(LOCALES[locale]), columns = importProblemColumns(lines);
    const summary = [[t('summary.batch'), 'job-1'], [t('summary.file'), '=bank.csv'], [t('summary.problems'), 5]] as const;
    const buffered = importProblemWorkbook({ lines, t, columns, summary });
    const streamed = await importProblemWorkbookStreamBytes({ pages: pagesOf(lines, 2), columns, t, summary });
    readSpreadsheetArchive(streamed, { maxBytes: 5_000_000, maxExpandedBytes: 8_000_000, maxEntries: 160 });
    const a = XLSX.read(buffered, { type: 'array' }), b = XLSX.read(streamed, { type: 'buffer' });
    expect(b.SheetNames).toEqual(['Errors', 'Summary']);
    expect(b.SheetNames).toEqual(a.SheetNames);
    const errors = sheetRows(streamed, 'Errors');
    expect(errors.length).toBe(lines.length + 1);
    expect(errors).toEqual(sheetRows(buffered, 'Errors'));
    expect(sheetRows(streamed, 'Summary')).toEqual(sheetRows(buffered, 'Summary'));
    expect(errors[0]).toEqual(columns.map(c => t(`headers.${c}`)));
    // Value cell of the bank line is the hidden marker in this locale, never the value.
    expect(errors[2][columns.indexOf('value')]).toBe(t('hiddenValue'));
    // Same column widths and row heights as the in-memory file.
    const widths = (s: XLSX.WorkSheet) => (s['!cols'] ?? []).map(c => c?.width);
    expect(widths(b.Sheets.Errors).length).toBe(columns.length);
    expect(widths(b.Sheets.Errors)).toEqual(widths(a.Sheets.Errors));
    expect((b.Sheets.Errors['!rows'] ?? []).map(r => r?.hpt)).toEqual((a.Sheets.Errors['!rows'] ?? []).map(r => r?.hpt));
  });

  it('guards formulas, keeps Excel rows numeric, freezes and wraps exactly like the in-memory writer', async () => {
    const t = translator(en), columns = importProblemColumns(lines);
    const streamed = await importProblemWorkbookStreamBytes({ pages: pagesOf(lines, 100), columns, t });
    const sheet = XLSX.read(streamed, { type: 'buffer', cellFormula: true }).Sheets.Errors;
    expect(Object.keys(sheet).filter(k => !k.startsWith('!')).some(k => sheet[k].f)).toBe(false);
    const col = (c: ImportProblemColumn) => XLSX.utils.encode_col(columns.indexOf(c));
    expect(sheet[`${col('reference')}4`].v).toBe("'=CMD()");
    expect(sheet[`${col('value')}4`].v).toBe("'@SUM(A1)");
    expect(sheet[`${col('problem')}4`].v).toBe("'+formula looking text");
    expect(sheet[`${col('row')}3`]).toMatchObject({ t: 'n', v: 2 });
    expect(sheet[`${col('row')}2`].v).toBe('Whole file');
    expect(sheet[`${col('problem')}5`].v).toBe('Line one\nline two & <three> "quoted"\u0007bell\rcarriage');
    const xml = await (await JSZip.loadAsync(streamed)).file('xl/worksheets/sheet1.xml')!.async('string');
    expect(xml).toContain('state="frozen"');
    expect(xml).toMatch(/<c r="A2" s="1"/);
    expect(xml).toMatch(/<c r="B2" s="2" t="inlineStr"/);
    const styles = await (await JSZip.loadAsync(streamed)).file('xl/styles.xml')!.async('string');
    expect(styles).toContain('wrapText="1"');
  });

  it('streams 20,000 rows from a paged source without reading ahead of the consumer', async () => {
    const t = translator(en), columns: ImportProblemColumn[] = ['row', 'reference', 'field', 'value', 'problem', 'stage', 'result'];
    const total = 20_000, size = 1000;
    let pulled = 0;
    async function* source() {
      for (let page = 0; page * size < total; page++) {
        pulled++;
        yield Array.from({ length: size }, (_, i): ImportProblemLine => {
          const ordinal = page * size + i + 1;
          return { row: ordinal + 1, reference: `EMP-${ordinal}`, field: 'Bank Account No', value: HIDDEN_VALUE, problem: `Problem for data row ${ordinal}. `.repeat(4), stage: 'check', result: 'refused' };
        });
      }
    }
    const stream = importProblemWorkbookStream({ pages: source(), columns, t });
    const parts: Buffer[] = [];
    let pulledWhileStalled = -1;
    for await (const part of stream) {
      if (pulledWhileStalled < 0 && pulled >= 1) {
        // The consumer stalls once the sheet has started; the page source must not race ahead to the end meanwhile.
        await new Promise(resolve => setTimeout(resolve, 100));
        pulledWhileStalled = pulled;
      }
      parts.push(Buffer.from(part));
    }
    expect(pulledWhileStalled).toBeGreaterThan(0);
    expect(pulledWhileStalled).toBeLessThanOrEqual(total / size / 2);
    expect(pulled).toBe(total / size);
    const rows = sheetRows(Buffer.concat(parts), 'Errors');
    expect(rows.length).toBe(total + 1);
    expect(rows[1].slice(0, 2)).toEqual([2, 'EMP-1']);
    expect(rows[2500].slice(0, 2)).toEqual([2501, 'EMP-2500']);
    expect(rows[total].slice(0, 2)).toEqual([total + 1, `EMP-${total}`]);
    expect(rows.slice(1).every(r => r[3] === '(hidden)')).toBe(true);
  }, 90_000); // Not yet measured on the hosted runner; a generous bound for a 20,000-line archive.

  it('surfaces a failing page read as a stream error instead of a short, valid-looking file', async () => {
    const t = translator(en);
    async function* broken() { yield [{ row: 2, problem: 'first', stage: 'check' as const, result: 'refused' as const }]; throw new Error('storage unavailable'); }
    await expect(importProblemWorkbookStreamBytes({ pages: broken(), columns: ['row', 'problem', 'result'], t })).rejects.toThrow(/storage unavailable/);
  });
});
