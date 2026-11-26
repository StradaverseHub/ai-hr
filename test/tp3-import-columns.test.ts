/**
 * Board 5084d02e — the Form TP3 import's columns ARE the form: one column per Section C and Section D box of the
 * payroll pack's catalogue, named the way `prepareTp3` names a box, plus the identity, employer and remarks columns.
 * The template and Sample Reference the browser builds read back through the same reader, in any language, and the
 * sample's fictional rows pass the form's own checks. No database.
 */
import { describe, expect, it } from 'vitest';
import { prepareTp3, TP3_MAX_EMPLOYERS, TP3_SECTION_C, TP3_SECTION_D, TP3_TEXT_LIMITS, Tp3Error } from '../core/tp3';
import { MY_TP1_2026_ITEMS, MY_TP3_2026_SECTION_C } from '../localization/my/statutory-tables';
import {
  parseTp3Amount, readTp3ImportRow, resolveTp3ImportHeader, tp3BoxToken, tp3HeadingToken, tp3ImportColumns, tp3ImportHeading,
  type Tp3ImportCatalogue,
} from '../lib/tp3-import-columns';
import { buildTp3ImportWorkbook, type Tp3WorkbookCopy } from '../lib/tp3-import-workbook';
import { parseCsv } from '../lib/csv';
import { workbookToCsvText } from '../lib/spreadsheet';

const catalogue: Tp3ImportCatalogue = { sectionC: TP3_SECTION_C, sectionD: TP3_SECTION_D, maxEmployers: TP3_MAX_EMPLOYERS, textLimits: TP3_TEXT_LIMITS };
const columns = tp3ImportColumns(catalogue);
const copy = (wording: (token: string) => string): Tp3WorkbookCopy => ({
  sheetImport: 'TP3 Import', sheetInstructions: 'Instructions', sheetEmployees: 'Employees',
  wording: (column) => wording(column.token), format: () => 'format', limit: () => 'limit', required: 'Required', optional: 'Optional',
  title: 'Title', intro: ['Intro'], instructionsHeader: ['Column', 'Meaning', 'Required', 'Format', 'Limit'], employeesHeader: ['Employee ID', 'Name', 'Company'],
});

describe('5084d02e Form TP3 import columns', () => {
  it('has exactly one column per box of the catalogue (MY_TP3_2026_SECTION_C and MY_TP1_2026_ITEMS), in the form\'s order', () => {
    // The pack's catalogue is Malaysia's form.
    expect(TP3_SECTION_C).toEqual(MY_TP3_2026_SECTION_C);
    expect(TP3_SECTION_D).toEqual(MY_TP1_2026_ITEMS);
    const boxes = [
      ...MY_TP3_2026_SECTION_C.flatMap((line) => (line.subItems.length ? line.subItems.map((s) => tp3BoxToken('C', line.code, s.code)) : [tp3BoxToken('C', line.code, null)])),
      ...MY_TP1_2026_ITEMS.flatMap((item) => (item.subItems.length ? item.subItems.map((s) => tp3BoxToken('D', item.code, s.code)) : [tp3BoxToken('D', item.code, null)])),
    ];
    expect(columns.filter((c) => c.kind === 'amount').map((c) => c.token)).toEqual(boxes);
    expect(boxes).toContain('C2(i)');
    expect(boxes).toContain('D16(b)');
    expect(new Set(columns.map((c) => c.token.toLowerCase())).size).toBe(columns.length);
    expect(columns.slice(0, 3 + 2 * TP3_MAX_EMPLOYERS).map((c) => c.token)).toEqual(['Employee ID', 'Assessment Year', 'Deduction Month',
      ...Array.from({ length: TP3_MAX_EMPLOYERS }, (_, i) => [`Employer ${i + 1} Name`, `Employer ${i + 1} Tax No.`]).flat()]);
    expect(columns.at(-1)?.token).toBe('Remarks');
    expect(columns.filter((c) => c.required).map((c) => c.token)).toEqual(['Employee ID', 'Assessment Year']);
  });

  it('carries each box\'s limit from the catalogue: a sub-line\'s own limit, the item\'s annual limit, and C2\'s exempt limit', () => {
    const byToken = new Map(columns.map((c) => [c.token, c]));
    for (const item of MY_TP1_2026_ITEMS) {
      if (!item.subItems.length) { expect(byToken.get(tp3BoxToken('D', item.code, null))).toMatchObject({ limit: item.limit, groupLimit: null }); continue; }
      for (const sub of item.subItems) {
        expect(byToken.get(tp3BoxToken('D', item.code, sub.code))).toMatchObject({ limit: sub.limit, groupLimit: item.perSubLimit ? null : item.limit });
      }
    }
    for (const sub of MY_TP3_2026_SECTION_C.find((line) => line.code === 'c2')!.subItems) {
      expect(byToken.get(tp3BoxToken('C', 'c2', sub.code))).toMatchObject({ exemptionLimit: sub.exemptionLimit ?? null, limit: null });
    }
  });

  it('names a refused box exactly as its column token, so a row problem names its column', () => {
    const refusal = (input: Parameters<typeof prepareTp3>[0]) => { try { prepareTp3(input); return null; } catch (e) { return e as Tp3Error; } };
    expect(refusal({ personId: 'p', assessmentYear: 2026, sectionD: { c2: { amount: 6000.01 } } })).toMatchObject({ reason: 'overAnnualLimit', field: 'D2', detail: { limit: '6,000.00' } });
    expect(refusal({ personId: 'p', assessmentYear: 2026, sectionD: { c1: { subItems: { c: 1000.01 } } } })).toMatchObject({ reason: 'overLimit', field: 'D1(c)' });
    expect(refusal({ personId: 'p', assessmentYear: 2026, sectionC: { c2: { subItems: { i: -1 } } } })).toMatchObject({ reason: 'amountNegative', field: 'C2(i)' });
    expect(refusal({ personId: 'p', assessmentYear: 2026, sectionC: { c1: { amount: 100 }, c3: { amount: 500 } } })).toMatchObject({ reason: 'sectionCNegative', field: 'C1' });
    expect(refusal({ personId: 'p', assessmentYear: 2026, previousEmployers: [{ name: '', tin: 'C1' }] })).toMatchObject({ reason: 'employerTinNoName', field: 'employer1Name' });
    expect(refusal({ personId: 'p', assessmentYear: 1999 })).toMatchObject({ reason: 'yearInvalid', field: 'assessmentYear' });
    for (const token of ['D2', 'D1(c)', 'C2(i)', 'C1']) expect(columns.some((c) => c.token === token)).toBe(true);
  });

  it('reads headings by their token in any language, refuses an unknown or doubled column, and needs the two required ones', () => {
    const header = columns.map((c) => tp3ImportHeading(c, c.kind === 'amount' ? `Kotak ${c.token} dalam bahasa lain` : 'Lajur'));
    expect(header[0]).toBe('Employee ID * · Lajur');
    expect(tp3HeadingToken('  C2(i)   ·  anything ')).toBe('c2(i)');
    const resolved = resolveTp3ImportHeader(header, columns);
    expect('byIndex' in resolved && resolved.byIndex.map((c) => c?.key)).toEqual(columns.map((c) => c.key));
    expect(resolveTp3ImportHeader(['Employee ID', 'Assessment Year', 'C99'], columns)).toEqual({ fileError: 'unknownColumn', detail: { column: 'C99' } });
    expect(resolveTp3ImportHeader(['Employee ID', 'Assessment Year', 'C1', 'c1 · again'], columns)).toEqual({ fileError: 'duplicateColumn', detail: { column: 'C1' } });
    expect(resolveTp3ImportHeader(['Employee ID', 'C1'], columns)).toEqual({ fileError: 'missingColumn', detail: { column: 'Assessment Year' } });
    // Blank header cells (trailing empty columns) are ignored.
    expect('byIndex' in resolveTp3ImportHeader(['Employee ID', 'Assessment Year', ''], columns)).toBe(true);
  });

  it('reads amounts as a spreadsheet holds them and refuses anything that is not a number', () => {
    expect(parseTp3Amount('')).toBeUndefined();
    expect(parseTp3Amount('2640')).toBe(2640);
    expect(parseTp3Amount('2640.5')).toBe(2640.5);
    expect(parseTp3Amount('RM 24,000.00')).toBe(24000);
    expect(parseTp3Amount('-5')).toBe(-5);
    for (const bad of ['abc', '1,00', '12.3.4', '1 000', '1e5']) expect(parseTp3Amount(bad)).toBe('invalid');
  });

  it('builds the template and the Sample Reference that read back through the same reader; the sample passes the form\'s checks', async () => {
    const template = await buildTp3ImportWorkbook(catalogue, copy((token) => `Wording of ${token}`), { kind: 'template', employees: [['E001', 'Fictional Person', 'Fictional Company Sdn Bhd']] });
    const [templateHeader, ...templateRows] = parseCsv(await workbookToCsvText(template));
    expect(templateRows).toEqual([]);
    const resolved = resolveTp3ImportHeader(templateHeader, columns);
    expect('byIndex' in resolved && resolved.byIndex.map((c) => c?.token)).toEqual(columns.map((c) => c.token));

    const sample = await buildTp3ImportWorkbook(catalogue, copy(() => ''), { kind: 'sample' });
    const [sampleHeader, ...sampleRows] = parseCsv(await workbookToCsvText(sample));
    const sampleColumns = resolveTp3ImportHeader(sampleHeader, columns);
    if (!('byIndex' in sampleColumns)) throw new Error('sample header unreadable');
    expect(sampleRows.length).toBeGreaterThanOrEqual(3);
    for (const cells of sampleRows) {
      const read = readTp3ImportRow(cells, sampleColumns.byIndex, TP3_MAX_EMPLOYERS);
      expect(read.problem).toBeNull();
      expect(() => prepareTp3({ ...read.input!, personId: 'fictional' })).not.toThrow();
    }
  });
});
