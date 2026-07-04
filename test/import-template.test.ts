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
  leaveImportTemplate,
  payrollComponentTemplate,
  type TemplateSpec,
} from '../lib/import-template';
import { LEAVE_IMPORT_COLUMNS } from '../lib/leave-import-schema';

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

  const specs: TemplateSpec[] = [
    employeeTemplate,
    attendancePunchTemplate,
    payrollComponentTemplate,
    leaveImportTemplate,
  ];

  describe.each(specs.map((s) => [s.id, s] as const))('all three: %s', (_id, spec) => {
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
