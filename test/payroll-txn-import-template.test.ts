/**
 * 5c65367d — the Fixed / Individual Transaction import TEMPLATES. Pure and hermetic (no DB).
 *
 * THE ONE THING THAT SILENTLY BREAKS AN IMPORT, and the reason this file exists: `parseCsvRecords`
 * normalises a header with `h.trim().toLowerCase().replace(/\s+/g, '_')`, and that is the ONLY thing
 * making "Pay Item Code" and `pay_item_code` the same string. A prettier heading that stopped
 * normalising to its key would drop the whole column — every row would then fail on a missing mandatory
 * field with no error naming the header, which is exactly the "row 12 is invalid" report this item
 * exists to stop. So the round-trip is asserted for every column of both contracts, not trusted.
 *
 * SHEET ORDER IS ALSO ASSERTED, and it is load-bearing rather than cosmetic: `workbookToCsvText` reads
 * `wb.SheetNames[0]`, so the blank fill-in sheet must be first. If a reference sheet ever moved in front
 * of it, uploads would start reading the Employees list as transaction data.
 *
 * READING BACK THE TEXT FORMAT NEEDS `cellStyles: true`. The `@` number format lives in the workbook's
 * STYLE table, not on the cell record, so a plain `XLSX.read` reports `z` as undefined on a perfectly
 * correct file. Auditing the leading-zero guard without that flag concludes it is broken when it is not.
 */
import { describe, expect, it } from 'vitest';

import { parseCsvRecords } from '../lib/csv';
import {
  FIXED_TXN_COLUMNS,
  FIXED_TXN_HEADERS,
  FIXED_TXN_SAMPLE_ROWS,
  INDIVIDUAL_TXN_COLUMNS,
  INDIVIDUAL_TXN_HEADERS,
  INDIVIDUAL_TXN_SAMPLE_ROWS,
  TXN_IMPORT_SHEETS,
  TXN_IMPORT_TEXT_COLUMN_INDEXES,
  fixedWindowsOverlap,
  isIsoDate,
  normaliseHeader,
  parseAmountCell,
} from '../lib/payroll-txn-import-schema';
import { buildTxnImportWorkbook, type TxnTemplateReference } from '../lib/import-template-xlsx';

const REFERENCE: TxnTemplateReference = {
  headings: {
    employees: 'Employees you may import for',
    employeeId: 'Employee ID',
    employeeName: 'Employee name',
    company: 'Company',
    department: 'Department',
    payItems: 'Pay items the import accepts',
    payItemCode: 'Pay item code',
    payItemName: 'Pay item',
    payItemKind: 'Type',
    payItemInput: 'Input required',
    cycles: 'Payroll cycles the import accepts',
    cycleCode: 'Payroll cycle',
    cycleLabel: 'Description',
    kinds: 'Transaction kinds the import accepts',
    kindCode: 'Kind',
    kindLabel: 'Description',
    example: 'Example',
    note: 'Fill in the FIRST sheet.',
  },
  employees: [
    { code: 'X000001', name: 'Irwin Law', company: 'Demo Group Holdings Bhd', department: 'Operations' },
    { code: '0012345', name: 'Leading Zero', company: 'Demo Group Holdings Bhd', department: 'Finance' },
  ],
  payItems: [
    { code: 'OT1_5', name: 'Overtime 1.5', kind: 'allowance', input: 'hours' },
    { code: 'HANDPHONE', name: 'Handphone Allowance', kind: 'allowance', input: '' },
  ],
  cycles: [
    { code: 'regular', label: 'Regular' },
    { code: 'bonus', label: 'Bonus' },
  ],
  kinds: [
    { code: 'earning', label: 'Earning' },
    { code: 'overtime', label: 'Overtime' },
  ],
};

describe('5c65367d · the header round-trip', () => {
  it('Fixed Transaction headings normalise to the contract keys, in order', () => {
    expect(FIXED_TXN_HEADERS.map(normaliseHeader)).toEqual([...FIXED_TXN_COLUMNS]);
    // And through the REAL parser on a real header row, including CRLF, which is what an uploaded file
    // actually looks like after workbookToCsvText.
    const { headers } = parseCsvRecords(`${FIXED_TXN_HEADERS.join(',')}\r\nX000001,A,HANDPHONE,B,100,regular,2026-08-01,,\r\n`);
    expect(headers).toEqual([...FIXED_TXN_COLUMNS]);
  });

  it('Individual Transaction headings normalise to the contract keys, in order', () => {
    expect(INDIVIDUAL_TXN_HEADERS.map(normaliseHeader)).toEqual([...INDIVIDUAL_TXN_COLUMNS]);
    const { headers } = parseCsvRecords(
      // 0db616f3 — nine data cells now: Payroll Cycle sits between Transaction Date and Notes. A blank
      // one means the month's regular run, which is what every file written to the old template says.
      `${INDIVIDUAL_TXN_HEADERS.join(',')}\r\nX000001,A,OT1_5,B,overtime,5,,2026-08-05,,\r\n`,
    );
    expect(headers).toEqual([...INDIVIDUAL_TXN_COLUMNS]);
  });

  it('the sample rows have exactly one cell per column', () => {
    for (const r of FIXED_TXN_SAMPLE_ROWS) expect(r).toHaveLength(FIXED_TXN_COLUMNS.length);
    for (const r of INDIVIDUAL_TXN_SAMPLE_ROWS) expect(r).toHaveLength(INDIVIDUAL_TXN_COLUMNS.length);
  });
});

describe('5c65367d · the cell readers', () => {
  it('reads the money HR actually types, separators and currency prefix included', () => {
    expect(parseAmountCell('100')).toBe(100);
    expect(parseAmountCell('1,500.50')).toBe(1500.5);
    expect(parseAmountCell('RM 250')).toBe(250);
    expect(parseAmountCell(' 250 ')).toBe(250);
    expect(parseAmountCell('-5')).toBe(-5); // read, then refused by the amount>0 rule
  });

  it('refuses anything that is not a number, rather than reading it as zero', () => {
    expect(parseAmountCell('')).toBeNull();
    expect(parseAmountCell('n/a')).toBeNull();
    expect(parseAmountCell('one hundred')).toBeNull();
  });

  it('accepts only a real ISO date', () => {
    expect(isIsoDate('2026-08-01')).toBe(true);
    expect(isIsoDate('01/08/2026')).toBe(false);
    expect(isIsoDate('2026-8-1')).toBe(false);
    expect(isIsoDate('')).toBe(false);
  });
});

/**
 * THE PREDICATE THAT DECIDES WHETHER THE PREVIEW LIES.
 *
 * Migration 0426's constraint — verified on production 2026-08-12 — is
 *   EXCLUDE USING gist (employment_id WITH =, component_id WITH =,
 *                       daterange(valid_from, COALESCE(valid_to, '9999-12-31'), '[]') WITH &&)
 *   WHERE (superseded_at IS NULL)
 * INCLUSIVE at both ends, and NOT keyed on payroll cycle. If the pre-flight used a half-open range, two
 * windows that merely touch would read Valid and then raise 23P01 on commit.
 */
describe('5c65367d · the overlap predicate is the CONSTRAINT’s own', () => {
  const w = (validFrom: string, validTo: string | null) => ({ validFrom, validTo });

  it('windows that merely TOUCH already overlap — the daterange is inclusive at both ends', () => {
    expect(fixedWindowsOverlap(w('2026-01-01', '2026-06-30'), w('2026-06-30', '2026-12-31'))).toBe(true);
    // One day apart does not.
    expect(fixedWindowsOverlap(w('2026-01-01', '2026-06-29'), w('2026-06-30', '2026-12-31'))).toBe(false);
  });

  it('an OPEN row runs forever, so anything starting after it overlaps', () => {
    expect(fixedWindowsOverlap(w('2026-01-01', null), w('2030-01-01', null))).toBe(true);
    expect(fixedWindowsOverlap(w('2026-01-01', null), w('2025-01-01', '2025-12-31'))).toBe(false);
  });

  it('containment, in either direction', () => {
    expect(fixedWindowsOverlap(w('2026-01-01', '2026-12-31'), w('2026-06-01', '2026-06-30'))).toBe(true);
    expect(fixedWindowsOverlap(w('2026-06-01', '2026-06-30'), w('2026-01-01', '2026-12-31'))).toBe(true);
  });

  it('is symmetric', () => {
    const a = w('2026-01-01', '2026-06-30');
    const b = w('2026-06-30', null);
    expect(fixedWindowsOverlap(a, b)).toBe(fixedWindowsOverlap(b, a));
  });
});

describe('5c65367d · the workbooks', () => {
  it('Fixed Transaction: five sheets, the fill-in one FIRST, identity columns text-formatted', async () => {
    const XLSX = await import('xlsx');
    const bytes = await buildTxnImportWorkbook('fixed', REFERENCE);
    expect(bytes.byteLength).toBeGreaterThan(1000);

    // cellStyles: true — the `@` format lives in the STYLE table, not on the cell record. A plain read
    // reports `z` as undefined on a perfectly correct file.
    const wb = XLSX.read(bytes, { type: 'array', cellStyles: true });
    expect(wb.SheetNames).toEqual([
      TXN_IMPORT_SHEETS.data.fixed,
      TXN_IMPORT_SHEETS.example,
      TXN_IMPORT_SHEETS.employees,
      TXN_IMPORT_SHEETS.payItems,
      TXN_IMPORT_SHEETS.cycles,
    ]);

    // Sheet 1: headings only. No sample rows to delete before typing.
    const data = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[TXN_IMPORT_SHEETS.data.fixed], {
      header: 1,
      raw: true,
      blankrows: false,
    });
    expect(data[0]).toEqual([...FIXED_TXN_HEADERS]);
    expect(data.filter((r) => r.some((c) => c != null && String(c).trim() !== ''))).toHaveLength(1);

    // Employee ID and Pay Item Code really carry the text format, 500 rows deep; Amount really does not.
    const ws = wb.Sheets[TXN_IMPORT_SHEETS.data.fixed] as Record<string, { t?: string; z?: string } | undefined>;
    for (const col of TXN_IMPORT_TEXT_COLUMN_INDEXES.fixed) {
      for (const row of [1, 250, 500]) {
        const addr = XLSX.utils.encode_cell({ c: col, r: row });
        expect(ws[addr]?.z, `${addr} must be text-formatted`).toBe('@');
        expect(ws[addr]?.t).toBe('s');
      }
    }
    const amountCol = FIXED_TXN_HEADERS.indexOf('Amount');
    expect(ws[XLSX.utils.encode_cell({ c: amountCol, r: 1 })]?.z).not.toBe('@');

    // The reference sheets carry the values the validator resolves against.
    const employees = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[TXN_IMPORT_SHEETS.employees], {
      header: 1,
      raw: true,
      blankrows: false,
    });
    expect(employees.flat().map(String)).toContain('X000001');
    const items = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[TXN_IMPORT_SHEETS.payItems], {
      header: 1,
      raw: true,
      blankrows: false,
    });
    expect(items.flat().map(String)).toContain('HANDPHONE');
    const cycles = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[TXN_IMPORT_SHEETS.cycles], {
      header: 1,
      raw: true,
      blankrows: false,
    });
    expect(cycles.flat().map(String)).toContain('regular');
  });

  /**
   * 0db616f3 UPDATES THIS CASE RATHER THAN REPLACING IT. It used to read "with Kinds WHERE Fixed has
   * Cycles" and pinned five sheets ending at Kinds. Half of that is still true and is kept: Individual
   * still carries the Kinds sheet and Fixed still does not. What changed is that Individual now has a
   * Payroll Cycle COLUMN — without it an import had no way to say which run of the month a line was for,
   * which is how a January bonus file came to sit on the salary run — so it carries the Cycles reference
   * sheet too, and a coded column whose vocabulary is not on the reference is a column nobody can fill in.
   */
  it('Individual Transaction: the same shape, with Kinds AND Cycles (Fixed has Cycles only)', async () => {
    const XLSX = await import('xlsx');
    const bytes = await buildTxnImportWorkbook('individual', REFERENCE);
    const wb = XLSX.read(bytes, { type: 'array', cellStyles: true });
    expect(wb.SheetNames).toEqual([
      TXN_IMPORT_SHEETS.data.individual,
      TXN_IMPORT_SHEETS.example,
      TXN_IMPORT_SHEETS.employees,
      TXN_IMPORT_SHEETS.payItems,
      TXN_IMPORT_SHEETS.kinds,
      TXN_IMPORT_SHEETS.cycles,
    ]);
    const data = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[TXN_IMPORT_SHEETS.data.individual], {
      header: 1,
      raw: true,
      blankrows: false,
    });
    expect(data[0]).toEqual([...INDIVIDUAL_TXN_HEADERS]);
    const kinds = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[TXN_IMPORT_SHEETS.kinds], {
      header: 1,
      raw: true,
      blankrows: false,
    });
    expect(kinds.flat().map(String)).toContain('overtime');
    const cycles = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[TXN_IMPORT_SHEETS.cycles], {
      header: 1,
      raw: true,
      blankrows: false,
    });
    expect(cycles.flat().map(String)).toContain('bonus');
  });

  /**
   * THE WHOLE ROUND TRIP: build the template, fill its FIRST sheet, and push it back through the real
   * browser-side reader the screen uses. This is what proves the two ends agree — a header the builder
   * writes and the parser cannot map is invisible to every other test in this file.
   */
  it('a filled template reads back through the real upload path, with the leading zero intact', async () => {
    const XLSX = await import('xlsx');
    const { workbookToCsvText } = await import('../lib/spreadsheet');

    const bytes = await buildTxnImportWorkbook('fixed', REFERENCE);
    const wb = XLSX.read(bytes, { type: 'array', cellStyles: true });
    // Fill the first sheet exactly as an operator would: the headings, then their rows. The employee
    // code is written as a STRING because the template's text format is what makes Excel keep it that
    // way — this asserts the reader preserves it, which is the half the reader owns.
    const filled = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      filled,
      XLSX.utils.aoa_to_sheet([
        [...FIXED_TXN_HEADERS],
        ['0012345', 'Leading Zero', 'HANDPHONE', 'Handphone Allowance', '100', 'regular', '2026-08-01', '', 'note'],
      ]),
      wb.SheetNames[0],
    );
    const filledBytes = new Uint8Array(XLSX.write(filled, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);

    const csv = await workbookToCsvText(filledBytes);
    const { headers, records } = parseCsvRecords(csv);
    expect(headers).toEqual([...FIXED_TXN_COLUMNS]);
    expect(records).toHaveLength(1);
    expect(records[0].employee_id).toBe('0012345');
    expect(records[0].pay_item_code).toBe('HANDPHONE');
    expect(records[0].amount).toBe('100');
    expect(records[0].start_date).toBe('2026-08-01');
    expect(records[0].end_date).toBe('');
  });

  it('a REAL Excel date cell reads back as YYYY-MM-DD, not as a serial number', async () => {
    const XLSX = await import('xlsx');
    const { workbookToCsvText } = await import('../lib/spreadsheet');
    const sheet = XLSX.utils.aoa_to_sheet([
      [...INDIVIDUAL_TXN_HEADERS],
      ['X000001', 'Irwin Law', 'OT1_5', 'Overtime 1.5', 'overtime', 5, '', new Date(Date.UTC(2026, 7, 5)), '', 'weekend'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, TXN_IMPORT_SHEETS.data.individual);
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellDates: true }) as ArrayBuffer);

    const { records } = parseCsvRecords(await workbookToCsvText(bytes));
    // The date arrives as the engine's own shape — an Excel serial (46_240-ish) would fail every check.
    expect(records[0].transaction_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(records[0].quantity).toBe('5');
  });
});
