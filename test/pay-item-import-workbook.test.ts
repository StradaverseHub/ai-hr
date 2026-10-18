import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import en from '../messages/en.json';
import { payItemVocabulary } from '../core/pay-component-import';
import { validatePayComponentCreateSettings } from '../core/pay-components';
import { PAY_ITEM_COLUMNS, normalizePayItemRow, matchPayItemChoice, payItemImportFileName } from '../lib/pay-component-import';
import { payComponentIdentityIssues, payCalculationStatus, payComponentReferenceStamp, PayComponentCalculationPendingError } from '../lib/pay-component-contract';
import { buildPayItemWorkbook, readPayItemWorkbook, payItemErrorWorkbook } from '../lib/pay-component-workbook';

const t = (key: string) => {
  const value = (en.payComponents as Record<string, unknown>)[key];
  if (typeof value !== 'string') throw new Error(`Missing maintenance label ${key}`);
  return value;
};
const vocabulary = payItemVocabulary(t, t);
function upload(rows: string[][], headers: readonly string[] = PAY_ITEM_COLUMNS.map(([, label]) => label)) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[], [...headers], ...rows]), 'Pay Items');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Retained reference'], ['=literal text']]), 'Other');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
const valid = ['TEST_1', 'Fictional label', '', 'Earning', '', '', '', '', '', '', '', '', '', 'N'];

describe('Pay Items workbook contract', () => {
  it('generates five ordered live-list sheets, supplied styles, C3 freeze and all 500 advisory rows', async () => {
    const bytes = await buildPayItemWorkbook(vocabulary), wb = XLSX.read(bytes, { type: 'buffer', cellFormula: true });
    expect(wb.SheetNames).toEqual(['Instructions', 'Pay Items', 'Example', 'Field Guide', 'Lists']);
    expect(wb.Sheets['Pay Items'].T3.f).toContain('COUNTIF');
    expect(wb.Sheets['Pay Items'].T502.f).toContain('A502');
    const zip = await JSZip.loadAsync(bytes), xml = await zip.file('xl/worksheets/sheet2.xml')!.async('string');
    expect(xml).toContain('topLeftCell="C3"');
    expect(xml).toContain('xSplit="2" ySplit="2"');
    expect(xml.match(/<dataValidation\s/g)).toHaveLength(17);
    expect(xml.match(/<conditionalFormatting\s/g)).toHaveLength(7);
    expect(xml.match(/<cfRule\s/g)).toHaveLength(10);
    expect(xml).toContain('sqref="T3:T502"');
    const listValues = XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Lists, { header: 1, defval: '' });
    expect(listValues.slice(1).map(row => row[0]).filter(Boolean)).toEqual(vocabulary.kind!.map(c => c.label));
    expect(listValues.slice(1).map(row => row[3]).filter(Boolean)).toEqual(vocabulary.roundingMethod!.map(c => c.label));
    expect(listValues.slice(1).map(row => row[6]).filter(Boolean)).toEqual(vocabulary.pcbExemptionCode!.map(c => c.label));
  });
  it('pastes all eight corrected examples into the data sheet without invented rates/formulas', async () => {
    const wb = XLSX.read(await buildPayItemWorkbook(vocabulary), { type: 'buffer' });
    const examples = XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Example, { header: 1, defval: '' }).slice(2, 10);
    const rows = readPayItemWorkbook(upload(examples)).map(row => normalizePayItemRow(row, vocabulary));
    expect(rows).toHaveLength(8);
    for (const row of rows) { expect(row.errors, row.input.code).toEqual([]); expect(validatePayComponentCreateSettings(row.input), row.input.code).toEqual([]); }
    expect(rows.find(row => row.input.code === 'OT150')!.input).toMatchObject({ rule: null, pendingInputKind: 'per_hour', prorates: false });
    expect(rows.find(row => row.input.code === 'BIK_CAR')!.input).toMatchObject({ kind: 'non_payable', isNonPayable: true, displayCategory: 'bik' });
    expect(rows.filter(row => ['A0030', 'A0040'].includes(row.input.code)).every(row => row.input.description?.includes('illustrative taxable'))).toBe(true);
  });
  it('uses current blank defaults while retaining an explicit Not mapped and inactive status', () => {
    const raw = [...valid]; raw[4] = 'Work it out automatically'; raw[5] = 'Inactive'; raw[18] = t('eaLineNone');
    const row = normalizePayItemRow(readPayItemWorkbook(upload([raw]))[0], vocabulary);
    expect(row.archived).toBe(true);
    expect(row.input).toMatchObject({ code: 'TEST_1', name: 'Fictional label', label: 'Fictional label', description: null,
      orpUnpaidLeave: false, orpOvertime: true, prorates: true, includedInEpf: true, includedInSocsoEis: true,
      includedInPcb: false, epfBonus2012: false, includedInHrdfBase: false, roundingMethod: 'none', rule: null,
      pendingInputKind: null, eaFormLine: null, displayCategory: null });
    expect(row.warnings).toContain('unmappedEarning');
  });
  it('normalizes reordered/case/space/asterisk headers and rejects missing or duplicate headers', () => {
    const headers = PAY_ITEM_COLUMNS.map(([, label]) => `  ${label.toUpperCase().replace(/\*/g, '')}  `);
    expect(readPayItemWorkbook(upload([valid], headers))[0].values.code).toBe('TEST_1');
    expect(() => readPayItemWorkbook(upload([valid], headers.slice(1)))).toThrow('missingHeader');
    expect(() => readPayItemWorkbook(upload([valid], [...headers, headers[0]]))).toThrow('duplicateHeader');
    const reversed = [...headers].reverse();
    expect(readPayItemWorkbook(upload([[...valid, ...Array(19 - valid.length).fill('')].reverse()], reversed))[0].values.code).toBe('TEST_1');
  });
  it('ignores only advisory/unknown formulas and rejects formulas in imported cells, without evaluating them', () => {
    const bytes = upload([valid]), wb = XLSX.read(bytes, { type: 'buffer' }), ws = wb.Sheets['Pay Items'];
    ws.T3 = { t: 'n', f: '1/0', v: 0 }; ws.U2 = { t: 's', v: 'Unknown' }; ws.U3 = { t: 'n', f: '1/0', v: 0 }; ws['!ref'] = 'A1:U3';
    expect(readPayItemWorkbook(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))[0].formulaFields).toEqual([]);
    ws.B3 = { t: 's', f: 'CONCAT("secret")', v: 'cached' };
    const row = normalizePayItemRow(readPayItemWorkbook(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))[0], vocabulary);
    expect(row.errors).toContainEqual({ field: 'label', code: 'formulaNotAllowed' });
  });
  it('collects list/identity/PCB/EPF errors and keeps per-day proration a hard refusal even when pending', () => {
    const raw = [...valid]; raw[0] = 'BAD CODE'; raw[1] = ''; raw[8] = 'Round to 0.05'; raw[9] = 'Per day'; raw[11] = 'N'; raw[12] = 'Y'; raw[13] = 'Y';
    const row = normalizePayItemRow(readPayItemWorkbook(upload([raw]))[0], vocabulary);
    const errors = [...row.errors, ...validatePayComponentCreateSettings(row.input)];
    expect(errors).toEqual(expect.arrayContaining([{ field: 'roundingMethod', code: 'invalidChoice' }, { field: 'code', code: 'invalidCode' },
      { field: 'label', code: 'required' }, { field: 'prorates', code: 'PRORATION_CONFLICT' }, { field: 'epfBonus2012', code: 'epfBonusRequiresEpf' }]));
    expect(row.warnings).toContain('calculationProrates');
  });
  it('refuses old unsupported exemptions instead of silently choosing new tax treatment', () => {
    const raw = [...valid]; raw[13] = 'Y'; raw[14] = 'Normal'; raw[15] = 'Mobile phone / telco bill';
    const row = normalizePayItemRow(readPayItemWorkbook(upload([raw]))[0], vocabulary);
    expect(row.errors).toContainEqual({ field: 'pcbExemptionCode', code: 'invalidChoice' });
    expect(row.input.pcbExemptionCode).toBeNull();
  });
  it('preserves original ZIP parts when adding a literal error-result column', async () => {
    const bytes = upload([valid]), raw = readPayItemWorkbook(bytes), row = normalizePayItemRow(raw[0], vocabulary);
    row.errors.push({ field: 'label', code: 'tooLong' });
    const before = await JSZip.loadAsync(bytes), result = await payItemErrorWorkbook(bytes, [row], code => code), after = await JSZip.loadAsync(result);
    for (const [name, entry] of Object.entries(before.files)) if (!entry.dir && name !== 'xl/worksheets/sheet1.xml') expect(await after.file(name)!.async('uint8array')).toEqual(await entry.async('uint8array'));
    const wb = XLSX.read(result, { type: 'buffer' });
    expect(wb.Sheets['Pay Items'].U2.v).toBe('Import Result');
    expect(wb.Sheets['Pay Items'].U3.v).toContain('tooLong');
    expect(wb.Sheets['Pay Items'].A3.v).toBe('TEST_1');
    expect(XLSX.read(bytes, { type: 'buffer' }).Sheets['Pay Items'].U2).toBeUndefined();
  });
  it('bounds XLSX bytes/rows, refuses non-ZIP and skips genuinely blank rows', () => {
    expect(() => readPayItemWorkbook(Buffer.alloc(5 * 1024 * 1024 + 1))).toThrow('tooLarge');
    expect(() => readPayItemWorkbook(Buffer.from('not a workbook'))).toThrow('invalidWorkbook');
    expect(readPayItemWorkbook(upload([[], valid, []]))).toHaveLength(1);
    expect(readPayItemWorkbook(upload([...Array.from({ length: 5000 }, () => []), valid]))).toHaveLength(1);
    expect(() => readPayItemWorkbook(upload(Array.from({ length: 1001 }, () => valid)))).toThrow('tooManyRows');
  });
  it('refuses ambiguous labels and enforces Unicode label/description limits without changing old identities', () => {
    expect(matchPayItemChoice('same', [{ value: 'a', label: 'Same' }, { value: 'b', label: 'same' }])).toBeUndefined();
    expect(payComponentIdentityIssues({ code: 'HYPHEN-OK', label: 'X'.repeat(60), description: 'Y'.repeat(200) })).toEqual([]);
    expect(payComponentIdentityIssues({ code: 'X'.repeat(21), label: 'X'.repeat(61), description: 'Y'.repeat(201) })).toHaveLength(3);
    expect(payComponentIdentityIssues({ code: 'old code', label: null }, { code: 'old code', label: null, description: null })).toEqual([]);
    expect(payCalculationStatus('formula')).toBe('formula_pending'); expect(payCalculationStatus('per_hour')).toBe('calculation_pending');
    expect(payItemImportFileName('../private\\fictional\n.xlsx')).toBe('fictional_.xlsx');
  });
  it('preserves prior activated-pattern reference bytes and rejects pending before producing any stamp', () => {
    const original = { code: 'OLD_OT', name: 'Existing earning', rule: null, includedInPcb: true };
    expect(JSON.stringify(payComponentReferenceStamp({ ...original, description: null, pendingInputKind: null }))).toBe(JSON.stringify(original));
    expect(JSON.stringify(payComponentReferenceStamp({ ...original, description: 'Presentation-only edit', pendingInputKind: null }))).toBe(JSON.stringify(original));
    expect(() => payComponentReferenceStamp({ ...original, pendingInputKind: 'formula' })).toThrow(PayComponentCalculationPendingError);
  });
});
