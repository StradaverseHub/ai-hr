import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import * as XLSX from 'xlsx';
import { systemLabelErrorWorkbook } from '../lib/system-label-workbook';
import { readSpreadsheetArchive } from '../lib/spreadsheet-archive';
import type { LabelImportPreviewRow } from '../lib/system-label-definition';
import en from '../messages/en.json';

const error = (row: number, code: string, outcome: 'error' | 'skip' | 'add' = 'error', extra: Partial<LabelImportPreviewRow> = {}): LabelImportPreviewRow => ({
  sheet: 'department', row, values: { Code: code }, before: null, after: {}, outcome, message: 'SERVER_ENGLISH',
  reason: outcome === 'skip' ? 'duplicate' : 'existing', reasonDetail: outcome === 'skip' ? 'duplicate' : 'existing', reasonColumn: 'Code', ...extra,
});
const h = en.importProblems.headers, w = en.labelsImportWizard;
/** Board c074c6b8: the Error Log columns (shared writer) for System Labels rows. */
const HEADERS = [h.row, h.category, h.reference, h.field, h.value, h.problem, h.correction, h.stage, h.result];
describe('Labels error workbook readability', () => {
  it('sizes the columns, serializes the referenced wrap/top styles and gives problems row space', async () => {
    const code = 'B22_015_HIDDEN_INACTIVE';
    const bytes = systemLabelErrorWorkbook([error(6, code)]), zip = await JSZip.loadAsync(bytes);
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
    const width = (column: number) => columns.find(c => c.min <= column && c.max >= column)!.width;
    expect(width(HEADERS.indexOf(h.problem) + 1)).toBeGreaterThan(55);
    expect(width(HEADERS.indexOf(h.correction) + 1)).toBeGreaterThan(40);
    expect(width(HEADERS.indexOf(h.reference) + 1)).toBeGreaterThan(width(HEADERS.indexOf(h.row) + 1));
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
    for (const address of ['C2', 'F2', 'G2']) expect(formats[cells.get(address)!]).toMatchObject({ numFmtId: '49', wrapText: '1', vertical: 'top' });
    expect(formats[cells.get('A2')!]).toMatchObject({ numFmtId: '0', wrapText: '1', vertical: 'top' });
    expect(xml).toContain('state="frozen"');
    const wb = XLSX.read(bytes, { type: 'array' });
    expect(wb.SheetNames).toEqual(['Errors']);
    expect(XLSX.utils.sheet_to_json(wb.Sheets.Errors, { header: 1 })).toEqual([HEADERS,
      [6, en.admin.systemLabels.category.department, code, 'Code', code, w.problem.existing, w.fix.existing, en.importProblems.stage.check, en.importProblems.result.refused]]);
  });
  it('bounds a long row height without truncating its problem text', async () => {
    const value = 'Fictional line\n'.repeat(100);
    const bytes = systemLabelErrorWorkbook([error(9, 'LONG_VALUE', 'error', { values: { Code: 'LONG_VALUE', Status: value }, reason: 'invalidStatus', reasonDetail: 'invalidStatus', reasonColumn: 'Status' })]);
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
    expect(wb.Sheets.Errors.F2.v).toBe(w.problem.invalidStatus);
    // The entered value is bounded for the screen and the file alike (shared IMPORT_PROBLEM_VALUE_MAX).
    expect([...String(wb.Sheets.Errors.E2.v)].length).toBe(200);
  });
  it('retains literal formula safety, exact Excel rows and exclusion of successfully imported rows', () => {
    const bytes = systemLabelErrorWorkbook([error(3, 'IMPORTED', 'add'), error(4, '=HYPERLINK("bad")'), error(6, '000022', 'skip')]);
    const wb = XLSX.read(bytes, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets.Errors, { header: 1 });
    expect(rows.map(r => r.slice(0, 5))).toEqual([
      HEADERS.slice(0, 5),
      [4, en.admin.systemLabels.category.department, "'=HYPERLINK(\"bad\")", 'Code', "'=HYPERLINK(\"bad\")"],
      [6, en.admin.systemLabels.category.department, '000022', 'Code', '000022'],
    ]);
    expect(rows[2][5]).toBe(w.problem.duplicate);expect(rows[2][8]).toBe(en.importProblems.result.skipped);
    expect(Object.entries(wb.Sheets.Errors).filter(([address]) => !address.startsWith('!')).some(([, cell]) => cell.f)).toBe(false);
  });
});
