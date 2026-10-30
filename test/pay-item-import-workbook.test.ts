import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import { payItemVocabulary } from '../core/pay-component-import';
import { PAY_RULE_KINDS } from '../core/pay-rule';
import { validatePayComponentCreateSettings } from '../core/pay-components';
import { PAY_ITEM_COLUMNS, normalizePayItemRow, matchPayItemChoice, payItemImportFileName } from '../lib/pay-component-import';
import { PENDING_PAY_INPUT_KINDS, payComponentIdentityIssues, payCalculationStatus, payComponentReferenceStamp, PayComponentCalculationPendingError } from '../lib/pay-component-contract';
import { buildPayItemWorkbook, readPayItemWorkbook, payItemErrorWorkbook, payItemSampleRows, PAY_ITEM_TEMPLATE_COLUMNS, type PayItemCatalogueRow } from '../lib/pay-component-workbook';

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

function catalogueRow(code: string, patch: Partial<PayItemCatalogueRow> = {}): PayItemCatalogueRow {
  return { code, label: `Actual ${code}`, description: null, kind: 'allowance', displayCategory: null,
    archivedAt: null, pendingInputKind: null, rule: null, orpUnpaidLeave: false, orpOvertime: true,
    roundingMethod: 'none', prorates: true, includedInEpf: true, epfBonus2012: false,
    includedInPcb: true, pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE',
    includedInSocsoEis: true, includedInHrdfBase: false, eaFormLine: 'EA_B1A', ...patch };
}

describe('Pay Items workbook contract', () => {
  it('represents every workbook-supported calculated kind; reusable formulas require native tested-ID linking', () => {
    expect([...PENDING_PAY_INPUT_KINDS]).toEqual(PAY_RULE_KINDS.filter(kind => kind !== 'fixed'&&kind!=='formula_builder'));
  });
  it('refuses reusable Formula Builder imports that cannot bind a tested Formula ID',()=>{const raw=[...valid];raw[PAY_ITEM_COLUMNS.findIndex(([field])=>field==='inputKind')]='formula_builder';const row=normalizePayItemRow(readPayItemWorkbook(upload([raw]))[0],vocabulary);expect(row.errors).toContainEqual({field:'inputKind',code:'invalidChoice'});expect(row.input.pendingInputKind).toBeNull();expect(vocabulary.inputKind?.some(choice=>choice.value==='formula_builder')).toBe(false);});
  it('generates exactly three sheets, all current headers, and a blank entry sheet with no invented samples', async () => {
    const bytes = await buildPayItemWorkbook(vocabulary), wb = XLSX.read(bytes, { type: 'buffer', cellFormula: true });
    expect(wb.SheetNames).toEqual(['Instructions', 'Pay Items', 'Sample']);
    const headers = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Pay Items'], { header: 1, defval: '' })[1];
    expect(headers.slice(0, 7)).toEqual(['Pay Code *', 'Label *', 'Description', 'Category *', 'Input Type', 'EA Form Line', 'Status']);
    expect(headers).toHaveLength(PAY_ITEM_COLUMNS.length);
    expect(new Set(headers)).toEqual(new Set(PAY_ITEM_COLUMNS.map(([, header]) => header)));
    expect(() => readPayItemWorkbook(bytes)).toThrow('emptyWorkbook');
    expect(wb.Sheets.Sample.A1.v).toBe('SAMPLE ONLY – NOT UPLOADED');
    expect(XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Instructions, { header: 1 }).flat().join(' ')).toContain('Sample contains 0 actual catalogue record(s)');
    for (const name of ['Pay Items', 'Sample']) expect(Object.values(wb.Sheets[name]).some(cell => cell?.f)).toBe(false);
    const zip = await JSZip.loadAsync(bytes);
    const entry = await zip.file('xl/worksheets/sheet2.xml')!.async('string');
    const sample = await zip.file('xl/worksheets/sheet3.xml')!.async('string');
    expect(entry).toContain('topLeftCell="C3"');
    expect(entry).not.toContain('sheetProtection');
    expect(sample).toContain('<sheetProtection sheet="1"');
    expect(sample).not.toMatch(/password=|algorithmName=/);
    const styles = await zip.file('xl/styles.xml')!.async('string');
    const sampleCell = /<c\b[^>]*r="B3"[^>]*s="(\d+)"/.exec(sample);
    expect(sampleCell).not.toBeNull();
    const cellStyles = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)![1].match(/<xf\b[^>]*>[\s\S]*?<\/xf>/g)!;
    const referenceStyle = cellStyles[Number(sampleCell![1])];
    expect(referenceStyle).toContain('locked="true"');
    expect(referenceStyle).toContain('applyProtection="1"');
    expect(referenceStyle).toContain('wrapText="1"');
    const fillIndex = Number(/fillId="(\d+)"/.exec(referenceStyle)![1]);
    const fills = /<fills[^>]*>([\s\S]*?)<\/fills>/.exec(styles)![1].match(/<fill>[\s\S]*?<\/fill>/g)!;
    expect(fills[fillIndex]).toContain('rgb="FFF3F4F6"');
  });
  it('uses only actual catalogue facts, prefers existing familiar codes, and falls back deterministically without changing input', () => {
    const catalogue = [catalogueRow('Z'), catalogueRow('BASIC'), catalogueRow('A0027', { archivedAt: new Date(), includedInPcb: false, pcbRemunerationType: null, pcbExemptionCode: null }), catalogueRow('A0020', { label: '=literal catalogue label', pendingInputKind: 'per_hour', prorates: false })];
    const before = catalogue.map(row => row.code);
    const rows = payItemSampleRows(catalogue, vocabulary);
    expect(rows.map(row => row[0])).toEqual(['A0020', 'A0027', 'BASIC']);
    const at = (code: string, field: string) => rows.find(row => row[0] === code)![PAY_ITEM_TEMPLATE_COLUMNS.findIndex(([key]) => key === field)];
    expect(at('A0020', 'label')).toBe('=literal catalogue label');
    expect(at('A0020', 'inputKind')).toBe(t('inputType_per_hour'));
    expect(at('A0020', 'prorates')).toBe('N');
    expect(at('A0027', 'archived')).toBe(t('statusInactive'));
    expect(at('A0027', 'includedInPcb')).toBe('N');
    expect(at('A0027', 'pcbExemptionCode')).toBe('');
    expect(catalogue.map(row => row.code)).toEqual(before);
    expect(payItemSampleRows([catalogueRow('Z'), catalogueRow('A')], vocabulary).map(row => row[0])).toEqual(['A', 'Z']);
    expect(payItemSampleRows([], vocabulary)).toEqual([]);
  });
  it('uses exact current Instructions ranges and nonblocking dropdowns, without a hidden fourth sheet', async () => {
    const bytes = await buildPayItemWorkbook(vocabulary), wb = XLSX.read(bytes, { type: 'buffer' });
    const zip = await JSZip.loadAsync(bytes), xml = await zip.file('xl/worksheets/sheet2.xml')!.async('string');
    const validations = [...xml.matchAll(/<dataValidation\b([^>]*)>([\s\S]*?)<\/dataValidation>/g)];
    expect(validations).toHaveLength(Object.values(vocabulary).filter(values => values.length).length);
    for (const [field, choices] of Object.entries(vocabulary)) {
      const column = XLSX.utils.encode_col(PAY_ITEM_TEMPLATE_COLUMNS.findIndex(([key]) => key === field));
      const validation = validations.filter(([, attrs]) => attrs.includes(`sqref="${column}3:${column}502"`));
      expect(validation).toHaveLength(1);
      expect(validation[0][1]).toContain('showErrorMessage="0"');
      expect(validation[0][1]).not.toContain('errorStyle="stop"');
      const range = /Instructions!\$B\$(\d+):\$B\$(\d+)/.exec(validation[0][2]);
      expect(range).not.toBeNull();
      const values = Array.from({ length: Number(range![2]) - Number(range![1]) + 1 }, (_, i) => wb.Sheets.Instructions[`B${Number(range![1]) + i}`].v);
      expect(values).toEqual(choices.map(choice => choice.label));
      expect(validation[0][2]).not.toMatch(/<[^>]+>(?:<[^>]+>)/);
    }
  });
  it.each([['en', en], ['ms', ms], ['zh', zh], ['ta', ta], ['th', th], ['vi', vi]] as const)('uses the current %s maintenance vocabulary for choices and actual sample values', async (_locale, messages) => {
    const local = (key: string) => {
      const value = (messages.payComponents as Record<string, unknown>)[key];
      if (typeof value !== 'string') throw new Error(`Missing locale field ${key}`);
      return value;
    };
    const vocab = payItemVocabulary(local, t);
    const bytes = await buildPayItemWorkbook(vocab, [catalogueRow('REAL')]);
    const wb = XLSX.read(bytes, { type: 'buffer' });
    expect(wb.SheetNames).toEqual(['Instructions', 'Pay Items', 'Sample']);
    expect(wb.Sheets.Sample.D3.v).toBe(local('kind_allowance'));
    expect(wb.Sheets.Sample.E3.v).toBe(local('inputType_fixed'));
    expect(wb.Sheets.Sample.G3.v).toBe(local('statusActive'));
    expect(() => readPayItemWorkbook(bytes)).toThrow('emptyWorkbook');
  });
  it('never imports Sample, including literal formula-like catalogue labels, and accepts new and legacy header orders', async () => {
    const bytes = await buildPayItemWorkbook(vocabulary, [catalogueRow('A0020', { label: '=1+1' })]);
    const wb = XLSX.read(bytes, { type: 'buffer', cellFormula: true });
    expect(wb.Sheets.Sample.B3).toMatchObject({ t: 's', v: '=1+1' });
    expect(wb.Sheets.Sample.B3.f).toBeUndefined();
    expect(() => readPayItemWorkbook(bytes)).toThrow('emptyWorkbook');
    const canonical = Object.fromEntries(PAY_ITEM_COLUMNS.map(([field], index) => [field, valid[index] ?? '']));
    XLSX.utils.sheet_add_aoa(wb.Sheets['Pay Items'], [PAY_ITEM_TEMPLATE_COLUMNS.map(([field]) => canonical[field])], { origin: 'A3' });
    wb.Sheets.Sample.B3 = { t: 'n', f: '1+1', v: 2 }; // Reference sheet must never become an upload owner.
    const actual = readPayItemWorkbook(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    expect(actual).toHaveLength(1);
    expect(actual[0].values).toEqual(readPayItemWorkbook(upload([valid]))[0].values);
    expect(actual[0].formulaFields).toEqual([]);
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
  it('refuses explicit workbook PCB fields when PCB is N rather than clearing the imported choices', () => {
    const raw = [...valid]; raw[14] = 'normal'; raw[15] = 'PCB_TAXABLE';
    const row = normalizePayItemRow(readPayItemWorkbook(upload([raw]))[0], vocabulary);
    expect(row.input).toMatchObject({ includedInPcb: false, pcbRemunerationType: 'normal', pcbExemptionCode: 'PCB_TAXABLE' });
    expect(validatePayComponentCreateSettings(row.input)).toContainEqual({ field: 'pcbRemunerationType', code: 'pcbFieldsRequirePcb' });
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
