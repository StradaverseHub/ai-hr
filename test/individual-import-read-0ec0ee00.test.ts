/**
 * Board 0ec0ee00 — an Individual Transaction upload with a handful of rows was refused as "too large" because the
 * background reader measured every sheet of the template, including the Employees reference sheet (one row per employee
 * in scope). The reader now measures and decodes only the transaction sheet, by the rows that hold a value. Fictional data.
 */
import * as XLSX from 'xlsx';
import {describe, expect, it} from 'vitest';
import {buildIndividualTxnWorkbook} from '../lib/individual-txn-import-workbook';
import {readIndividualImportWorkbook} from '../lib/individual-import-read';
import {parseIndividualImport} from '../lib/individual-txn-import-contract';
import {INDIVIDUAL_IMPORT_MAX_BYTES, INDIVIDUAL_IMPORT_MAX_RECORDS} from '../lib/individual-import-job';
import type {TxnTemplateReference} from '../lib/import-template-xlsx';

const headings = {employees: 'Employees', employeeId: 'Employee ID', employeeName: 'Employee name', company: 'Company', department: 'Department',
  payItems: 'Pay Items', payItemCode: 'Pay Item code', payItemName: 'Pay Item name', payItemKind: 'Kind', payItemInput: 'Input',
  cycles: 'Pay Cycles', cycleCode: 'Code', cycleLabel: 'Label', kinds: 'Kinds', kindCode: 'Code', kindLabel: 'Label', example: 'Example', note: 'Note'};

/** The real template for `employees` reference employees, with `filled` transaction rows typed into it. */
async function workbook(employees: number, filled: number, opts: {extraBlankFormattedRows?: number} = {}) {
  const reference: TxnTemplateReference = {headings, kinds: [], cycles: [],
    employees: Array.from({length: employees}, (_, i) => ({code: String(200000 + i), name: `Fictional Person ${i}`, company: 'Fictional Sdn Bhd', department: 'Ops'})),
    payItems: [{code: 'OT', name: 'Overtime', kind: 'allowance', input: 'Amount'}]};
  const bytes = await buildIndividualTxnWorkbook('monthly', reference, [{name: 'Monthly', company: 'Fictional Sdn Bhd', code: 'M1'}], 'Fill in the sheet');
  const wb = XLSX.read(bytes, {type: 'array'});
  const ws = wb.Sheets[wb.SheetNames[0]];
  const header = (XLSX.utils.sheet_to_json(ws, {header: 1})[0] as string[]);
  for (let r = 1; r <= filled; r++) header.forEach((caption, c) => {
    ws[XLSX.utils.encode_cell({r, c})] = {t: 's', v: c === 0 ? '200001' : /month/i.test(caption) ? '2026-11' : /amount/i.test(caption) ? '10.00' : 'x'};
  });
  const range = XLSX.utils.decode_range(ws['!ref']!);
  range.e.r = Math.max(range.e.r, filled + (opts.extraBlankFormattedRows ?? 0));
  ws['!ref'] = XLSX.utils.encode_range(range);
  return new Uint8Array(XLSX.write(wb, {type: 'array', bookType: 'xlsx'}));
}
const code = (p: Promise<unknown>) => p.then(() => 'accepted', (e: {code?: string}) => e.code ?? 'unknown');

describe('Individual Transaction upload reader (0ec0ee00)', () => {
  it('accepts five transactions whatever the size of the Employees reference sheet', async () => {
    for (const employees of [50, 2_100, 2_500, 20_000]) {
      const text = await readIndividualImportWorkbook(await workbook(employees, 5), 'individual-monthly-transactions.xlsx', 'monthly');
      // Only the transaction sheet is decoded: a header and five records, none of the reference employees.
      expect(text.trim().split('\n')).toHaveLength(6);
      expect(text).not.toContain('Fictional Person');
      expect(() => parseIndividualImport(text, 'monthly')).not.toThrow(/fileTooLarge|tooManyRows|contentTooLarge/);
    }
  });

  it('counts only filled rows, not the template’s pre-formatted or Excel-enlarged blank rows', async () => {
    const text = await readIndividualImportWorkbook(await workbook(10, 5, {extraBlankFormattedRows: 30_000}), 't.xlsx', 'monthly');
    expect(text.trim().split('\n')).toHaveLength(6);
  });

  it('accepts exactly the record limit and refuses one more as too many rows, not too large', async () => {
    expect(await code(readIndividualImportWorkbook(await workbook(10, INDIVIDUAL_IMPORT_MAX_RECORDS), 't.xlsx', 'monthly'))).toBe('accepted');
    expect(await code(readIndividualImportWorkbook(await workbook(10, INDIVIDUAL_IMPORT_MAX_RECORDS + 1), 't.xlsx', 'monthly'))).toBe('tooManyRows');
    // Stage 2 raised the limit to 10,000 rows: two full workbooks are built and read here (not yet measured on the gate).
  }, 120_000);

  it('keeps a separate refusal for each cause', async () => {
    expect(await code(readIndividualImportWorkbook(new Uint8Array(INDIVIDUAL_IMPORT_MAX_BYTES + 1), 't.xlsx', 'monthly'))).toBe('fileTooLarge');
    expect(await code(readIndividualImportWorkbook(new Uint8Array([1, 2, 3]), 't.xlsx', 'monthly'))).toBe('fileReadError');
    expect(await code(readIndividualImportWorkbook(await workbook(10, 5), 't.csv', 'monthly'))).toBe('invalidFormat');
    expect(await code(readIndividualImportWorkbook(await workbook(10, 0), 't.xlsx', 'monthly'))).not.toBe('fileTooLarge');
  });
});
