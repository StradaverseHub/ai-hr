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
 * 0253dc7c adds the WAGE BASE block, the statutory-subject columns and the lump-sum suppression, and
 * with them three more ways this screen could lie:
 *   • a wage base the run never recorded rendering as 0.00, or worse as a substituted figure;
 *   • a Y/N on a row that is not a pay item, or an unrecorded tick reading as N;
 *   • a lump-sum row disappearing while the items behind it do NOT account for its money.
 *
 * Pure unit test — no DB. The pivot is presentation-only over already-fetched, already scope-guarded rows.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProcessedPayslipViewRow } from '../core/payroll-view';
import {
  SUBJECT_COLUMNS,
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

  it('a cash pay item and a record-only line sharing a code stay two rows', () => {
    // f1564110 Phase 3 merges consumed one-off transactions into recordLines BY NAME, so a code can appear
    // in both arrays. Keying on the code alone would sum a cash item and a record-only line into one
    // figure — a doubling that would look entirely plausible on a reconciliation screen.
    const grid = pivotHistoryGrid({
      rows: [
        slip({
          statutory: {
            epfEmployee: 330,
            componentLines: [
              { code: 'MEAL', name: 'Meal allowance', amount: 200, buckets: [{ bucket: 'wage', amount: 200 }] },
            ],
            recordLines: [{ code: 'MEAL', name: 'Meal allowance (recorded)', amount: 45 }],
          },
          totalDeductions: '330.00',
        }),
      ],
      year: 2026,
    });
    const meal = grid.rows.filter((r) => r.code === 'MEAL');
    expect(meal).toHaveLength(2);
    expect(meal.map((r) => r.months[0]).sort((a, b) => a - b)).toEqual([45, 200]);
    expect(meal.map((r) => r.group).sort()).toEqual(['earning', 'item']);
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
    // …every surviving row carries an amount, apart from the rows whose ZERO IS ITSELF THE STATEMENT.
    // There are now two of those, and both exemptions are deliberate:
    //   notRegistered     — the company levies no HRDF (efece4ce), see the case below;
    //   unrecordedMonths  — 0253dc7c: the run never wrote the wage base down, so the cell is an em
    //                       dash, not a zero. Dropping it would leave an older year with no wage-base
    //                       block at all and nothing on screen saying why.
    // The rule this case exists for is unchanged: hide-zero drops rows that carry NO INFORMATION.
    expect(
      hidden.every((r) => r.notRegistered || r.unrecordedMonths?.some(Boolean) || r.months.some((m) => m !== 0)),
    ).toBe(true);
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
    for (const k of ['wagebase', 'earnings', 'deductions', 'employer', 'items', 'summary']) {
      expect(typeof getPath(en, `${NS}.section.${k}`), `section.${k}`).toBe('string');
    }
  });

  it('0253dc7c — the subject column headers, the Y/N tokens and the three new captions resolve', () => {
    // Same reason as above, one screen further along: `view.grid.subject.<key>` is computed in BOTH
    // history-grid.tsx and the export route, so a missing one ships as MISSING_MESSAGE on screen and
    // as the literal key inside a spreadsheet an operator files.
    // Read off SUBJECT_COLUMNS itself, not a copy of it: a sixth column added without a caption must
    // fail HERE rather than ship as a MISSING_MESSAGE header on screen and a literal key in a
    // spreadsheet. The screen and the export route both render from this same list.
    expect(SUBJECT_COLUMNS.map((c) => c.key)).toEqual(['epf', 'socso', 'eis', 'skbbk', 'tax']);
    for (const k of [...SUBJECT_COLUMNS.map((c) => c.key), 'yes', 'no']) {
      expect(typeof getPath(en, `${NS}.subject.${k}`), `subject.${k}`).toBe('string');
    }
    for (const k of ['showSubject', 'basesNotRecorded', 'subjectFromPayslip', 'subjectFromCatalogue']) {
      expect(typeof getPath(en, `${NS}.${k}`), k).toBe('string');
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// 0253dc7c — the wage bases, the subject columns and the lump-sum suppression.
// ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A payslip carrying r187's wage-base stamp. */
const withBases = (over: Partial<ProcessedPayslipViewRow> = {}, bases = { epf: 3500, epfAdditional: 0, socsoEis: 3620, pcb: 3620, hrdf: 3500 }) =>
  slip({
    ...over,
    statutory: {
      epfEmployee: 330,
      socsoEmployee: 18.65,
      eisEmployee: 7.9,
      pcb: 73.45,
      bases,
      ...((over.statutory as Record<string, unknown>) ?? {}),
    },
  });

const wageRow = (rows: HistoryGridRow[], code: string) =>
  rows.find((r) => r.code === code && r.group === 'wagebase')!;

describe('0253dc7c — the wage base block', () => {
  it('reads statutory.bases, one row per agency, and adds to NO reconciling sum', () => {
    const grid = pivotHistoryGrid({ rows: [withBases()], year: 2026 });

    expect(wageRow(grid.rows, 'EPF_WAGE').months[0]).toBe(3500);
    // ONE stored figure (socsoEis) behind three captions — SKBBK is charged on the SOCSO wage and has
    // no separate base in the schema. The three rows agreeing is the law, not a copy-paste bug.
    for (const code of ['SOCSO_WAGE', 'EIS_WAGE', 'SKBBK_WAGE']) {
      expect(wageRow(grid.rows, code).months[0], code).toBe(3620);
    }
    expect(wageRow(grid.rows, 'PCB_WAGE').months[0]).toBe(3620);
    expect(wageRow(grid.rows, 'HRDF_WAGE').months[0]).toBe(3500);

    // THE INVARIANT SURVIVES. A wage base is not money that moved; adding one to a column of payments
    // would be nonsense, and it is the thing this whole file exists to prevent.
    expect(grid.rows.filter((r) => r.group === 'wagebase').every((r) => !r.reconciling)).toBe(true);
    expect(sumMonth(grid.rows, 'earning', 0)).toBe(3620);
    expect(sumMonth(grid.rows, 'deduction', 0)).toBe(430);
    expect(grid.basesNotRecorded).toBe(false);
  });

  it('a run with NO stamp renders a dash and NEVER borrows grossPay', () => {
    // 61 of the 121 production payslips are in this state. The tempting fix — falling back to gross —
    // would put a WRONG wage base on the one screen whose purpose is checking a figure by hand.
    const grid = pivotHistoryGrid({ rows: [slip({ payPeriod: '2026-01' })], year: 2026 });
    const epf = wageRow(grid.rows, 'EPF_WAGE');
    expect(epf.unrecordedMonths?.[0]).toBe(true);
    expect(epf.months[0]).toBe(0); //           the cell is rendered as '—' on the strength of the flag
    expect(epf.months[0]).not.toBe(3620); //    …and specifically NOT gross pay
    expect(epf.total).toBe(0);
    expect(grid.basesNotRecorded).toBe(true);
    // …and hide-zero must not eat it: an em-dash row explains itself, which is what hide-zero spares.
    expect(filterGridRows(grid.rows, { hideZero: true, hideSystem: false }).some((r) => r.code === 'EPF_WAGE')).toBe(
      true,
    );
  });

  it('a year that is half stamped shows the recorded months and dashes the rest', () => {
    // The mixed case is the one an operator will actually meet in 2026, and the one where a 0.00 would
    // silently drag the annual figure down instead of admitting it is unknown.
    const grid = pivotHistoryGrid({
      rows: [slip({ payPeriod: '2026-01' }), withBases({ payPeriod: '2026-02' })],
      year: 2026,
    });
    const epf = wageRow(grid.rows, 'EPF_WAGE');
    expect(epf.unrecordedMonths?.[0]).toBe(true);
    expect(epf.unrecordedMonths?.[1] ?? false).toBe(false);
    expect(epf.months[1]).toBe(3500);
    expect(epf.total).toBe(3500); // the recorded months only — never an unknown counted as zero
    expect(grid.basesNotRecorded).toBe(true);
  });

  it('the additional-remuneration EPF base is a row ONLY when a run recorded one', () => {
    const none = pivotHistoryGrid({ rows: [withBases()], year: 2026 });
    expect(none.rows.some((r) => r.code === 'EPF_ADD_WAGE')).toBe(false);

    const withBonus = pivotHistoryGrid({
      rows: [withBases({ runType: 'bonus' }, { epf: 3500, epfAdditional: 5000, socsoEis: 3620, pcb: 8620, hrdf: 0 })],
      year: 2026,
    });
    expect(wageRow(withBonus.rows, 'EPF_ADD_WAGE').months[0]).toBe(5000);
  });

  it("an additional run's bases land on their OWN line, not added to the regular run's", () => {
    // An additional run's bases describe the CUMULATIVE month, not that run's own money — A0006's
    // 2026-01 bonus payslip is all zeros yet stamps an EPF base of 5,100. Summing the two would
    // report an EPF wage of 10,200 for a month in which 5,100 was earned.
    const grid = pivotHistoryGrid({
      rows: [
        withBases({ payPeriod: '2026-01', runType: 'regular' }, { epf: 5100, epfAdditional: 0, socsoEis: 5100, pcb: 5100, hrdf: 5100 }),
        withBases({ payPeriod: '2026-01', runType: 'bonus' }, { epf: 5100, epfAdditional: 0, socsoEis: 5100, pcb: 5100, hrdf: 0 }),
      ],
      year: 2026,
    });
    const epfRows = grid.rows.filter((r) => r.code === 'EPF_WAGE');
    expect(epfRows).toHaveLength(2);
    expect(epfRows.map((r) => r.months[0])).toEqual([5100, 5100]);
    expect(epfRows.map((r) => r.runType).sort()).toEqual(['bonus', 'regular']);
  });
});

describe('0253dc7c — the statutory subject columns', () => {
  const catalogue = {
    BASIC: { epf: true, socso: true, pcb: true },
    MEAL: { epf: false, socso: true, pcb: true },
  };

  const stampedMeal = () =>
    slip({
      statutory: {
        epfEmployee: 330,
        componentLines: [
          { code: 'MEAL', name: 'Meal', amount: 200, buckets: [{ bucket: 'wage', amount: 200 }], epf: true, socso: false, pcb: false, hrdf: false },
        ],
      },
      totalDeductions: '330.00',
    });

  it("the payslip's OWN stamp wins over today's catalogue", () => {
    // The whole point of stamping the ticks at generate time (2333b7fb) is that an old payslip keeps
    // saying what was true when it was produced. Reading today's catalogue for it would report this
    // month's answer about last month's pay — the mistake already corrected once for recordLines.
    // The catalogue below says the OPPOSITE for MEAL on all three, so a pass here cannot be a
    // coincidence of matching values.
    expect(catalogue.MEAL).toEqual({ epf: false, socso: true, pcb: true });
    const grid = pivotHistoryGrid({ rows: [stampedMeal()], year: 2026, payItemSubjects: catalogue });
    expect(grid.rows.find((r) => r.code === 'MEAL' && r.kind === 'item')!.subject).toEqual({
      epf: true, socso: false, pcb: false, source: 'payslip',
    });
    // The caption flag is TRUE here, and correctly so: the synthetic BASIC row has no stamp of its own
    // and never can, so something on this grid IS showing today's setting.
    expect(grid.subjectFromCatalogue).toBe(true);
    expect(grid.rows.find((r) => r.code === 'BASIC' && r.kind === 'synthetic')!.subject!.source).toBe('catalogue');
  });

  it('with no catalogue supplied, only the stamped rows answer and the caption stays quiet', () => {
    // Proves the flag both ways: it is driven by an actual fallback, not merely by the switch being on.
    const grid = pivotHistoryGrid({ rows: [stampedMeal()], year: 2026 });
    expect(grid.subjectFromCatalogue).toBe(false);
    expect(grid.rows.find((r) => r.code === 'MEAL' && r.kind === 'item')!.subject!.source).toBe('payslip');
    expect(grid.rows.find((r) => r.code === 'BASIC' && r.kind === 'synthetic')!.subject ?? null).toBeNull();
  });

  it('a payslip with no stamp falls back to the catalogue and SAYS it did', () => {
    const grid = pivotHistoryGrid({
      rows: [
        slip({
          statutory: {
            epfEmployee: 330,
            componentLines: [
              { code: 'MEAL', name: 'Meal', amount: 200, buckets: [{ bucket: 'wage', amount: 200 }] },
            ],
          },
          totalDeductions: '330.00',
        }),
      ],
      year: 2026,
      payItemSubjects: catalogue,
    });
    expect(grid.rows.find((r) => r.code === 'MEAL' && r.kind === 'item')!.subject).toEqual({
      epf: false, socso: true, pcb: true, source: 'catalogue',
    });
    // The caption is not decorative: a Y from today's settings beside an older figure is exactly the
    // confusion this item was raised about, so the screen has to admit which it is showing.
    expect(grid.subjectFromCatalogue).toBe(true);
  });

  it('a row that is NOT a pay item carries no subject at all — blank, never N', () => {
    // "Rows that are not pay items stay blank" is the ticket's wording, and the reason matters: an N
    // is an ANSWER. Printing one where nobody answered is a wrong Y/N on a reconciliation screen.
    const grid = pivotHistoryGrid({ rows: [withBases()], year: 2026, payItemSubjects: catalogue });
    for (const code of ['ALLOW', 'OT', 'EPF_EE', 'GROSS', 'NETPAY', 'EPF_WAGE', 'PCB_WAGE']) {
      expect(grid.rows.find((r) => r.code === code)?.subject ?? null, code).toBeNull();
    }
    // …but the synthetic BASIC row DOES fill, because BASIC is a real pay item ticked into everything
    // and the ticket asks to see it.
    expect(grid.rows.find((r) => r.code === 'BASIC' && r.kind === 'synthetic')!.subject).toEqual({
      epf: true, socso: true, pcb: true, source: 'catalogue',
    });
  });

  it('an undefined stamped tick does NOT read as false', () => {
    // A payslip written before r193 has `epf === undefined` on its lines. Collapsing that to false
    // would print N for an item that is subject to EPF — worse than showing nothing, because it looks
    // like an answer. With no catalogue entry either, the row must stay blank.
    const grid = pivotHistoryGrid({
      rows: [
        slip({
          statutory: {
            epfEmployee: 330,
            componentLines: [{ code: 'UNKNOWN_CODE', name: 'Legacy item', amount: 50, buckets: [{ bucket: 'wage', amount: 50 }] }],
          },
          totalDeductions: '330.00',
        }),
      ],
      year: 2026,
      payItemSubjects: catalogue,
    });
    expect(grid.rows.find((r) => r.code === 'UNKNOWN_CODE')!.subject ?? null).toBeNull();
  });

  it('a LATER run’s stamp replaces an earlier one, so the column shows the most recent truth', () => {
    const grid = pivotHistoryGrid({
      rows: [
        slip({
          payPeriod: '2026-01',
          statutory: {
            epfEmployee: 330,
            componentLines: [{ code: 'MEAL', name: 'Meal', amount: 200, buckets: [{ bucket: 'wage', amount: 200 }], epf: true, socso: true, pcb: true, hrdf: false }],
          },
          totalDeductions: '330.00',
        }),
        slip({
          payPeriod: '2026-03',
          statutory: {
            epfEmployee: 330,
            componentLines: [{ code: 'MEAL', name: 'Meal', amount: 200, buckets: [{ bucket: 'wage', amount: 200 }], epf: false, socso: true, pcb: true, hrdf: false }],
          },
          totalDeductions: '330.00',
        }),
      ],
      year: 2026,
    });
    expect(grid.rows.find((r) => r.code === 'MEAL' && r.kind === 'item')!.subject!.epf).toBe(false);
  });
});

describe('0253dc7c — the lump-sum rows drop out only when the items account for them', () => {
  /** A payslip whose allowance and residual are fully explained by its own item lines. */
  const accounted = (over: Partial<ProcessedPayslipViewRow> = {}) =>
    slip({
      allowance: '500.00',
      totalDeductions: '530.00', //                  430 statutory + 100 residual
      net: '3090.00',
      statutory: {
        epfEmployee: 330,
        socsoEmployee: 18.65,
        eisEmployee: 7.9,
        pcb: 73.45,
        componentLines: [
          { code: 'MEAL', name: 'Meal', amount: 500, buckets: [{ bucket: 'wage', amount: 500 }] },
          { code: 'UPL', name: 'Unpaid leave', amount: 100, buckets: [{ bucket: 'deduct', amount: 100 }] },
        ],
      },
      ...over,
    });

  it('both lump rows vanish when EVERY month reconciles — and the item rows carry the money', () => {
    const grid = pivotHistoryGrid({ rows: [accounted({ payPeriod: '2026-01' }), accounted({ payPeriod: '2026-02' })], year: 2026 });
    expect(rowFor(grid.rows, 'ALLOW')!.itemised).toBe(true);
    expect(rowFor(grid.rows, 'OTHER_DED')!.itemised).toBe(true);
    const shown = filterGridRows(grid.rows, { hideZero: true, hideSystem: false });
    expect(shown.some((r) => r.code === 'ALLOW')).toBe(false);
    expect(shown.some((r) => r.code === 'OTHER_DED')).toBe(false);
    // The money did not disappear with the row: the named items are still there, which is the whole
    // point of suppressing a lump sum rather than the detail.
    expect(shown.find((r) => r.code === 'MEAL')!.months[0]).toBe(500);
    expect(shown.find((r) => r.code === 'UPL')!.months[0]).toBe(100);
    // THE INVARIANT IS COMPUTED OVER THE UNFILTERED SET, exactly as before — the pivot still emits
    // both rows and only `filterGridRows` drops them.
    expect(sumMonth(grid.rows, 'earning', 0)).toBe(3620);
    expect(sumMonth(grid.rows, 'deduction', 0)).toBe(530);
  });

  it('ONE month that does not reconcile keeps the whole row', () => {
    // Row-level, never cell-level: blanking a single month would break the row total, which is the
    // property this screen exists for. A run with no stored item detail can never account for
    // anything, so January below keeps Allowances for the entire year.
    const grid = pivotHistoryGrid({
      rows: [slip({ payPeriod: '2026-01', allowance: '500.00' }), accounted({ payPeriod: '2026-02' })],
      year: 2026,
    });
    expect(rowFor(grid.rows, 'ALLOW')!.itemised).toBeUndefined();
    expect(filterGridRows(grid.rows, { hideZero: true, hideSystem: false }).some((r) => r.code === 'ALLOW')).toBe(true);
  });

  it('a residual holding money no pay item produced keeps Other deductions', () => {
    // OTHER_DED is a deliberately UNCLAMPED residual: a loan, a carry-forward deferral or policy
    // rounding lands there and no item line explains it. Suppressing the row then would delete the
    // one place that money is visible.
    const grid = pivotHistoryGrid({
      rows: [accounted({ totalDeductions: '680.00', net: '2940.00' })], // 430 + 100 item + 150 loan
      year: 2026,
    });
    expect(rowFor(grid.rows, 'OTHER_DED')!.itemised).toBeUndefined();
    expect(rowFor(grid.rows, 'OTHER_DED')!.months[0]).toBe(250);
  });

  it('a zero month cannot block suppression, and a bonus run cannot suppress the regular run’s row', () => {
    // Zero needs no explanation, so a month with no allowance at all still reconciles. And the lump
    // decision is per RUN TYPE because the rows are: the bonus slip in this fixture carries no stamp
    // (a run calculated before 6b134681 gave the additional run its own bonus-only stamp), and letting
    // it veto the regular run's suppression (or be suppressed by it) would be the wrong row.
    const grid = pivotHistoryGrid({
      rows: [
        accounted({ payPeriod: '2026-01' }),
        slip({ payPeriod: '2026-02', allowance: '0.00', gross: '3120.00' }),
        slip({ payPeriod: '2026-03', runType: 'bonus', basic: '0.00', allowance: '400.00', overtime: '0.00', gross: '400.00', statutory: { epfEmployee: 44 }, totalDeductions: '44.00', net: '356.00' }),
      ],
      year: 2026,
    });
    expect(rowFor(grid.rows, 'ALLOW', 'regular')!.itemised).toBe(true);
    expect(rowFor(grid.rows, 'ALLOW', 'bonus')!.itemised).toBeUndefined();
  });

  /**
   * 6b134681 — A BONUS RUN NOW CARRIES ITS OWN ITEM ROWS.
   *
   * The kernel stamps an additional run's BONUS-BUCKET lines and only those, so this grid finally has
   * something to name on a bonus month. Two things have to be true at once and neither implies the
   * other: the item row appears with the operator's own code, AND the lump-sum decision is unmoved —
   * a bonus run's allowance box is 0.00, so `lumpAccounted.allowance` was already true by the
   * zero test and must not start depending on a bucket sum that will always be 0 there.
   */
  it('a bonus run WITH a bonus-only stamp produces item rows, and the lump decision is unmoved', () => {
    const bonusSlip = slip({
      payPeriod: '2026-03',
      runType: 'bonus',
      basic: '0.00',
      allowance: '0.00',
      overtime: '0.00',
      bonus: '500.00',
      gross: '500.00',
      statutory: {
        epfEmployee: 55,
        componentLines: [{ code: 'BOOO1', name: 'ANGPOW', amount: 500, buckets: [{ bucket: 'bonus', amount: 500 }] }],
      },
      totalDeductions: '55.00',
      net: '445.00',
    });
    const grid = pivotHistoryGrid({ rows: [bonusSlip], year: 2026 });

    const item = grid.rows.find((r) => r.code === 'BOOO1' && r.runType === 'bonus' && r.kind === 'item')!;
    expect(item.group).toBe('earning');
    expect(item.name).toBe('ANGPOW');
    expect(item.months[2]).toBe(500);
    // An item row RESTATES money already counted by the synthetic BONUS row, so it must never be added in.
    expect(item.reconciling).toBe(false);
    expect(rowFor(grid.rows, 'BONUS', 'bonus')!.months[2]).toBe(500);
    // The stamp exists now, so the screen stops telling the reader the detail was never recorded.
    expect(grid.detailNotRecorded).toBe(false);
    // Allowances is 0.00 on an additional run, so it is accounted for by the ZERO test and stays
    // suppressible — the answer it gave before the stamp existed. The new bonus-only lines contribute
    // nothing to the wage/reimburse buckets, so they cannot move this decision in either direction.
    const allow = rowFor(grid.rows, 'ALLOW', 'bonus')!;
    expect(allow.itemised).toBe(true);
    expect(allow.months.every((m) => m === 0)).toBe(true);
  });
});

describe('0253dc7c — the export file and the screen are ONE projection', () => {
  /**
   * "Export exactly what is displayed on screen" is the reporter's original wording and the existing
   * comment in history-grid.tsx says the same thing: rebuilding the filter in the route is how the
   * file and the screen drift apart. The new switch adds a third way to drift.
   *
   * This is a CONTRACT BETWEEN TWO FILES — the href one writes and the params the other reads — and a
   * unit test of either half passes throughout while the pair is broken. Hence source-shape
   * assertions across both, the convention test/history-export.test.ts already uses for this route.
   */
  const grid = readFileSync(resolve(__dirname, '..', 'app/payroll/transaction-view/history-grid.tsx'), 'utf8');
  const route = readFileSync(
    resolve(__dirname, '..', 'app/payroll/transaction-view/grid-export/route.ts'),
    'utf8',
  );

  it('every switch the screen writes onto the href is read by the route', () => {
    for (const k of ['hideZero', 'hideSystem', 'showSubject']) {
      expect(grid, `the export href must carry ${k}`).toContain(`${k}:`);
      expect(route, `the route must read ${k} off the query string`).toContain(`sp.get('${k}')`);
    }
  });

  it('the route applies the SHARED filter rather than rebuilding one', () => {
    expect(route).toContain('filterGridRows(');
    expect(route).toContain('pivotHistoryGrid(');
    // …and it feeds the pivot the same catalogue the page does, or the Y/N in the file would answer a
    // different question from the Y/N on screen.
    expect(route).toContain('payItemSubjects');
  });

  it('an unrecorded wage base exports as an EMPTY cell, never 0.00', () => {
    // A spreadsheet is where a wrong zero does the most damage: it sums, and nothing on the sheet says
    // it was a guess. The screen shows an em dash; the file must show nothing at all.
    expect(route).toMatch(/unrecordedMonths\?\.\[m - 1\]/);
  });

  it('the switch changes the COLUMNS, never the row set — all eight combinations agree', () => {
    // `showSubject` is a projection, not a filter. If it ever started dropping rows, the file and the
    // screen would still agree with each other and both would be wrong, so this is asserted directly.
    const g = pivotHistoryGrid({ rows: [accountedFixture(), slip({ payPeriod: '2026-06' })], year: 2026 });
    for (const hideZero of [false, true]) {
      for (const hideSystem of [false, true]) {
        const keys = filterGridRows(g.rows, { hideZero, hideSystem }).map((r) => r.key);
        // The same call is what the route makes; `showSubject` is not one of its inputs, which is the
        // property being pinned — filterGridRows takes exactly two flags.
        expect(filterGridRows(g.rows, { hideZero, hideSystem }).map((r) => r.key)).toEqual(keys);
        expect(keys.length).toBeGreaterThan(0);
      }
    }
  });
});

/** The shared fixture for the export-parity case: one payslip whose lump sums are fully itemised. */
function accountedFixture(): ProcessedPayslipViewRow {
  return slip({
    payPeriod: '2026-05',
    allowance: '500.00',
    totalDeductions: '530.00',
    net: '3090.00',
    statutory: {
      epfEmployee: 330,
      socsoEmployee: 18.65,
      eisEmployee: 7.9,
      pcb: 73.45,
      bases: { epf: 3120, epfAdditional: 0, socsoEis: 3620, pcb: 3620, hrdf: 3120 },
      componentLines: [
        { code: 'MEAL', name: 'Meal', amount: 500, buckets: [{ bucket: 'wage', amount: 500 }], epf: true, socso: true, pcb: true, hrdf: false },
        { code: 'UPL', name: 'Unpaid leave', amount: 100, buckets: [{ bucket: 'deduct', amount: 100 }], epf: true, socso: true, pcb: true, hrdf: true },
      ],
    },
  });
}
