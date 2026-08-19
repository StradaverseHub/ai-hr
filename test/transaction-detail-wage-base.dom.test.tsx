/**
 * Transaction Detail's wage-base block and statutory-subject columns, PROVED BY RENDERING (0253dc7c).
 *
 * WHY THIS EXISTS ALONGSIDE test/history-pivot.test.ts. That file proves what the FOLD decided. It
 * cannot prove what a person actually SEES, and this screen's whole purpose is that a person can read
 * a figure off it and trust it. Three of the things that would go wrong are invisible to a unit test
 * of the pivot AND to a 200 from a dev server:
 *
 *   · a computed `t()` key with no caption paints MISSING_MESSAGE on screen while tsc, the suite and
 *     `next build` all stay green — the failure AGENTS.md names. Every caption this component resolves
 *     for the new block is computed: `view.grid.section.wagebase`, seven `view.grid.row.*` and five
 *     `view.grid.subject.*`;
 *   · an UNRECORDED wage base must appear as an em dash. A "0.00" there is a wrong wage base on a
 *     reconciliation screen, and it is one boolean away at all times;
 *   · a row that is not a pay item must have BLANK subject cells, not "N". An N is an answer, and
 *     nobody gave it.
 *
 * So the component is rendered with the REAL en.json and read back, then the switch is actually
 * clicked — the columns only exist after that, which no server-side check can reach.
 *
 * Scope note (inherited from the other dom tests): jsdom applies no CSS and computes no layout, so
 * this catches rendering and interaction logic, not a visual regression. The other five locales are
 * covered structurally by test/i18n-coverage.test.ts and scripts/i18n-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { HistoryGrid } from '../app/payroll/transaction-view/history-grid';
import { pivotHistoryGrid } from '../app/payroll/transaction-view/history-pivot';
import type { ProcessedPayslipViewRow } from '../core/payroll-view';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CYCLE_LABELS = { regular: 'Regular', off_cycle: 'Off-cycle', bonus: 'Bonus', adjustment: 'Adjustment' };

let seq = 0;
function slip(over: Partial<ProcessedPayslipViewRow> = {}): ProcessedPayslipViewRow {
  seq += 1;
  return {
    id: `00000000-0000-0000-0000-00000000${String(seq).padStart(4, '0')}`,
    employmentId: '00000000-0000-0000-0000-0000000000e1',
    employeeName: 'Aisyah binti Rahman',
    employeeCode: 'A0006',
    companyId: '00000000-0000-0000-0000-0000000000c1',
    company: 'Acme Sdn Bhd',
    payPeriod: '2026-01',
    runType: 'regular',
    runSeq: 1,
    batchStatus: 'processed',
    releasedAt: null,
    version: 1,
    basic: '5000.00',
    allowance: '100.00',
    overtime: '0.00',
    bonus: '0.00',
    gross: '5100.00',
    statutory: {},
    totalDeductions: '978.48',
    net: '4121.52',
    ...over,
  };
}

/**
 * A0006's shape as it will be AFTER item 2333b7fb: the ticked UNPAID LEAVE has come off every base,
 * so the wage bases read 4,777.42 and the componentLines carry the ticks the run stamped.
 */
const A0006_JANUARY = slip({
  statutory: {
    epfEmployee: 526,
    socsoEmployee: 23.75,
    socsoSkbbk: 0,
    eisEmployee: 9.5,
    pcb: 96.65,
    hrdf: 47.77,
    bases: { epf: 4777.42, epfAdditional: 0, socsoEis: 4777.42, pcb: 4777.42, hrdf: 4777.42 },
    componentLines: [
      { code: 'A0027', name: 'HANDPHONE ALLOWANCE', amount: 100, buckets: [{ bucket: 'wage', amount: 100 }], epf: true, socso: true, pcb: true, hrdf: true },
      { code: 'UPL', name: 'UNPAID LEAVE', amount: 322.58, buckets: [{ bucket: 'deduct', amount: 322.58 }], epf: true, socso: true, pcb: true, hrdf: true },
    ],
  },
});

/** A payslip from before r187 — no `bases` at all, which is 61 of the 121 production payslips. */
const PRE_R187 = slip({
  payPeriod: '2026-02',
  statutory: { epfEmployee: 561, socsoEmployee: 25.25, eisEmployee: 10.1, pcb: 116, hrdf: 51 },
  totalDeductions: '1034.93',
  net: '4065.07',
});

function renderGrid(rows: ProcessedPayslipViewRow[], months = [1, 2]) {
  const grid = pivotHistoryGrid({
    rows,
    year: 2026,
    months,
    hrdfRegisteredCompanyIds: ['00000000-0000-0000-0000-0000000000c1'],
    payItemSubjects: {
      BASIC: { epf: true, socso: true, pcb: true },
      A0027: { epf: true, socso: true, pcb: true },
      UPL: { epf: true, socso: true, pcb: true },
    },
  });
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <HistoryGrid
        rows={grid.rows}
        months={grid.months}
        monthLabels={MONTH_LABELS}
        cycleLabels={CYCLE_LABELS}
        exportParams={{ employmentId: 'e1', year: '2026' }}
        payslipCount={grid.payslipCount}
        detailNotRecorded={grid.detailNotRecorded}
        basesNotRecorded={grid.basesNotRecorded}
        subjectFromCatalogue={grid.subjectFromCatalogue}
      />
    </NextIntlClientProvider>,
  );
  return grid;
}

/** The `<tr>` a row's leftmost code cell belongs to. */
const rowByCode = (code: string) => screen.getAllByText(code)[0].closest('tr')!;

/**
 * How many IDENTITY cells precede the first figure on a row: code, description, pay cycle and — since
 * 3c88d593 gave Transaction Detail a Company column so a transferred employee's two employers stop
 * sharing a cell — the paying company. Declared once because every index below counts from it, and a
 * fifth identity column would otherwise mean four separate off-by-one failures again.
 */
const IDENT_COLS = 4;

describe('0253dc7c — the wage base block renders, with captions rather than key paths', () => {
  it('shows every wage-base caption and the section heading — no MISSING_MESSAGE', () => {
    renderGrid([A0006_JANUARY]);
    // The section heading and all six always-present captions, as English text. A computed t() key with
    // no entry renders the DOTTED PATH here, so asserting the words is the assertion that matters.
    expect(screen.getByText('Wage base')).toBeTruthy();
    for (const caption of [
      'EPF wages',
      'SOCSO wages',
      'EIS wages',
      'SKBBK wages',
      'PCB wages (taxable remuneration)',
      'HRDF wages',
    ]) {
      expect(screen.getByText(caption), caption).toBeTruthy();
    }
    // …and nothing anywhere on the screen is a raw key path or next-intl's failure token.
    expect(document.body.textContent).not.toContain('view.grid.');
    expect(document.body.textContent).not.toContain('MISSING_MESSAGE');
  });

  it("A0006's January reads 4,777.42 on every agency row", () => {
    renderGrid([A0006_JANUARY], [1]);
    for (const code of ['EPF_WAGE', 'SOCSO_WAGE', 'EIS_WAGE', 'SKBBK_WAGE', 'PCB_WAGE', 'HRDF_WAGE']) {
      const cells = within(rowByCode(code)).getAllByRole('cell');
      // [code, description, cycle, company, Jan, total]
      expect(cells[IDENT_COLS].textContent, code).toBe('4,777.42');
    }
  });

  it('a month with no stamp is an EM DASH, never 0.00 and never gross pay', () => {
    // The one outcome this disclosure must never produce. February below has no `bases`; January does.
    const grid = renderGrid([A0006_JANUARY, PRE_R187], [1, 2]);
    expect(grid.basesNotRecorded).toBe(true);
    const cells = within(rowByCode('EPF_WAGE')).getAllByRole('cell');
    expect(cells[IDENT_COLS].textContent).toBe('4,777.42'); //     January, recorded
    expect(cells[IDENT_COLS + 1].textContent).toBe('—'); //        February, not recorded
    expect(cells[IDENT_COLS + 1].textContent).not.toBe('0.00');
    expect(cells[IDENT_COLS + 1].textContent).not.toContain('5,100'); // …and specifically not gross pay
    // The total is the recorded months only, and the caption explains the dash rather than leaving it
    // to read as a broken screen.
    expect(cells[IDENT_COLS + 2].textContent).toBe('4,777.42');
    expect(screen.getByText(/did not record the wage each contribution was charged on/)).toBeTruthy();
  });
});

describe('0253dc7c — the statutory subject columns', () => {
  it('are absent until the switch is ticked, then carry Y/N against the pay items', async () => {
    renderGrid([A0006_JANUARY], [1]);
    // Off by default: the grid looks exactly as it does today until someone asks for the columns.
    expect(screen.queryByRole('columnheader', { name: 'SKBBK' })).toBeNull();

    await userEvent.click(screen.getByLabelText('Show statutory subject'));

    for (const header of ['EPF', 'SOCSO', 'EIS', 'SKBBK', 'Tax']) {
      expect(screen.getByRole('columnheader', { name: header }), header).toBeTruthy();
    }
    // UNPAID LEAVE is ticked into all four, which is the reporter's own case: the row that was doing
    // nothing to any wage base and now does.
    const upl = within(rowByCode('UPL')).getAllByRole('cell');
    expect(upl.slice(IDENT_COLS, IDENT_COLS + 5).map((c) => c.textContent)).toEqual(['Y', 'Y', 'Y', 'Y', 'Y']);
  });

  it('a row that is not a pay item has BLANK subject cells, never N', async () => {
    renderGrid([A0006_JANUARY], [1]);
    await userEvent.click(screen.getByLabelText('Show statutory subject'));
    // EPF_WAGE is a wage base; EPF_EE is a contribution; GROSS is a roll-up. None of them is a pay
    // item, so none of them has a subject answer to give.
    for (const code of ['EPF_WAGE', 'EPF_EE', 'GROSS']) {
      const cells = within(rowByCode(code)).getAllByRole('cell');
      expect(cells.slice(IDENT_COLS, IDENT_COLS + 5).map((c) => c.textContent), code).toEqual(['', '', '', '', '']);
    }
  });

  it('the caption says WHERE the Y/N came from, and only while the columns are shown', async () => {
    renderGrid([A0006_JANUARY], [1]);
    const stamped = /is the setting each payroll run recorded at the time it was calculated/;
    expect(screen.queryByText(stamped)).toBeNull();
    await userEvent.click(screen.getByLabelText('Show statutory subject'));
    // Every item row here carries its own stamp, so the caption is the "recorded at the time" one and
    // NOT the "current settings" one. The synthetic BASIC row falls back to the catalogue, which is
    // what makes this the honest wording rather than the reassuring one.
    expect(
      screen.getByText(/comes from the current Pay Item settings wherever a payroll run did not record its own/),
    ).toBeTruthy();
  });
});

describe('0253dc7c — the lump-sum rows give way to the named items', () => {
  it('Allowances and Other deductions disappear once the items account for them', () => {
    // A0006 January: ALLOW 100 = HANDPHONE ALLOWANCE 100, and the residual 322.58 = UNPAID LEAVE
    // 322.58. Both lump rows have nothing left to say, and the named items say it instead.
    renderGrid([A0006_JANUARY], [1]);
    expect(screen.queryByText('Allowances')).toBeNull();
    expect(screen.queryByText('Other deductions')).toBeNull();
    expect(screen.getByText('HANDPHONE ALLOWANCE')).toBeTruthy();
    expect(screen.getByText('UNPAID LEAVE')).toBeTruthy();
    // Basic salary, the statutory lines and the roll-ups are all untouched — `Hide system codes` is
    // the all-or-nothing switch and this is deliberately NOT it.
    expect(screen.getByText('Basic salary')).toBeTruthy();
    expect(screen.getByText('EPF / KWSP (employee)')).toBeTruthy();
    expect(screen.getByText('Net pay')).toBeTruthy();
  });

  it('a month with no stored item detail keeps them', () => {
    // February has no componentLines, so nothing accounts for its allowance or its residual. The rows
    // stay for the WHOLE year — row-level, never cell-level, because blanking one month of a row
    // breaks the row total, which is the property this screen exists for.
    renderGrid([A0006_JANUARY, PRE_R187], [1, 2]);
    expect(screen.getByText('Allowances')).toBeTruthy();
    expect(screen.getByText('Other deductions')).toBeTruthy();
  });
});
