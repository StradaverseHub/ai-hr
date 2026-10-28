/**
 * Payroll-history template (4157a498) — pure & hermetic (no DB).
 *
 * Two locks:
 *
 *  1. THE HEADER ROUND-TRIP. The reporter said "do not change the Excel column names or column sequence",
 *     so the workbook carries their headings verbatim — Employee No, Payroll Period, … — while the
 *     validator works in contract keys. parseCsvRecords lowercases a header and underscores its spaces
 *     (`h.trim().toLowerCase().replace(/\s+/g, '_')`), which is the ONLY thing making the two the same
 *     string. A heading that stopped normalising to its key would silently drop the whole column — every
 *     line would fail on a missing mandatory field with no clue why — so it is asserted, not trusted.
 *     (Note "Override?" → `override?`: the question mark survives, and the contract key carries it.)
 *
 *  2. THE DESYNC LOCK. payrollHistoryTemplate's columns can never drift from PAYROLL_HISTORY_COLUMNS,
 *     the contract core/payroll-history-import enforces — same lock as the employee template.
 *
 * Plus: the shared sample is a COMPLETE employee-month. A migrator who downloads the template, changes
 * the identifiers and uploads it must not be told their own sample is an "Incomplete month", so the
 * sample has to carry an employee-side EPF/SOCSO/EIS/tax line and the employer's side too.
 */
import { describe, expect, it } from 'vitest';
import { parseCsvRecords } from '../lib/csv';
import {
  PAYROLL_HISTORY_COLUMNS,
  PAYROLL_HISTORY_HEADERS,
  PAYROLL_HISTORY_HEADER_ALIASES,
  PAYROLL_HISTORY_SAMPLE_ROWS,
  STATUTORY_DESTINATIONS,
  STATUTORY_IMPORT_CODES,
  missingHistoryColumns,
  payComponentDestination,
  readHistoryField,
  historySampleRows,
  importCodeCategory,
} from '../lib/payroll-history-import-schema';
import { PAYROLL_HISTORY_TEXT_COLUMN_INDEXES, buildImportCodeRows } from '../lib/import-template-xlsx';
import { buildTemplateCsv, payrollHistoryTemplate } from '../lib/import-template';

const CONTRACT_KEYS: string[] = [...PAYROLL_HISTORY_COLUMNS.required, ...PAYROLL_HISTORY_COLUMNS.optional];
const HEADINGS = {
  title: 'Accepted DOE codes',
  note: 'A code the system does not recognise stops its line.',
  code: 'Code',
  label: 'Meaning',
  destination: 'Lands on',
  direction: 'Direction',
  category: 'Category',
  amountType: 'Amount type',
  sampleNote: 'SAMPLE — NOT REAL DATA',
  categoryNames: { basic: 'Basic Salary', earning: 'Earning', deduction: 'Deduction', employeeStatutory: 'Employee Statutory', employerStatutory: 'Employer Statutory', payrollTotal: 'Payroll Total' },
  amountTypeNames: { employee: 'Employee amount', employer: 'Employer amount', check: 'Check only' },
};

describe('payroll-history template', () => {
  it('the reporter’s headings round-trip to the contract keys, in their order', () => {
    // Exactly what parseCsvRecords does to a header cell.
    const normalise = (h: string) => h.trim().toLowerCase().replace(/\s+/g, '_');
    expect(PAYROLL_HISTORY_HEADERS.map(normalise)).toEqual(CONTRACT_KEYS);
    // And through the real parser, on a real header row, including CRLF.
    const { headers } = parseCsvRecords(`${PAYROLL_HISTORY_HEADERS.join(',')}\r\nA1001,202501,ME,BASIC,ABCDE,1\r\n`);
    expect(headers).toEqual(CONTRACT_KEYS);
  });

  it('the column ORDER is the reporter’s, with Override? retired (d28501b8)', () => {
    expect([...PAYROLL_HISTORY_HEADERS]).toEqual([
      'Employee No',
      'Payroll Period',
      'Payroll Cycle',
      'DOE Code',
      'Company Code',
      'Amount',
    ]);
  });

  it('every alias list starts with its own canonical key, so the template is always readable back', () => {
    for (const key of CONTRACT_KEYS) {
      expect(PAYROLL_HISTORY_HEADER_ALIASES[key]?.[0], `alias list for ${key}`).toBe(key);
    }
  });

  it('readHistoryField reads a record parsed from the reporter’s own headings', () => {
    const { records } = parseCsvRecords(
      `${PAYROLL_HISTORY_HEADERS.join(',')}\nA1001,202501,ME,BASIC,ABCDE,5000.00`,
    );
    const rec = records[0];
    expect(readHistoryField(rec, 'employee_no')).toBe('A1001');
    expect(readHistoryField(rec, 'payroll_period')).toBe('202501');
    expect(readHistoryField(rec, 'payroll_cycle')).toBe('ME');
    expect(readHistoryField(rec, 'doe_code')).toBe('BASIC');
    expect(readHistoryField(rec, 'company_code')).toBe('ABCDE');
    expect(readHistoryField(rec, 'amount')).toBe('5000.00');
  });

  it('an older file that still carries Override? parses the same and the column is read by nothing', () => {
    const { headers, records } = parseCsvRecords('Employee No,Payroll Period,Payroll Cycle,DOE Code,Company Code,Amount,Override?\nA1001,202501,ME,BASIC,ABCDE,5000.00,0');
    expect(missingHistoryColumns(headers)).toEqual([]);
    expect(readHistoryField(records[0], 'amount')).toBe('5000.00');
    expect(Object.keys(PAYROLL_HISTORY_HEADER_ALIASES)).not.toContain('override?');
  });

  it('missingHistoryColumns names every absent mandatory column and accepts aliases', () => {
    expect(missingHistoryColumns(CONTRACT_KEYS)).toEqual([]);
    expect(missingHistoryColumns(['employee_no', 'payroll_period'])).toEqual([
      'payroll_cycle',
      'doe_code',
      'company_code',
      'amount',
    ]);
    // A customer's own export spelling still satisfies the contract.
    expect(
      missingHistoryColumns(['staff_id', 'period', 'cycle', 'code', 'company', 'amount']),
    ).toEqual([]);
  });

  it('columns exactly equal required ∪ optional from PAYROLL_HISTORY_COLUMNS', () => {
    const actual = payrollHistoryTemplate.columns.map((c) => c.key);
    expect([...actual].sort()).toEqual([...CONTRACT_KEYS].sort());
  });

  it('required flag matches membership in PAYROLL_HISTORY_COLUMNS.required for every column', () => {
    const requiredSet = new Set<string>(PAYROLL_HISTORY_COLUMNS.required);
    for (const c of payrollHistoryTemplate.columns) {
      expect(c.required).toBe(requiredSet.has(c.key));
    }
  });

  it('round-trips through parseCsvRecords to the same headers (incl. CRLF)', () => {
    const csv = buildTemplateCsv(payrollHistoryTemplate);
    expect(csv).toContain('\r\n');
    expect(csv.endsWith('\r\n')).toBe(true);
    const { headers, records } = parseCsvRecords(csv);
    expect(headers).toEqual(payrollHistoryTemplate.columns.map((c) => c.key));
    expect(records.length).toBe(payrollHistoryTemplate.sampleRows.length);
  });

  it('every required column is non-empty in every sample record', () => {
    const { records } = parseCsvRecords(buildTemplateCsv(payrollHistoryTemplate));
    for (const rec of records) {
      for (const k of PAYROLL_HISTORY_COLUMNS.required) {
        expect(rec[k], `required column "${k}" must be non-empty`).not.toBe('');
      }
    }
  });

  it('the sample is ONE complete employee-month: earnings plus both sides of the statutory figures', () => {
    const rows = PAYROLL_HISTORY_SAMPLE_ROWS;
    // One employee, one period, one cycle, one company — the fold's identity.
    expect(new Set(rows.map((r) => r[0])).size).toBe(1);
    expect(new Set(rows.map((r) => r[1])).size).toBe(1);
    expect(new Set(rows.map((r) => r[2])).size).toBe(1);
    expect(new Set(rows.map((r) => r[4])).size).toBe(1);
    // Every DOE code in the sample is one the built-in statutory vocabulary or a stock pay code supplies.
    const statutory = new Map(STATUTORY_IMPORT_CODES.map((c) => [c.code, c]));
    const sampleCodes = rows.map((r) => r[3]);
    const statutoryHit = sampleCodes.filter((c) => STATUTORY_DESTINATIONS.has(statutory.get(c)?.destination ?? ''));
    // The completeness rule: earnings AND at least one statutory line. The sample must satisfy its own rule.
    expect(sampleCodes).toContain('BASIC');
    expect(statutoryHit.length).toBeGreaterThan(0);
    // Both sides, as the plan spells out: employee EPF/SOCSO/EIS/tax and employer EPF/SOCSO/EIS/levy.
    for (const code of ['EEEPF', 'EESOCSO', 'EEEIS', 'PCB', 'EREPF', 'ERSOCSO', 'EREIS', 'HRDF']) {
      expect(sampleCodes, `sample must carry ${code}`).toContain(code);
    }
    // No duplicate on the five-part key — a template that fails its own duplicate check is a bad template.
    const keys = rows.map((r) => [r[0], r[1], r[2], r[3], r[4]].join('|'));
    expect(new Set(keys).size).toBe(keys.length);
    // Every amount parses as money.
    for (const r of rows) expect(Number(r[5].replace(/,/g, ''))).not.toBeNaN();
    // Six columns: Override? is gone from the example as well as the headings.
    for (const r of rows) expect(r).toHaveLength(PAYROLL_HISTORY_HEADERS.length);
    // d28501b8 — every built-in code appears, so the sample is the statutory reference the reporter asked for.
    for (const c of STATUTORY_IMPORT_CODES) expect(sampleCodes, `sample must carry ${c.code}`).toContain(c.code);
    // Every code is one the Codes sheet lists when no tenant codes exist: the built-in floor alone.
    for (const code of sampleCodes) expect(statutory.has(code), `${code} must be built in`).toBe(true);
  });

  it('the stated GROSS and NETPAY agree with the example’s own lines, with and without tenant codes', () => {
    for (const codes of [[], [{ code: 'A0027', destination: 'allowance', source: 'component' }, { code: 'D0030', destination: 'other_deduction', source: 'component' }]]) {
      const rows = historySampleRows(codes);
      const amt = (c: string) => Number(rows.find((r) => r[3] === c)?.[5] ?? 0);
      const gross = amt('BASIC') + amt('A0027');
      expect(amt('GROSS')).toBeCloseTo(gross, 2);
      const cash = ['EEEPF', 'EESOCSO', 'EESOCSOSKBBK', 'EEEIS', 'PCB', 'CP38', 'ZAKAT', 'D0030'].reduce((n, c) => n + amt(c), 0);
      expect(amt('NETPAY')).toBeCloseTo(gross - cash, 2);
    }
    const withTenant = historySampleRows([{ code: 'A0027', destination: 'allowance', source: 'component' }]).map((r) => r[3]);
    expect(withTenant).toContain('A0027');
  });

  it('BASIC is built in and every code gets a Category and Amount Type from where its money lands', () => {
    expect(STATUTORY_IMPORT_CODES.find((c) => c.code === 'BASIC')).toMatchObject({ destination: 'basic', direction: 'earning' });
    expect(importCodeCategory({ destination: 'basic', direction: 'earning' })).toEqual({ category: 'basic', amountType: 'employee' });
    expect(importCodeCategory({ destination: 'allowance', direction: 'earning' })).toEqual({ category: 'earning', amountType: 'employee' });
    expect(importCodeCategory({ destination: 'other_deduction', direction: 'deduction' })).toEqual({ category: 'deduction', amountType: 'employee' });
    expect(importCodeCategory({ destination: 'epf_employee', direction: 'deduction' })).toEqual({ category: 'employeeStatutory', amountType: 'employee' });
    expect(importCodeCategory({ destination: 'epf_employer', direction: 'employer' })).toEqual({ category: 'employerStatutory', amountType: 'employer' });
    expect(importCodeCategory({ destination: 'net', direction: 'check' })).toEqual({ category: 'payrollTotal', amountType: 'check' });
  });

  it('the text-stamped columns are every identity column and never Amount', () => {
    // Amount must stay a real number so Excel can sum a column of them; everything else is an identifier.
    expect([...PAYROLL_HISTORY_TEXT_COLUMN_INDEXES].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4]);
    expect(PAYROLL_HISTORY_TEXT_COLUMN_INDEXES).not.toContain(PAYROLL_HISTORY_HEADERS.indexOf('Amount'));
  });

  it('buildImportCodeRows lays the Codes sheet out with a heading row above the codes', () => {
    const rows = buildImportCodeRows(HEADINGS, [
      { code: 'EEEPF', label: 'Employee EPF', destination: 'epf_employee', direction: 'deduction' },
      { code: 'EREPF', label: 'Employer EPF', destination: 'epf_employer', direction: 'employer' },
    ]);
    expect(rows[0]).toEqual(['Accepted DOE codes']);
    expect(rows[3]).toEqual(['Code', 'Meaning', 'Category', 'Amount type', 'Lands on', 'Direction']);
    expect(rows[4]).toEqual(['EEEPF', 'Employee EPF', 'Employee Statutory', 'Employee amount', 'epf_employee', 'deduction']);
    expect(rows[5]).toEqual(['EREPF', 'Employer EPF', 'Employer Statutory', 'Employer amount', 'epf_employer', 'employer']);
  });
});

describe('pay component → import destination', () => {
  it('KIND decides direction; display category only refines which box an EARNING prints in', () => {
    // Production carries D0030 (MONTHLY PARKING) as kind=deduction with display_category 'claim'.
    // Reading the category first would turn a parking deduction into an allowance and inflate gross.
    expect(payComponentDestination({ code: 'D0030', kind: 'deduction', displayCategory: 'claim' })).toEqual({
      destination: 'other_deduction',
      direction: 'deduction',
    });
    expect(payComponentDestination({ code: 'BASIC', kind: 'allowance', displayCategory: 'basic' })).toEqual({
      destination: 'basic',
      direction: 'earning',
    });
    expect(payComponentDestination({ code: 'OT1_5', kind: 'allowance', displayCategory: 'overtime' })).toEqual({
      destination: 'overtime',
      direction: 'earning',
    });
    expect(payComponentDestination({ code: 'A0027', kind: 'allowance', displayCategory: 'allowance' })).toEqual({
      destination: 'allowance',
      direction: 'earning',
    });
  });

  it('an unclassified earning falls back to the code, then to allowance', () => {
    // Six of the 24 live components have no display_category.
    expect(payComponentDestination({ code: 'BASIC', kind: 'allowance', displayCategory: null }).destination).toBe('basic');
    expect(payComponentDestination({ code: 'OVERTIME', kind: 'allowance', displayCategory: null }).destination).toBe('overtime');
    expect(payComponentDestination({ code: 'BONUS', kind: 'allowance', displayCategory: null }).destination).toBe('bonus');
    expect(payComponentDestination({ code: 'A0040', kind: 'allowance', displayCategory: null }).destination).toBe('allowance');
    expect(payComponentDestination({ code: 'ABSENT', kind: 'deduction', displayCategory: null }).destination).toBe('other_deduction');
  });
});

/**
 * THE ARTIFACT ITSELF. Everything above checks the inputs to the workbook; this builds the real bytes
 * the Download Template button produces and reads them back with SheetJS.
 *
 * A template that is "non-empty" proves nothing — the failures that matter are a renamed sheet (the
 * upload path reads the FIRST worksheet, so the wrong one first means every re-upload reads sample data),
 * a reordered heading (the reporter said not to), and an identity column left in General format (which
 * destroys a leading zero in the file before any reader sees it). So each is asserted against the parsed
 * workbook, not against the code that was supposed to produce it.
 */
describe('the generated .xlsx, parsed back', () => {
  it('has the three sheets, data first, with the six headings in order and text identity columns', async () => {
    const XLSX = await import('xlsx');
    const { buildPayrollHistoryWorkbook, PAYROLL_HISTORY_XLSX_SHEETS } = await import('../lib/import-template-xlsx');

    const bytes = await buildPayrollHistoryWorkbook(
      HEADINGS,
      STATUTORY_IMPORT_CODES.map((c) => ({
        code: c.code,
        label: c.label,
        destination: c.destination,
        direction: c.direction,
      })),
    );
    expect(bytes.byteLength).toBeGreaterThan(1000);

    // cellStyles: true — the `@` number format is written into the workbook's STYLE table, not onto the
    // cell record, so a plain read reports `z` as undefined even though the file is correct. Verified
    // against SheetJS 0.20.3 directly before trusting it.
    const wb = XLSX.read(bytes, { type: 'array', cellStyles: true });
    // Sheet names AND their order — the data sheet must be first, because workbookToCsvText reads
    // wb.SheetNames[0] on re-upload.
    expect(wb.SheetNames).toEqual([
      PAYROLL_HISTORY_XLSX_SHEETS.data,
      PAYROLL_HISTORY_XLSX_SHEETS.sample,
      PAYROLL_HISTORY_XLSX_SHEETS.codes,
    ]);

    // Sheet 1: headings only, in the reporter's order, and no data rows to delete.
    const data = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[PAYROLL_HISTORY_XLSX_SHEETS.data], {
      header: 1,
      raw: true,
      blankrows: false,
    });
    expect(data[0]).toEqual([...PAYROLL_HISTORY_HEADERS]);
    expect(data.filter((r) => r.some((c) => c != null && String(c).trim() !== ''))).toHaveLength(1);

    // The identity columns really carry the text format, 500 rows deep, and Amount really does not.
    const ws = wb.Sheets[PAYROLL_HISTORY_XLSX_SHEETS.data] as Record<string, { t?: string; z?: string } | undefined>;
    for (const col of PAYROLL_HISTORY_TEXT_COLUMN_INDEXES) {
      for (const row of [1, 250, 500]) {
        const addr = XLSX.utils.encode_cell({ c: col, r: row });
        expect(ws[addr]?.z, `${addr} must be text-formatted`).toBe('@');
        expect(ws[addr]?.t).toBe('s');
      }
    }
    const amountCol = PAYROLL_HISTORY_HEADERS.indexOf('Amount');
    expect(ws[XLSX.utils.encode_cell({ c: amountCol, r: 1 })]?.z).not.toBe('@');

    // Sheet 2: the reporter's worked example, headings repeated so it can be copied wholesale.
    const sample = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[PAYROLL_HISTORY_XLSX_SHEETS.sample], {
      header: 1,
      raw: true,
      blankrows: false,
    });
    // d28501b8 — the example is labelled as not real data before anything else on the sheet.
    expect(sample[0]).toEqual(['SAMPLE — NOT REAL DATA']);
    expect(sample[1]).toEqual([...PAYROLL_HISTORY_HEADERS]);
    expect(sample).toHaveLength(PAYROLL_HISTORY_SAMPLE_ROWS.length + 2);
    expect(sample[2].map(String)).toEqual([...PAYROLL_HISTORY_SAMPLE_ROWS[0]]);

    // Sheet 3: every code the import accepts.
    const codes = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[PAYROLL_HISTORY_XLSX_SHEETS.codes], {
      header: 1,
      raw: true,
      blankrows: false,
    });
    expect(codes[0]).toEqual(['Accepted DOE codes']);
    const codeColumn = codes.slice(3).map((r) => r[0]);
    for (const c of ['BASIC', 'EEEPF', 'EESOCSO', 'EEEIS', 'PCB', 'CP38', 'ZAKAT', 'EREPF', 'ERSOCSO', 'EREIS', 'HRDF']) {
      expect(codeColumn, `Codes sheet must list ${c}`).toContain(c);
    }
  });

  it('the Sample sheet’s rows survive a round trip back through the upload path', async () => {
    const { buildPayrollHistoryWorkbook } = await import('../lib/import-template-xlsx');
    const { workbookToCsvText } = await import('../lib/spreadsheet');
    const XLSX = await import('xlsx');

    // Build a workbook whose FIRST sheet carries the sample rows — i.e. exactly what a migrator hands
    // back after filling the template in — and push it through the real upload reader.
    const bytes = await buildPayrollHistoryWorkbook(HEADINGS, []);
    // cellStyles: true — the `@` number format is written into the workbook's STYLE table, not onto the
    // cell record, so a plain read reports `z` as undefined even though the file is correct. Verified
    // against SheetJS 0.20.3 directly before trusting it.
    const wb = XLSX.read(bytes, { type: 'array', cellStyles: true });
    const filled = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      filled,
      XLSX.utils.aoa_to_sheet([[...PAYROLL_HISTORY_HEADERS], ...PAYROLL_HISTORY_SAMPLE_ROWS.map((r) => [...r])]),
      wb.SheetNames[0],
    );
    const filledBytes = new Uint8Array(XLSX.write(filled, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);

    const csv = await workbookToCsvText(filledBytes);
    const { headers, records } = parseCsvRecords(csv);
    expect(headers).toEqual(CONTRACT_KEYS);
    expect(records).toHaveLength(PAYROLL_HISTORY_SAMPLE_ROWS.length);
    expect(readHistoryField(records[0], 'employee_no')).toBe(PAYROLL_HISTORY_SAMPLE_ROWS[0][0]);
    expect(readHistoryField(records[0], 'payroll_period')).toBe(PAYROLL_HISTORY_SAMPLE_ROWS[0][1]);
    expect(readHistoryField(records[0], 'doe_code')).toBe(PAYROLL_HISTORY_SAMPLE_ROWS[0][3]);
    expect(readHistoryField(records[0], 'amount')).toBe(PAYROLL_HISTORY_SAMPLE_ROWS[0][5]);
  });
});
