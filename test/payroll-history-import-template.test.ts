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
} from '../lib/payroll-history-import-schema';
import { PAYROLL_HISTORY_TEXT_COLUMN_INDEXES, buildImportCodeRows } from '../lib/import-template-xlsx';
import { buildTemplateCsv, payrollHistoryTemplate } from '../lib/import-template';

const CONTRACT_KEYS = [...PAYROLL_HISTORY_COLUMNS.required, ...PAYROLL_HISTORY_COLUMNS.optional];

describe('payroll-history template', () => {
  it('the reporter’s headings round-trip to the contract keys, in their order', () => {
    // Exactly what parseCsvRecords does to a header cell.
    const normalise = (h: string) => h.trim().toLowerCase().replace(/\s+/g, '_');
    expect(PAYROLL_HISTORY_HEADERS.map(normalise)).toEqual(CONTRACT_KEYS);
    // And through the real parser, on a real header row, including CRLF.
    const { headers } = parseCsvRecords(`${PAYROLL_HISTORY_HEADERS.join(',')}\r\nA1001,202501,ME,BASIC,ABCDE,1,1\r\n`);
    expect(headers).toEqual(CONTRACT_KEYS);
  });

  it('the reporter’s column ORDER is unchanged', () => {
    expect([...PAYROLL_HISTORY_HEADERS]).toEqual([
      'Employee No',
      'Payroll Period',
      'Payroll Cycle',
      'DOE Code',
      'Company Code',
      'Amount',
      'Override?',
    ]);
  });

  it('every alias list starts with its own canonical key, so the template is always readable back', () => {
    for (const key of CONTRACT_KEYS) {
      expect(PAYROLL_HISTORY_HEADER_ALIASES[key]?.[0], `alias list for ${key}`).toBe(key);
    }
  });

  it('readHistoryField reads a record parsed from the reporter’s own headings', () => {
    const { records } = parseCsvRecords(
      `${PAYROLL_HISTORY_HEADERS.join(',')}\nA1001,202501,ME,BASIC,ABCDE,5000.00,1`,
    );
    const rec = records[0];
    expect(readHistoryField(rec, 'employee_no')).toBe('A1001');
    expect(readHistoryField(rec, 'payroll_period')).toBe('202501');
    expect(readHistoryField(rec, 'payroll_cycle')).toBe('ME');
    expect(readHistoryField(rec, 'doe_code')).toBe('BASIC');
    expect(readHistoryField(rec, 'company_code')).toBe('ABCDE');
    expect(readHistoryField(rec, 'amount')).toBe('5000.00');
    expect(readHistoryField(rec, 'override?')).toBe('1');
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
    // Override? is always a permitted value.
    for (const r of rows) expect(['0', '1']).toContain(r[6]);
  });

  it('the text-stamped columns are every identity column and never Amount', () => {
    // Amount must stay a real number so Excel can sum a column of them; everything else is an identifier.
    expect([...PAYROLL_HISTORY_TEXT_COLUMN_INDEXES].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 6]);
    expect(PAYROLL_HISTORY_TEXT_COLUMN_INDEXES).not.toContain(PAYROLL_HISTORY_HEADERS.indexOf('Amount'));
  });

  it('buildImportCodeRows lays the Codes sheet out with a heading row above the codes', () => {
    const rows = buildImportCodeRows(
      { title: 'Accepted DOE codes', note: 'note', code: 'Code', label: 'Meaning', destination: 'Lands on', direction: 'Direction' },
      [{ code: 'EEEPF', label: 'Employee EPF', destination: 'epf_employee', direction: 'deduction' }],
    );
    expect(rows[0]).toEqual(['Accepted DOE codes']);
    expect(rows[3]).toEqual(['Code', 'Meaning', 'Lands on', 'Direction']);
    expect(rows[4]).toEqual(['EEEPF', 'Employee EPF', 'epf_employee', 'deduction']);
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
