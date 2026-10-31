/**
 * b240c0ff — ONE rule for what an imported payroll run is called, and every screen that labels a run
 * goes through it.
 *
 * The helper is pure and asserted directly. The screens below are server components whose data needs a
 * session and a database; the rendered and database-backed proof is in
 * test/b240c0ff-imported-history-by-import.test.ts and test/b240c0ff-imported-history.dom.test.tsx. This
 * file pins the structural half: each surface the approved plan lists calls `payrollRunLabel` (or reads a
 * cycle name the database already resolved to "… - By Import"), so a screen cannot quietly go back to
 * printing "Adjustment".
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BY_IMPORT_SUFFIX, payrollRunLabel } from '../core/payslip-cycle-label';
import { deductionLinesFor } from '../core/payslip-imported-lines';

describe('payrollRunLabel', () => {
  it('names imported history by the file’s Pay Cycle', () => {
    expect(payrollRunLabel({ historyImportAttemptId: 'a1', historyImportCycleName: 'Monthly' }, 'Adjustment')).toBe('Monthly - By Import');
    expect(BY_IMPORT_SUFFIX).toBe(' - By Import');
  });
  it('leaves every other run exactly as its screen already labelled it', () => {
    expect(payrollRunLabel({}, 'Regular')).toBe('Regular');
    expect(payrollRunLabel({ historyImportAttemptId: null, historyImportCycleName: 'Monthly' }, 'Adjustment')).toBe('Adjustment');
  });
  it('never prints a blank before " - By Import"', () => {
    expect(payrollRunLabel({ historyImportAttemptId: 'a1', historyImportCycleName: '  ' }, 'Adjustment')).toBe('Adjustment - By Import');
    expect(payrollRunLabel({ historyImportAttemptId: 'a1', historyImportCycleName: null }, 'Adjustment')).toBe('Adjustment - By Import');
  });
});

describe('deductionLinesFor — reconcile before replacing', () => {
  const st = {
    importedLines: [
      { code: 'UPL', name: 'Unpaid leave', amount: 250, buckets: [{ bucket: 'deduct', amount: 250 }] },
      { code: 'D002', name: 'Staff welfare fund', amount: 100, buckets: [{ bucket: 'deduct', amount: 100 }] },
      { code: 'A010', name: 'Meal allowance', amount: 300, buckets: [{ bucket: 'wage', amount: 300 }] },
    ],
  };
  it('returns the deduction lines when they add up to the row they explain', () => {
    expect(deductionLinesFor(st, 350).map((l) => [l.code, l.amount])).toEqual([['UPL', 250], ['D002', 100]]);
  });
  it('returns nothing when the row holds money no line explains (a loan, a carry-forward)', () => {
    expect(deductionLinesFor(st, 500)).toEqual([]);
    expect(deductionLinesFor({}, 350)).toEqual([]);
  });
});

/** Every surface in the approved plan's list, and what it must call. */
const SURFACES: [string, RegExp][] = [
  ['app/(app)/payroll/transaction-view/history-table.tsx', /payrollRunLabel\(r,/],
  ['app/(app)/payroll/transaction-view/history-grid.tsx', /payrollRunLabel\(r,/],
  ['app/(app)/payroll/transaction-view/history-export.ts', /payrollRunLabel\(row,/],
  ['app/(app)/payroll/transaction-view/grid-export/route.ts', /payrollRunLabel\(r,/],
  ['app/(app)/payroll/transaction-view/page.tsx', /payrollRunLabel\(m,/],
  ['app/(app)/payroll/individual-payslip/page.tsx', /payrollRunLabel\(o,/],
  ['app/(app)/payroll/process/steps/step-period.tsx', /payrollRunLabel\(r,/],
  ['app/(app)/payroll/process/wizard.tsx', /payrollRunLabel\(resumeBatch,/],
  ['app/(app)/payroll/[batchId]/reprocess/page.tsx', /payrollRunLabel\(batch,/],
  ['app/(app)/payroll/[batchId]/remove/page.tsx', /payrollRunLabel\(batch,/],
  ['app/(app)/payroll/[batchId]/reset/page.tsx', /payrollRunLabel\(batch,/],
  ['app/(app)/payroll/[batchId]/page.tsx', /payrollRunLabel\(batch,/],
  ['app/(app)/payroll/page.tsx', /payrollRunLabel\(b,/],
  ['app/(app)/payroll/multi-cycle-worksheet/page.tsx', /payrollRunLabel\(r,/],
  ['app/(app)/payroll/statutory-detail/statutory-detail-view.tsx', /payrollRunLabel\(ctx,/],
  ['app/(app)/payroll/[batchId]/transaction-detail-report.ts', /payrollRunLabel\(r,/],
  ['core/report-registry.ts', /payrollRunLabel\(r,/],
];

describe('every listed surface labels a run through payrollRunLabel', () => {
  for (const [file, call] of SURFACES) {
    it(file, () => {
      const src = readFileSync(file, 'utf8');
      expect(src.length).toBeGreaterThan(0);
      expect(src).toMatch(call);
      expect(src).toMatch(/from .@\/core\/payslip-cycle-label.|from .\.\/payslip-cycle-label./);
    });
  }

  it('the run pickers and statutory previews read a cycle name the database resolved to "… - By Import"', () => {
    const view = readFileSync('core/payroll-view.ts', 'utf8');
    // listFilableRunsForPeriod (borang-a, borang-8a, cp39, bbcd, sip-contribution) and payslipForReview.
    expect(view.match(/historyImportCycleName\} \|\| ' - By Import'/g)?.length).toBe(2);
    for (const preview of ['borang-a', 'borang-8a', 'borang-bbcd', 'cp39', 'sip-contribution']) {
      expect(readFileSync(`app/(app)/payroll/${preview}/preview/page.tsx`, 'utf8')).toMatch(/payslipCycleLabel\(\{\s*cycleName: r\.cycleName/);
    }
    expect(readFileSync('components/run-picker.tsx', 'utf8')).toMatch(/payslipCycleLabel\(\{ cycleName: r\.cycleName/);
  });
});
