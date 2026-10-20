import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import * as XLSX from 'xlsx';
import { systemLabelErrorWorkbook } from '../lib/system-label-workbook';
import { readSpreadsheetArchive } from '../lib/spreadsheet-archive';
import type { LabelImportPreviewRow } from '../lib/system-label-definition';

const error = (row: number, code: string, message: string, outcome: 'error' | 'skip' | 'add' = 'error'): LabelImportPreviewRow => ({
  sheet: 'department', row, values: { Code: code }, before: null, after: {}, outcome, message,
});
describe('Labels error workbook readability', () => {
  it('sizes identifiers and messages, serializes the referenced wrap/top styles and gives messages row space', async () => {
    const code = 'B22_015_HIDDEN_INACTIVE', message = 'This code already exists in this category. No existing record will be changed. Edit it on the System Labels page. '.repeat(3);
    const bytes = systemLabelErrorWorkbook([error(6, code, message)]), zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string'), styles = await zip.file('xl/styles.xml')!.async('string');
    // Strict central-directory admission also detects duplicate paths from a mistaken CFB append.
    const archive = readSpreadsheetArchive(Buffer.from(bytes), { maxBytes: 5_000_000, maxExpandedBytes: 8_000_000, maxEntries: 160 });
    expect(archive.parts.get('xl/styles.xml')!.toString('utf8')).toBe(styles);
    const columns: { min: number; max: number; width: number }[] = [], cells = new Map<string, number>(), heights = new Map<number, number>();
    const parser = new SaxesParser({ xmlns: true });
    parser.on('opentag', tag => {
      const attrs = Object.fromEntries(Object.values(tag.attributes).map(a => [a.local, a.value]));
      if (tag.local === 'col') columns.push({ min: Number(attrs.min), max: Number(attrs.max), width: Number(attrs.width) });
      if (tag.local === 'c') cells.set(attrs.r, Number(attrs.s));
      if (tag.local === 'row') heights.set(Number(attrs.r), Number(attrs.ht));
    }); parser.write(xml).close();
    expect(columns.find(column => column.min <= 3 && column.max >= 3)!.width).toBeGreaterThan(code.length);
    expect(columns.find(column => column.min <= 5 && column.max >= 5)!.width).toBeGreaterThan(60);
    expect(heights.get(2)).toBeGreaterThan(heights.get(1)!);
    const formats: { numFmtId: string; wrapText?: string; vertical?: string }[] = []; let inCellXfs = false;
    const formatParser = new SaxesParser({ xmlns: true });
    formatParser.on('opentag', tag => {
      const attrs = Object.fromEntries(Object.values(tag.attributes).map(a => [a.local, a.value]));
      if (tag.local === 'cellXfs') inCellXfs = true;
      if (inCellXfs && tag.local === 'xf') formats.push({ numFmtId: attrs.numFmtId });
      if (inCellXfs && tag.local === 'alignment') Object.assign(formats[formats.length - 1], { wrapText: attrs.wrapText, vertical: attrs.vertical });
    });
    formatParser.on('closetag', tag => { if (tag.local === 'cellXfs') inCellXfs = false; });
    formatParser.write(styles).close();
    for (const address of ['C2', 'E2']) expect(formats[cells.get(address)!]).toMatchObject({ numFmtId: '49', wrapText: '1', vertical: 'top' });
    expect(formats[cells.get('B2')!]).toMatchObject({ numFmtId: '0', wrapText: '1', vertical: 'top' });
    const wb = XLSX.read(bytes, { type: 'array' });
    expect(wb.SheetNames).toEqual(['Errors']);
    expect(XLSX.utils.sheet_to_json(wb.Sheets.Errors, { header: 1 })).toEqual([['Worksheet', 'Row', 'Code', 'Result', 'Message'], ['department', 6, code, 'error', message]]);
  });
  it('bounds a multiline error row height without truncating its message', async () => {
    const message = 'Fictional line\n'.repeat(100), bytes = systemLabelErrorWorkbook([error(9, 'LONG_MESSAGE', message)]);
    const zip = await JSZip.loadAsync(bytes), xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    let height = 0;
    const parser = new SaxesParser({ xmlns: true });
    parser.on('opentag', tag => {
      if (tag.local !== 'row') return;
      const attrs = Object.fromEntries(Object.values(tag.attributes).map(a => [a.local, a.value]));
      if (attrs.r === '2') height = Number(attrs.ht);
    }); parser.write(xml).close();
    expect(height).toBeGreaterThanOrEqual(32); expect(height).toBeLessThanOrEqual(240);
    const wb = XLSX.read(bytes, { type: 'array' });
    expect(wb.Sheets.Errors.E2.v).toBe(message);
  });
  it('retains literal formula safety, exact source rows and exclusion of successfully imported rows', () => {
    const bytes = systemLabelErrorWorkbook([error(3, 'IMPORTED', 'Added', 'add'), error(4, '=HYPERLINK("bad")', '=1+1'), error(6, '000022', '@hidden', 'skip')]);
    const wb = XLSX.read(bytes, { type: 'array' });
    expect(XLSX.utils.sheet_to_json(wb.Sheets.Errors, { header: 1 })).toEqual([
      ['Worksheet', 'Row', 'Code', 'Result', 'Message'],
      ['department', 4, "'=HYPERLINK(\"bad\")", 'error', "'=1+1"],
      ['department', 6, '000022', 'skip', "'@hidden"],
    ]);
    expect(Object.entries(wb.Sheets.Errors).filter(([address]) => !address.startsWith('!')).some(([, cell]) => cell.f)).toBe(false);
  });
});
