/**
 * 1.2.5 — payroll-history template: pure & hermetic (no DB).
 *
 * The desync lock: payrollHistoryTemplate columns can never drift from PAYROLL_HISTORY_COLUMNS (the
 * contract core/payroll-history-import enforces) — same lock as the employee template. Plus CSV
 * round-trip symmetry and arithmetic consistency of the sample rows (so a download→fill→upload of an
 * unmodified template validates: net = gross − employee deductions; cost = gross + employer adds).
 */
import { describe, expect, it } from 'vitest';
import { parseCsvRecords } from '../lib/csv';
import { PAYROLL_HISTORY_COLUMNS } from '../lib/payroll-history-import-schema';
import { buildTemplateCsv, payrollHistoryTemplate } from '../lib/import-template';

const num = (s: string) => Number(String(s).replace(/[,_]/g, ''));

describe('payroll-history template (desync lock)', () => {
  it('columns exactly equal required ∪ optional from PAYROLL_HISTORY_COLUMNS', () => {
    const expected = [...PAYROLL_HISTORY_COLUMNS.required, ...PAYROLL_HISTORY_COLUMNS.optional];
    const actual = payrollHistoryTemplate.columns.map((c) => c.key);
    expect([...actual].sort()).toEqual([...expected].sort());
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

  it('sample rows are arithmetically consistent (net = gross − ee deductions; cost = gross + er adds)', () => {
    const { records } = parseCsvRecords(buildTemplateCsv(payrollHistoryTemplate));
    for (const r of records) {
      const eeDed = num(r.epf_employee) + num(r.socso_employee) + num(r.socso_skbbk) +
        num(r.eis_employee) + num(r.pcb) + num(r.other_deductions);
      expect(num(r.gross_pay) - eeDed).toBeCloseTo(num(r.net_pay), 2);
      const cost = num(r.gross_pay) + num(r.epf_employer) + num(r.socso_employer) + num(r.eis_employer);
      expect(cost).toBeCloseTo(num(r.employer_cost), 2);
    }
  });
});
