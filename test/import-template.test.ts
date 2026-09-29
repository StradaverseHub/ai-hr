/**
 * Data-template tests — pure & hermetic (no DB harness).
 *
 * The DB round-trip (validateEmployeeImport against seedBase) was deliberately NOT used here: it is
 * non-hermetic (seed-coupled), and it only covers 1 of the 3 importer surfaces. The lock we actually
 * want is that the EMPLOYEE template can never drift from the contract the validator enforces
 * (lib/import-schema IMPORT_COLUMNS), which is a pure assertion. Attendance and payroll have NO
 * canonical contract (fuzzy header matching / aliases), so their specs are a *suggested* format and
 * we only assert CSV round-trip symmetry + non-empty required cells, not a header "contract".
 */
import { describe, expect, it } from 'vitest';
import { parseCsvRecords } from '../lib/csv';
import { IMPORT_COLUMNS } from '../lib/import-schema';
import {
  attendancePunchTemplate,
  buildTemplateCsv,
  employeeTemplate,
  leaveHistoryImportTemplate,
  leaveImportTemplate,
  payrollComponentTemplate,
  LEAVE_HISTORY_XLSX_HEADERS,
  type TemplateSpec,
} from '../lib/import-template';
import { LEAVE_IMPORT_COLUMNS } from '../lib/leave-import-schema';
import { LEAVE_HISTORY_COLUMNS, canonicalColumnKey } from '../lib/leave-history-import-schema';

describe('import templates', () => {
  describe('employee (the real desync lock)', () => {
    it('columns exactly equal required ∪ optional from IMPORT_COLUMNS', () => {
      const expected = [...IMPORT_COLUMNS.required, ...IMPORT_COLUMNS.optional];
      const actual = employeeTemplate.columns.map((c) => c.key);
      // Exact set equality — catches a required OR optional column drifting from the template
      // (e.g. epf_citizenship #157 silently dropped).
      expect([...actual].sort()).toEqual([...expected].sort());
    });

    it('required flag matches membership in IMPORT_COLUMNS.required for every column', () => {
      const requiredSet = new Set<string>(IMPORT_COLUMNS.required);
      for (const c of employeeTemplate.columns) {
        expect(c.required).toBe(requiredSet.has(c.key));
      }
    });
  });

  describe('leave-import (the desync lock)', () => {
    it('columns exactly equal LEAVE_IMPORT_COLUMNS.required (all required)', () => {
      const actual = leaveImportTemplate.columns.map((c) => c.key);
      expect(actual).toEqual([...LEAVE_IMPORT_COLUMNS.required]);
      // Every column in this template is required (there are no optional leave-import columns).
      expect(leaveImportTemplate.columns.every((c) => c.required)).toBe(true);
    });
  });

  /**
   * 3f15ffdb (r362) — LEAVE HISTORY (the third real desync lock).
   *
   * Two directions, and the second is the one that earns the case. Forward: the template's columns ARE
   * the enforced contract, in the contract's order, so a column added to one appears in the other. And
   * the .xlsx template's HUMAN headings — the reporter's own spellings — must canonicalise back to the
   * very same keys, because that workbook is what HR actually fills in and uploads. Get that wrong and
   * the file the product handed out is a file the product rejects, behind a green everything.
   */
  describe('leave-history (the desync lock, both directions)', () => {
    it('the template columns are the enforced contract, in order', () => {
      expect(leaveHistoryImportTemplate.columns).toEqual(
        LEAVE_HISTORY_COLUMNS.map((c) => ({ key: c.key, required: c.required })),
      );
      // Non-vacuity: the contract is the reporter's twelve, and six of them are required.
      expect(leaveHistoryImportTemplate.columns).toHaveLength(12);
      expect(leaveHistoryImportTemplate.columns.filter((c) => c.required)).toHaveLength(6);
    });

    it('every .xlsx heading canonicalises back to its own contract key (the round trip HR actually uses)', () => {
      expect(LEAVE_HISTORY_XLSX_HEADERS).toEqual(LEAVE_HISTORY_COLUMNS.map((c) => c.header));
      for (const c of LEAVE_HISTORY_COLUMNS) {
        // The two-step the real upload takes: parseCsvRecords lower-cases and underscores the header
        // (keeping punctuation, which is why "Employee No." arrives as `employee_no.`), then the
        // service canonicalises it. Both steps, in order, or this case proves nothing about the file.
        const asParsed = c.header.trim().toLowerCase().replace(/\s+/g, '_');
        expect(canonicalColumnKey(asParsed), `${c.header} must reach ${c.key}`).toBe(c.key);
      }
      // …and the one that would otherwise pass silently: the period in "Employee No." is real.
      expect('Employee No.'.trim().toLowerCase().replace(/\s+/g, '_')).toBe('employee_no.');
      expect(canonicalColumnKey('employee_no.')).toBe('employee_no');
    });
  });

  const specs: TemplateSpec[] = [
    employeeTemplate,
    attendancePunchTemplate,
    payrollComponentTemplate,
    leaveImportTemplate,
    // 3f15ffdb (r362) — the CSV form of the leave-history template takes the same round-trip and
    // required-cell guarantees as its four siblings.
    leaveHistoryImportTemplate,
  ];

  describe.each(specs.map((s) => [s.id, s] as const))('all five: %s', (_id, spec) => {
    it('round-trips through parseCsvRecords to the same headers (toCsv ↔ parseCsvRecords, incl. CRLF)', () => {
      const csv = buildTemplateCsv(spec);
      expect(csv).toContain('\r\n'); // toCsv emits CRLF line endings
      expect(csv.endsWith('\r\n')).toBe(true); // trailing CRLF
      const { headers, records } = parseCsvRecords(csv);
      expect(headers).toEqual(spec.columns.map((c) => c.key));
      expect(records.length).toBe(spec.sampleRows.length);
    });

    it('every required column is non-empty in every sample record', () => {
      const { records } = parseCsvRecords(buildTemplateCsv(spec));
      const requiredKeys = spec.columns.filter((c) => c.required).map((c) => c.key);
      for (const rec of records) {
        for (const k of requiredKeys) {
          expect(rec[k], `required column "${k}" must be non-empty in ${spec.id} sample`).not.toBe('');
        }
      }
    });

    it('every sample row has exactly one cell per column', () => {
      for (const row of spec.sampleRows) {
        expect(row.length).toBe(spec.columns.length);
      }
    });
  });
});
