/**
 * 080de5cf — the Transaction View › History GRID pivot.
 *
 * The screen is a presentation change, so the defect this file exists to pin is a REGROUP bug: the grid
 * showing figures that no longer add up to the payslips they came from. Turning twelve payslips on their
 * side is exactly the operation where a fold can silently drop a run, double-count an item, or merge two
 * rows that are not the same row — and it would look plausible on screen, on a screen whose entire purpose
 * is reconciliation.
 *
 * So the load-bearing test here is the invariant, asserted per month AND for the year:
 *     Σ the reconciling EARNING rows   = Σ payslip gross
 *     Σ the reconciling DEDUCTION rows = Σ payslip total deductions
 * (test/payroll-view.test.ts asserts the same thing against REAL kernel output, which is the version that
 * catches a wrong decomposition; this file catches a wrong fold, with fixtures small enough to read.)
 *
 * Everything else here pins a specific way the pivot could be wrong:
 *   • the row key is (item code, RUN TYPE), because our multi-run months are the reference's "Payment ID";
 *   • a pay item coded BASIC must not merge with the synthetic BASIC line;
 *   • an unselected month contributes NOTHING, so the row total always equals what is on screen;
 *   • zakat is displayed but excluded from the deduction sum — PCB is already net of it;
 *   • an unregistered company's HRDF 0 is a policy statement, not a failed computation;
 *   • every dynamic row label resolves — a computed t() key is invisible to the static i18n scan.
 *
 * Pure unit test — no DB. The pivot is presentation-only over already-fetched, already scope-guarded rows.
 */
import { describe, expect, it } from 'vitest';
import type { ProcessedPayslipViewRow } from '../core/payroll-view';
import {
  SYNTHETIC_LABEL_KEYS,
  cleanMonths,
  filterGridRows,
  pivotHistoryGrid,
  type HistoryGridRow,
} from '../app/payroll/transaction-view/history-pivot';
import en from '../messages/en.json';

let seq = 0;
function slip(overrides: Partial<ProcessedPayslipViewRow> = {}): ProcessedPayslipViewRow {
  seq += 1;
  return {
    id: `00000000-0000-0000-0000-00000000${String(seq).padStart(4, '0')}`,
    employmentId: '00000000-0000-0000-0000-0000000000e1',
    employeeName: 'Aisyah binti Rahman',
    employeeCode: 'E001',
    companyId: '00000000-0000-0000-0000-0000000000c1',
    company: 'Acme Sdn Bhd',
    payPeriod: '2026-01',
    runType: 'regular',
    runSeq: 1,
    batchStatus: 'processed',
    releasedAt: null,
    version: 1,
    // 3000 + 500 + 120 + 0 = 3620, so the earnings decomposition reconciles with gross by construction —
    // the same way the kernel's own display overlay does.
    basic: '3000.00',
    allowance: '500.00',
    overtime: '120.00',
    bonus: '0.00',
    gross: '3620.00',
    // 330 + 18.65 + 7.90 + 73.45 = 430.00 ⇒ OTHER_DED is 0 for this baseline slip.
    statutory: { epfEmployee: 330, socsoEmployee: 18.65, eisEmployee: 7.9, pcb: 73.45 },
    totalDeductions: '430.00',
    net: '3190.00',
    ...overrides,
  };
}

const rowFor = (rows: HistoryGridRow[], code: string, runType = 'regular') =>
  rows.find((r) => r.code === code && r.runType === runType && r.kind === 'synthetic');

const sumMonth = (rows: HistoryGridRow[], group: string, monthIdx: number) =>
  Math.round(
    rows.filter((r) => r.reconciling && r.group === group).reduce((s, r) => s + r.months[monthIdx], 0) * 100,
  ) / 100;

describe('080de5cf — the History grid pivot', () => {
  it('THE INVARIANT: the fold sums to the same totals as adding the payslips up directly', () => {
    // Three months, deliberately different in shape: a plain month, a month with an OT-conversion line and
    // a claim, and a month with unpaid leave sitting in otherDeductions.
    const payslips = [
      slip({ payPeriod: '2026-01' }),
      slip({
        payPeriod: '2026-02',
        // The stored allowance column already folds the 80 of converted OT excess in (f3148da1), so the
        // grid takes it back out and gives it its own line — together they must still make gross.
        allowance: '580.00',
        gross: '3700.00',
        statutory: {
          epfEmployee: 330,
          socsoEmployee: 18.65,
          eisEmployee: 7.9,
          pcb: 73.45,
          otConvert: { code: 'OTX', name: 'OT excess payout', amount: 80 },
        },
      }),
      slip({
        payPeriod: '2026-03',
        totalDeductions: '530.00', // 430 statutory + 100 unpaid leave ⇒ OTHER_DED must carry the 100
        net: '3090.00',
      }),
    ];
    const grid = pivotHistoryGrid({ rows: payslips, year: 2026 });

    for (const [i, p] of payslips.entries()) {
      expect(sumMonth(grid.rows, 'earning', i), `earnings for month ${i + 1}`).toBe(Number(p.gross));
      expect(sumMonth(grid.rows, 'deduction', i), `deductions for month ${i + 1}`).toBe(
        Number(p.totalDeductions),
      );
    }

    // And for the year, which is the figure an operator actually reconciles with.
    const annual = (group: string) =>
      Math.round(
        grid.rows.filter((r) => r.reconciling && r.group === group).reduce((s, r) => s + r.total, 0) * 100,
      ) / 100;
    expect(annual('earning')).toBe(3620 + 3700 + 3620);
    expect(annual('deduction')).toBe(430 + 430 + 530);

    // The residual is where the unpaid leave landed — March only, and exactly 100.
    expect(rowFor(grid.rows, 'OTHER_DED')!.months).toEqual([0, 0, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    // …and the OT conversion got its own line rather than staying hidden inside Allowances.
    expect(rowFor(grid.rows, 'OT_CONV')!.months[1]).toBe(80);
    expect(rowFor(grid.rows, 'ALLOW')!.months[1]).toBe(500);
    expect(grid.payslipCount).toBe(3);
  });

  it('the row key is (item code, RUN TYPE) — a bonus run is a different line from the regular run', () => {
    // The reference shows GROSS four times, once per Payment ID. Ours is the run type (ADR-0024 Wave 2C).
    // Merging them would hide the fact that a month held two runs, which is the whole reason the column
    // exists on the reporter's screen.
    const grid = pivotHistoryGrid({
      rows: [
        slip({ payPeriod: '2026-02', runType: 'regular' }),
        slip({
          payPeriod: '2026-02',
          runType: 'bonus',
          basic: '0.00',
          allowance: '0.00',
          overtime: '0.00',
          bonus: '5000.00',
          gross: '5000.00',
          statutory: { epfEmployee: 550 },
          totalDeductions: '550.00',
          net: '4450.00',
        }),
      ],
      year: 2026,
    });
    const gross = grid.rows.filter((r) => r.code === 'GROSS');
    expect(gross).toHaveLength(2);
    expect(gross.map((r) => r.runType).sort()).toEqual(['bonus', 'regular']);
    expect(rowFor(grid.rows, 'GROSS', 'regular')!.months[1]).toBe(3620);
    expect(rowFor(grid.rows, 'GROSS', 'bonus')!.months[1]).toBe(5000);
    // Both runs still reconcile INSIDE their own line, so the month's earnings across both rows is the sum.
    expect(sumMonth(grid.rows, 'earning', 1)).toBe(3620 + 5000);
  });

  it('two runs of the SAME type in one month are ONE line, summed', () => {
    // runSeq 2 is a re-run of the same kind of run, not a different Payment ID. Splitting it would put two
    // "regular" lines on the grid that the reference has no notion of.
    const grid = pivotHistoryGrid({
      rows: [
        slip({ payPeriod: '2026-04', runType: 'regular', runSeq: 1 }),
        slip({ payPeriod: '2026-04', runType: 'regular', runSeq: 2 }),
      ],
      year: 2026,
    });
    expect(grid.rows.filter((r) => r.code === 'GROSS')).toHaveLength(1);
    expect(rowFor(grid.rows, 'GROSS')!.months[3]).toBe(7240);
  });

  it('pay items become their own rows, and a pay item coded BASIC does not merge with the synthetic one', () => {
    // The row key is namespaced by kind for exactly this reason: nothing stops an operator naming a pay
    // component "BASIC", and a collision would silently double a line on a reconciliation screen.
    const grid = pivotHistoryGrid({
      rows: [
        slip({
          payPeriod: '2026-05',
          statutory: {
            epfEmployee: 330,
            socsoEmployee: 18.65,
            eisEmployee: 7.9,
            pcb: 73.45,
            componentLines: [
              { code: 'BASIC', name: 'Basic top-up', amount: 200, buckets: [{ bucket: 'wage', amount: 200 }] },
              { code: 'COMM', name: 'Commission', amount: 300, buckets: [{ bucket: 'bonus', amount: 300 }] },
              { code: 'LOAN', name: 'Staff loan', amount: 150, buckets: [{ bucket: 'deduct', amount: 150 }] },
            ],
            recordLines: [{ code: 'BIK', name: 'Company car', amount: 0 }],
          },
        }),
      ],
      year: 2026,
    });

    const items = grid.rows.filter((r) => r.kind === 'item');
    expect(items.map((r) => r.code).sort()).toEqual(['BASIC', 'BIK', 'COMM', 'LOAN']);
    // Two distinct BASIC rows: the synthetic salary line and the pay item.
    expect(grid.rows.filter((r) => r.code === 'BASIC')).toHaveLength(2);
    expect(rowFor(grid.rows, 'BASIC')!.months[4]).toBe(3000);
    expect(items.find((r) => r.code === 'BASIC')!.months[4]).toBe(200);
    // A deduct-bucket item is filed under Deductions; a record line sits in its own section.
    expect(items.find((r) => r.code === 'LOAN')!.group).toBe('deduction');
    expect(items.find((r) => r.code === 'BIK')!.group).toBe('item');

    // …and NONE of them enters a reconciling sum, because each restates money already counted above.
    expect(items.every((r) => !r.reconciling)).toBe(true);
    expect(sumMonth(grid.rows, 'earning', 4)).toBe(3620);
    expect(sumMonth(grid.rows, 'deduction', 4)).toBe(430);
  });

  it('an unselected month contributes nothing, so the row total is always what is on screen', () => {
    const grid = pivotHistoryGrid({
      rows: [slip({ payPeriod: '2026-01' }), slip({ payPeriod: '2026-02' }), slip({ payPeriod: '2026-03' })],
      year: 2026,
      months: [1, 3],
    });
    expect(grid.months).toEqual([1, 3]);
    expect(grid.payslipCount).toBe(2); // February was not folded at all
    const gross = rowFor(grid.rows, 'GROSS')!;
    expect(gross.months[1], 'an excluded month must be empty, not merely hidden').toBe(0);
    expect(gross.total).toBe(7240);
  });

  it('a payslip from another year is ignored', () => {
    const grid = pivotHistoryGrid({
      rows: [slip({ payPeriod: '2025-12' }), slip({ payPeriod: '2026-01' })],
      year: 2026,
    });
    expect(grid.payslipCount).toBe(1);
    expect(rowFor(grid.rows, 'GROSS')!.total).toBe(3620);
  });

  it('zakat is shown but never added to the deduction column — PCB is already net of it', () => {
    // Adding it would deduct it twice. The payslip screen makes the same point in words; here it is the
    // difference between a column that reconciles and one that quietly over-states what came off pay.
    const grid = pivotHistoryGrid({
      rows: [
        slip({
          statutory: { epfEmployee: 330, socsoEmployee: 18.65, eisEmployee: 7.9, pcb: 73.45, zakat: 200 },
        }),
      ],
      year: 2026,
    });
    const zakat = rowFor(grid.rows, 'ZAKAT')!;
    expect(zakat.months[0]).toBe(200);
    expect(zakat.reconciling).toBe(false);
    expect(sumMonth(grid.rows, 'deduction', 0)).toBe(430);
  });

  it('employer-borne statutory is deducted from the EMPLOYEE line, not left to contradict the total', () => {
    // 3c473773 issue 2: the engine moves the share onto the company and total deductions is already net of
    // it. Printing the reported share in the deduction column would put two contradictory numbers for one
    // deduction on one screen — the defect that screen had.
    const grid = pivotHistoryGrid({
      rows: [
        slip({
          statutory: {
            epfEmployee: 330,
            socsoEmployee: 18.65,
            eisEmployee: 7.9,
            pcb: 73.45,
            employerBorne: { epf: 330, socso: 0, skbbk: 0, eis: 0, tax: 0, total: 330 },
          },
          totalDeductions: '100.00',
          net: '3520.00',
        }),
      ],
      year: 2026,
    });
    expect(rowFor(grid.rows, 'EPF_EE')!.months[0]).toBe(0);
    expect(rowFor(grid.rows, 'ER_BORNE')!.months[0]).toBe(330);
    expect(sumMonth(grid.rows, 'deduction', 0)).toBe(100);
  });

  it('an unregistered company levies no HRDF, and the row says so rather than printing a bare zero', () => {
    // efece4ce — an unregistered company looked exactly like a levy that failed to compute.
    const unreg = pivotHistoryGrid({ rows: [slip()], year: 2026, hrdfRegisteredCompanyIds: [] });
    expect(rowFor(unreg.rows, 'HRDF')!.notRegistered).toBe(true);
    const reg = pivotHistoryGrid({
      rows: [slip()],
      year: 2026,
      hrdfRegisteredCompanyIds: ['00000000-0000-0000-0000-0000000000c1'],
    });
    expect(rowFor(reg.rows, 'HRDF')!.notRegistered).toBeUndefined();
  });

  it('reports a run whose per-item detail was never stored, instead of showing a grid with a hole in it', () => {
    // 862ed0ad — runs calculated before the per-item stamp (and every additional run, which never stamps
    // one) have no item rows to contribute. Silence there reads as missing data.
    expect(pivotHistoryGrid({ rows: [slip()], year: 2026 }).detailNotRecorded).toBe(true);
    const stamped = pivotHistoryGrid({
      rows: [
        slip({
          statutory: {
            epfEmployee: 330,
            componentLines: [
              { code: 'MEAL', name: 'Meal allowance', amount: 500, buckets: [{ bucket: 'wage', amount: 500 }] },
            ],
          },
          totalDeductions: '330.00',
        }),
      ],
      year: 2026,
    });
    expect(stamped.detailNotRecorded).toBe(false);
  });
});

describe('080de5cf — the two switches from the reference', () => {
  const grid = pivotHistoryGrid({
    rows: [
      slip({
        statutory: {
          epfEmployee: 330,
          socsoEmployee: 18.65,
          eisEmployee: 7.9,
          pcb: 73.45,
          componentLines: [
            { code: 'MEAL', name: 'Meal allowance', amount: 200, buckets: [{ bucket: 'wage', amount: 200 }] },
          ],
        },
      }),
    ],
    year: 2026,
  });

  it('hide-zero drops rows that are all zeroes and nothing else', () => {
    const all = filterGridRows(grid.rows, { hideZero: false, hideSystem: false });
    const hidden = filterGridRows(grid.rows, { hideZero: true, hideSystem: false });
    expect(hidden.length).toBeLessThan(all.length);
    // …every surviving row carries an amount, apart from the one whose zero is itself the statement
    // (see the HRDF case below).
    expect(hidden.every((r) => r.notRegistered || r.months.some((m) => m !== 0))).toBe(true);
    // CP38 is zero on this payslip and must be gone; BASIC is not and must remain.
    expect(hidden.some((r) => r.code === 'CP38')).toBe(false);
    expect(hidden.some((r) => r.code === 'BASIC' && r.kind === 'synthetic')).toBe(true);
  });

  it('hide-zero keeps the HRDF row when its zero is “not registered” rather than an amount', () => {
    // efece4ce again, one layer up: the row that EXPLAINS a zero is the one row hide-zero must not eat,
    // or the default switch state recreates the ambiguity the row exists to remove.
    const unreg = pivotHistoryGrid({ rows: [slip()], year: 2026, hrdfRegisteredCompanyIds: [] });
    const hidden = filterGridRows(unreg.rows, { hideZero: true, hideSystem: false });
    expect(hidden.some((r) => r.code === 'HRDF')).toBe(true);
    // A registered company that simply levied nothing this year has nothing to say, and is dropped.
    const reg = pivotHistoryGrid({
      rows: [slip()],
      year: 2026,
      hrdfRegisteredCompanyIds: ['00000000-0000-0000-0000-0000000000c1'],
    });
    expect(filterGridRows(reg.rows, { hideZero: true, hideSystem: false }).some((r) => r.code === 'HRDF')).toBe(
      false,
    );
  });

  it('hide-system leaves exactly the pay items the operator keyed', () => {
    const items = filterGridRows(grid.rows, { hideZero: false, hideSystem: true });
    expect(items.map((r) => r.code)).toEqual(['MEAL']);
  });
});

describe('080de5cf — month parameter coercion', () => {
  it('accepts the checkboxes’ repeated params and the panel’s comma-joined value alike', () => {
    // The form posts ?months=1&months=2; the employee panel carries the same selection as one comma-joined
    // value because its `preserve` map is flat. Both have to mean the same thing or switching employee
    // would silently widen the filter.
    expect(cleanMonths(['1', '2', '3'])).toEqual([1, 2, 3]);
    expect(cleanMonths('1,2,3')).toEqual([1, 2, 3]);
    expect(cleanMonths(['3', '1', '3'])).toEqual([1, 3]);
  });

  it('an absent or nonsensical value means ALL twelve months, never none', () => {
    // Failing to none would blank the grid on a tampered or stale link, which reads as "this employee was
    // never paid" — the worst possible way for a filter to fail on a reconciliation screen.
    expect(cleanMonths(undefined)).toHaveLength(12);
    expect(cleanMonths('')).toHaveLength(12);
    expect(cleanMonths('0,13,abc')).toHaveLength(12);
    expect(cleanMonths(['DROP TABLE'])).toHaveLength(12);
  });
});

/** Dotted lookup into the catalog, the same shape test/function-access.test.ts uses for its own
 *  dynamically-resolved label keys. */
function getPath(obj: unknown, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

describe('080de5cf — the dynamic row labels resolve', () => {
  // The grid resolves `view.grid.row.<key>` and `view.grid.section.<key>` with COMPUTED t() keys, which
  // check C of test/i18n-coverage.test.ts cannot see. Without this the first missing caption would ship as
  // a raw MISSING_MESSAGE on screen, having passed tsc, the suite and `next build` — the failure mode
  // AGENTS.md calls out by name.
  const NS = 'payroll.transactions.view.grid';

  it('every synthetic row key has a caption in en.json', () => {
    const missing = SYNTHETIC_LABEL_KEYS.filter((k) => typeof getPath(en, `${NS}.row.${k}`) !== 'string');
    expect(missing, `synthetic rows with no caption: ${missing.join(', ')}`).toEqual([]);
  });

  it('every section heading resolves too', () => {
    for (const k of ['earnings', 'deductions', 'employer', 'items', 'summary']) {
      expect(typeof getPath(en, `${NS}.section.${k}`), `section.${k}`).toBe('string');
    }
  });
});
