/**
 * 0fcb2557 — the Transaction View › History "Export to Excel" builder.
 *
 * The file this builds is used to RECONCILE payroll against the screen, so the defects worth pinning are
 * the ones that would produce a plausible-looking spreadsheet that is wrong:
 *   • a figure that disagrees with the expanded panel it was taken from (the employee-share trap);
 *   • a named allowance printing 0 on a payslip it was never on, which is a claim, not a blank;
 *   • recorded items — a MIXED population that includes negative deductions and no-cash-impact lines —
 *     merged into the allowance columns, where their codes can collide with real earnings;
 *   • "RM 5,600.00" instead of 5600.00, which turns a summable column into text;
 *   • a grand-total row inside the table, which is what breaks Excel's own sort and filter;
 *   • the "no per-item detail was saved" note missing, so a blank column reads as a bug in the payroll.
 *
 * Pure unit test — no DB. The builder is presentation-only over already-fetched, already scope-guarded
 * rows, exactly like test/history-pivot.test.ts next door.
 */
import { describe, expect, it } from 'vitest';
import type { ProcessedPayslipViewRow } from '../core/payroll-view';
import { deriveHistoryBreakdown } from '../app/payroll/transaction-view/history-breakdown';
import {
  HISTORY_EXPORT_FIXED_COLUMNS,
  HISTORY_EXPORT_FREEZE,
  RECORDED_ITEM_PREFIX,
  buildHistoryExport,
} from '../app/payroll/transaction-view/history-export';
import { toXlsxReport } from '../lib/report-export';
import en from '../messages/en.json';

let seq = 0;
function slip(overrides: Partial<ProcessedPayslipViewRow> = {}): ProcessedPayslipViewRow {
  seq += 1;
  return {
    id: `00000000-0000-0000-0000-00000000${String(seq).padStart(4, '0')}`,
    employmentId: '00000000-0000-0000-0000-0000000000e1',
    employeeName: 'Ismail bin Hassan',
    employeeCode: '100180',
    companyId: '00000000-0000-0000-0000-0000000000c1',
    company: 'ISEDECOR BINA SDN BHD',
    payPeriod: '2026-01',
    runType: 'regular',
    runSeq: 1,
    batchStatus: 'processed',
    releasedAt: null,
    version: 1,
    // The reporter's own screenshot: 5500 basic + 100 handphone allowance = 5600 gross,
    // 616.00 + 27.75 + 11.10 + 1680.00 = 2334.85 deducted, 3265.15 net.
    basic: '5500.00',
    allowance: '100.00',
    overtime: '0.00',
    bonus: '0.00',
    gross: '5600.00',
    statutory: {
      epfEmployee: 616,
      socsoEmployee: 27.75,
      eisEmployee: 11.1,
      pcb: 1680,
      epfEmployer: 672,
      socsoEmployer: 97.15,
      eisEmployer: 11.1,
      hrdf: 56,
      componentLines: [
        { code: 'HANDPHONE', name: 'Handphone Allowance', amount: 100, buckets: [{ bucket: 'wage', amount: 100 }] },
      ],
    },
    totalDeductions: '2334.85',
    net: '3265.15',
    ...overrides,
  };
}

const HRDF_COMPANY = '00000000-0000-0000-0000-0000000000c1';

const build = (rows: ProcessedPayslipViewRow[], extra: Record<string, unknown> = {}) =>
  buildHistoryExport({
    rows,
    hrdfRegisteredCompanyIds: [HRDF_COMPANY],
    cycleLabels: { regular: 'Regular', off_cycle: 'Off cycle', bonus: 'Bonus', adjustment: 'Adjustment' },
    statusLabels: { draft: 'Draft', processed: 'Processed', closed: 'Closed' },
    title: 'Payroll Transaction History',
    filename: 'payroll-transaction-history',
    filterCaption: 'This view',
    filterDescription: 'Company: All  ·  Employee: All',
    detailNote: 'DETAIL-NOTE',
    ...extra,
  });

/** Index of a column by header, or -1. */
const col = (data: { columns: string[] }, header: string) => data.columns.indexOf(header);

describe('0fcb2557 — the History export is ONE wide sheet', () => {
  it('every payslip is one row, and the named allowance is a COLUMN rather than a buried line', () => {
    const data = build([slip()]);

    // The fixed block, then the named-item block. One sheet — there is no second table anywhere in the
    // shape, because ReportData carries exactly one.
    expect(data.columns.slice(0, HISTORY_EXPORT_FIXED_COLUMNS.length)).toEqual([...HISTORY_EXPORT_FIXED_COLUMNS]);
    expect(data.columns).toContain('Handphone Allowance');
    expect(data.rows).toHaveLength(1);

    const r = data.rows[0];
    expect(r[col(data, 'Payroll Period')]).toBe('2026-01');
    expect(r[col(data, 'Payroll Cycle')]).toBe('Regular');
    expect(r[col(data, 'Employee ID')]).toBe('100180');
    expect(r[col(data, 'Employee Name')]).toBe('Ismail bin Hassan');
    expect(r[col(data, 'Company')]).toBe('ISEDECOR BINA SDN BHD');
    expect(r[col(data, 'Status')]).toBe('Processed');
    expect(r[col(data, 'Handphone Allowance')]).toBe('100.00');
  });

  it('THE INVARIANT: Gross, Total Deductions and Net are the screen’s own figures, not a recalculation', () => {
    const rows = [
      slip(),
      // A second, differently-shaped month: 4000 + 210.50 = 4210.50 gross, so the decomposition below
      // reconciles by construction the way the kernel's own display overlay does.
      slip({
        payPeriod: '2025-12',
        basic: '4000.00',
        allowance: '210.50',
        gross: '4210.50',
        totalDeductions: '901.15',
        net: '3309.35',
      }),
    ];
    const data = build(rows);
    rows.forEach((row, i) => {
      const b = deriveHistoryBreakdown(row);
      const r = data.rows[i];
      expect(r[col(data, 'Gross')]).toBe(b.gross.toFixed(2));
      expect(r[col(data, 'Total Deductions')]).toBe(b.totalDeductions.toFixed(2));
      expect(r[col(data, 'Nett Wage')]).toBe(b.net.toFixed(2));
      // …and the earnings columns still decompose into that same gross.
      const earnings = ['Basic Salary', 'Allowances', 'OT Converted From Allowance', 'Overtime', 'Bonus', 'Claim']
        .map((c) => Number(r[col(data, c)]))
        .reduce((s, n) => s + n, 0);
      expect(Math.round(earnings * 100) / 100).toBe(b.gross);
    });
  });

  it('the employer block totals what the screen prints (RM836.25), and is not payslip.employerCost', () => {
    const data = build([slip()]);
    const r = data.rows[0];
    expect(r[col(data, 'Employer EPF')]).toBe('672.00');
    expect(r[col(data, 'Employer SOCSO')]).toBe('97.15');
    expect(r[col(data, 'Employer EIS')]).toBe('11.10');
    expect(r[col(data, 'HRDF')]).toBe('56.00');
    expect(r[col(data, 'Total Employer Contributions')]).toBe('836.25');
    // "Total Employer Cost" is the REGISTER's column and a different stored figure (it includes wages).
    expect(data.columns).not.toContain('Total Employer Cost');
  });

  it('NO grand-total row: the last row is a payslip, not a sum', () => {
    const data = build([slip(), slip({ payPeriod: '2025-12' }), slip({ payPeriod: '2025-11' })]);
    expect(data.rows).toHaveLength(3);
    // Every row identifies an employee and a period — a totals row would have neither.
    for (const r of data.rows) {
      expect(String(r[col(data, 'Employee Name')])).not.toBe('');
      expect(String(r[col(data, 'Payroll Period')])).toMatch(/^\d{4}-\d{2}$/);
    }
  });
});

describe('0fcb2557 — figures are numbers, not text', () => {
  it('money cells are bare numbers and the serializer marks them x:num', () => {
    const data = build([slip()]);
    const r = data.rows[0];
    for (const c of ['Gross', 'EPF', 'Total Deductions', 'Nett Wage', 'Handphone Allowance']) {
      // No "RM", no thousands separator — those make the cell text an operator cannot sum, which is the
      // one thing this file exists for.
      expect(String(r[col(data, c)]), c).toMatch(/^-?\d+\.\d{2}$/);
    }
    const xml = new TextDecoder().decode(toXlsxReport(data).bytes);
    expect(xml).toContain('x:num="5600.00"');
    expect(xml).toContain('x:num="3265.15"');
    expect(xml).not.toContain('RM 5,600.00');
  });

  it('a negative recorded item stays a negative NUMBER', () => {
    const data = build([
      slip({
        statutory: {
          recordLines: [{ code: 'ADVANCE', name: 'Salary advance', amount: -250 }],
        },
      }),
    ]);
    expect(data.rows[0][col(data, `${RECORDED_ITEM_PREFIX}Salary advance`)]).toBe('-250.00');
  });
});

describe('0fcb2557 — the named-item columns', () => {
  it('an item absent from a payslip leaves the cell EMPTY rather than printing 0', () => {
    // Two payslips, two different items. Printing 0 would assert "this employee got nothing under this
    // heading", which is a different — and usually wrong — statement from "this heading did not apply".
    const withTravel = slip({
      employeeName: 'Aisyah binti Rahman',
      statutory: {
        componentLines: [
          { code: 'TRAVEL', name: 'Travel Allowance', amount: 300, buckets: [{ bucket: 'wage', amount: 300 }] },
        ],
      },
    });
    const data = build([slip(), withTravel]);
    expect(data.columns).toContain('Handphone Allowance');
    expect(data.columns).toContain('Travel Allowance');
    expect(data.rows[0][col(data, 'Handphone Allowance')]).toBe('100.00');
    expect(data.rows[0][col(data, 'Travel Allowance')]).toBe('');
    expect(data.rows[1][col(data, 'Handphone Allowance')]).toBe('');
    expect(data.rows[1][col(data, 'Travel Allowance')]).toBe('300.00');
  });

  it('an item that IS on the payslip at zero still prints 0.00 — absent and nil are different', () => {
    const data = build([
      slip({
        statutory: {
          componentLines: [
            { code: 'HANDPHONE', name: 'Handphone Allowance', amount: 0, buckets: [{ bucket: 'wage', amount: 0 }] },
          ],
        },
      }),
    ]);
    expect(data.rows[0][col(data, 'Handphone Allowance')]).toBe('0.00');
  });

  it('dynamic columns are ordered by CODE, not by the order they were met', () => {
    const rows = [
      slip({
        statutory: {
          componentLines: [
            { code: 'ZULU', name: 'Zulu Allowance', amount: 10, buckets: [{ bucket: 'wage', amount: 10 }] },
          ],
        },
      }),
      slip({
        statutory: {
          componentLines: [
            { code: 'ALPHA', name: 'Alpha Allowance', amount: 20, buckets: [{ bucket: 'wage', amount: 20 }] },
            { code: 'MIKE', name: 'Mike Allowance', amount: 30, buckets: [{ bucket: 'wage', amount: 30 }] },
          ],
        },
      }),
    ];
    const data = build(rows);
    const dynamic = data.columns.slice(HISTORY_EXPORT_FIXED_COLUMNS.length);
    expect(dynamic).toEqual(['Alpha Allowance', 'Mike Allowance', 'Zulu Allowance']);
  });

  it('an item split across two buckets contributes its WHOLE stored amount to its single column', () => {
    // f3148da1 / the exempt-portion case: one item, two buckets. The per-bucket split stays visible on
    // screen and in the grid export; here it is one column, so the column must carry the whole item.
    const data = build([
      slip({
        statutory: {
          componentLines: [
            {
              code: 'MEAL',
              name: 'Meal Allowance',
              amount: 250,
              buckets: [
                { bucket: 'wage', amount: 150 },
                { bucket: 'reimburse', amount: 100 },
              ],
            },
          ],
        },
      }),
    ]);
    expect(data.rows[0][col(data, 'Meal Allowance')]).toBe('250.00');
  });

  it('two codes sharing one name are disambiguated rather than colliding into one heading', () => {
    const data = build([
      slip({
        statutory: {
          componentLines: [
            { code: 'ALLOW1', name: 'Allowance', amount: 10, buckets: [{ bucket: 'wage', amount: 10 }] },
            { code: 'ALLOW2', name: 'Allowance', amount: 20, buckets: [{ bucket: 'wage', amount: 20 }] },
          ],
        },
      }),
    ]);
    const dynamic = data.columns.slice(HISTORY_EXPORT_FIXED_COLUMNS.length);
    expect(dynamic).toEqual(['Allowance (ALLOW1)', 'Allowance (ALLOW2)']);
    expect(new Set(dynamic).size).toBe(dynamic.length);
  });

  it('recorded items get their OWN headed block and never merge with the named allowances', () => {
    // recordLines has been a MIXED population since f1564110 phase 3 (benefits in kind AND consumed
    // one-off provenance, deductions carrying a negative sign) and it can collide on code with a real
    // earning. Merging the two would put a negative deduction into an allowance column.
    const data = build([
      slip({
        statutory: {
          componentLines: [
            { code: 'HANDPHONE', name: 'Handphone Allowance', amount: 100, buckets: [{ bucket: 'wage', amount: 100 }] },
          ],
          recordLines: [{ code: 'HANDPHONE', name: 'Handphone Allowance', amount: -40 }],
        },
      }),
    ]);
    const dynamic = data.columns.slice(HISTORY_EXPORT_FIXED_COLUMNS.length);
    expect(dynamic).toEqual(['Handphone Allowance', `${RECORDED_ITEM_PREFIX}Handphone Allowance`]);
    expect(data.rows[0][col(data, 'Handphone Allowance')]).toBe('100.00');
    expect(data.rows[0][col(data, `${RECORDED_ITEM_PREFIX}Handphone Allowance`)]).toBe('-40.00');
  });

  it('two lines of the same code on one payslip are ADDED, never last-wins', () => {
    const data = build([
      slip({
        statutory: {
          componentLines: [
            { code: 'OTX', name: 'Overtime meal', amount: 30, buckets: [{ bucket: 'ot', amount: 30 }] },
            { code: 'OTX', name: 'Overtime meal', amount: 45, buckets: [{ bucket: 'ot', amount: 45 }] },
          ],
        },
      }),
    ]);
    expect(data.rows[0][col(data, 'Overtime meal')]).toBe('75.00');
  });
});

describe('0fcb2557 — the employee-share trap', () => {
  it('EPF / SOCSO / EIS / PCB follow employerBorne.employee, NOT the raw statutory blob', () => {
    // 3c473773 issue 2: with an "employer bears" flag set, the reported share still goes to KWSP but only
    // part of it came off take-home. The screen prints the take-home figure in both the summary row and
    // the expanded panel; a file that printed the reported share instead would disagree with the screen
    // it was taken from, on the one column finance checks first.
    const row = slip({
      statutory: {
        epfEmployee: 616,
        socsoEmployee: 27.75,
        eisEmployee: 11.1,
        pcb: 1680,
        socsoSkbbk: 5,
        employerBorne: { epf: 616, socso: 0, skbbk: 0, eis: 0, tax: 0 },
      },
    });
    const b = deriveHistoryBreakdown(row);
    expect(b.employerBorne.employee.epf).toBe(0); // the employer funded the whole share
    expect(b.employerBorne.reported.epf).toBe(616);

    const data = build([row]);
    expect(data.rows[0][col(data, 'EPF')]).toBe('0.00');
    expect(data.rows[0][col(data, 'SOCSO')]).toBe('27.75');
    expect(data.rows[0][col(data, 'SKBBK')]).toBe('5.00');
    // …and the header deliberately does NOT borrow the register's "(Employee)" wording, because the two
    // columns legitimately hold different numbers whenever an employer-bears flag is set.
    expect(data.columns).not.toContain('EPF (Employee)');
  });
});

describe('0fcb2557 — HRDF, and what an unregistered company prints', () => {
  it('a company outside the HRDF register gets a BLANK cell, not a 0', () => {
    // efece4ce — the levy resolves to 0 for a company with no HRDF Contribution Rate, so a printed 0 is
    // indistinguishable from a levy that failed to compute. The screen says "Not registered"; the file
    // leaves the cell empty, which is the spreadsheet equivalent and keeps the column summable.
    const unregistered = slip({
      statutory: {
        epfEmployee: 616,
        socsoEmployee: 27.75,
        eisEmployee: 11.1,
        pcb: 1680,
        epfEmployer: 672,
        socsoEmployer: 97.15,
        eisEmployer: 11.1,
        hrdf: 0,
      },
    });
    const data = buildHistoryExport({
      rows: [unregistered],
      hrdfRegisteredCompanyIds: [], // nobody registered
      title: 'T',
      filename: 'f',
    });
    expect(data.rows[0][col(data, 'HRDF')]).toBe('');
    // The employer total still closes: an unregistered company levies nothing.
    expect(data.rows[0][col(data, 'Total Employer Contributions')]).toBe('780.25');
    // No cycle/status captions were supplied, so the raw values pass through rather than printing blank.
    expect(data.rows[0][col(data, 'Payroll Cycle')]).toBe('regular');
  });
});

describe('0fcb2557 — the file says when per-item detail was never saved', () => {
  it('a run with no componentLines puts the note at the top and leaves the named columns blank', () => {
    // Bonus / off-cycle / adjustment runs never stamped per-item detail, and neither did anything
    // calculated before the 862ed0ad stamp. The summary figures are still exact; a blank column with no
    // explanation is what would read as a defect.
    const bonusRun = slip({
      payPeriod: '2025-12',
      runType: 'bonus',
      basic: '0.00',
      allowance: '0.00',
      bonus: '2000.00',
      gross: '2000.00',
      statutory: { epfEmployee: 220, pcb: 0 },
      totalDeductions: '220.00',
      net: '1780.00',
    });
    const data = build([slip(), bonusRun]);
    expect(data.layout?.header).toBe('DETAIL-NOTE');
    expect(data.rows[1][col(data, 'Payroll Cycle')]).toBe('Bonus');
    expect(data.rows[1][col(data, 'Handphone Allowance')]).toBe('');
    // The summary figures on that row are still exact.
    expect(data.rows[1][col(data, 'Gross')]).toBe('2000.00');
    expect(data.rows[1][col(data, 'Nett Wage')]).toBe('1780.00');
    expect(data.rows[1][col(data, 'Total Deductions')]).toBe('220.00');
  });

  it('the note is ABSENT when every run in the file recorded its detail', () => {
    const data = build([slip(), slip({ payPeriod: '2025-12' })]);
    expect(data.layout?.header).toBeNull();
  });
});

describe('0fcb2557 — layout the reporter was shown', () => {
  it('landscape, four frozen columns, and the filters printed at the top', () => {
    const data = build([slip()]);
    expect(data.layout?.orientation).toBe('landscape');
    expect(data.layout?.freeze).toBe(HISTORY_EXPORT_FREEZE);
    expect(HISTORY_EXPORT_FIXED_COLUMNS.slice(0, HISTORY_EXPORT_FREEZE)).toEqual([
      'Payroll Period',
      'Payroll Cycle',
      'Employee ID',
      'Employee Name',
    ]);
    expect(data.layout?.subtitle).toBe('This view');
    expect(data.layout?.description).toBe('Company: All  ·  Employee: All');
    // Alignment is index-aligned to the columns, dynamic block included — a short array would silently
    // fall back to the numeric heuristic for the very columns this file added.
    expect(data.layout?.align).toHaveLength(data.columns.length);
    expect(data.layout?.align?.[col(data, 'Employee Name')]).toBe('left');
    expect(data.layout?.align?.[col(data, 'Handphone Allowance')]).toBe('right');
  });

  it('an empty result set is still a valid, openable header-only sheet', () => {
    const data = build([]);
    expect(data.rows).toEqual([]);
    expect(data.columns).toEqual([...HISTORY_EXPORT_FIXED_COLUMNS]);
    expect(data.layout?.header).toBeNull();
    expect(toXlsxReport(data).bytes.length).toBeGreaterThan(0);
  });
});

/** Dotted lookup into the catalog, the same shape test/history-pivot.test.ts uses. */
function getPath(obj: unknown, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

describe('0fcb2557 — the export control’s captions exist', () => {
  const NS = 'payroll.transactions.view.history';
  it('every key the History export renders resolves in en.json', () => {
    for (const k of ['export', 'exportCurrent', 'exportCurrentHint', 'exportAll', 'exportAllHint', 'exportTitle', 'exportDetailNote']) {
      expect(typeof getPath(en, `${NS}.${k}`), `${NS}.${k}`).toBe('string');
    }
  });

  it('none of them carries an ICU placeholder — an argument nobody passes throws behind a 200', () => {
    for (const k of ['export', 'exportCurrent', 'exportCurrentHint', 'exportAll', 'exportAllHint', 'exportTitle', 'exportDetailNote']) {
      expect(String(getPath(en, `${NS}.${k}`)), k).not.toMatch(/\{[a-zA-Z]/);
    }
  });
});
