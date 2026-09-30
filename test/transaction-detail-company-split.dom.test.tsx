/**
 * 3c88d593 (r206) — A TRANSFERRED EMPLOYEE'S MONTH, PROVED BY RENDERING.
 *
 * WHY THIS EXISTS ALONGSIDE test/history-pivot.test.ts. That file proves the FOLD now keeps the two
 * employers apart. It cannot prove that a person opening Transaction View can SEE which employer paid
 * what, which is the entire request: the reporter's complaint was not that the arithmetic was wrong (it
 * is not — the payroll already produces two correct results) but that the screen consolidated them and
 * said nothing about it. Three failures are invisible to the pivot test, to tsc, to `next build` and to a
 * 200 from a dev server:
 *
 *   · a caption with no entry paints its DOTTED KEY PATH (or next-intl's MISSING_MESSAGE) on screen —
 *     the failure AGENTS.md names. Four captions are new here: `view.grid.colCompany`,
 *     `view.grid.colCoverage`, `view.history.splitBadge` and `view.history.coverageLine`;
 *   · the Company column existing in the markup but rendering the same name on both lines, which would
 *     make the split look like a duplicated row rather than two employers;
 *   · the coverage dates rendering on a payslip that was NEVER split, which would tell every employee in
 *     the system that their ordinary month was a partial one.
 *
 * So both surfaces are rendered with the REAL en.json and read back. The other five locales are covered
 * structurally by test/i18n-coverage.test.ts and scripts/i18n-check.mjs.
 *
 * Scope note (inherited from the other dom tests): jsdom applies no CSS and computes no layout, so this
 * catches rendering logic, not a visual regression.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { HistoryGrid } from '../app/payroll/transaction-view/history-grid';
import { HistoryTable } from '../app/payroll/transaction-view/history-table';
import { pivotHistoryGrid } from '../app/payroll/transaction-view/history-pivot';
import type { ProcessedPayslipViewRow } from '../core/payroll-view';

// The address bar, stubbed — HistoryTable reads ?page/?size through useClientPageQuery and nothing here
// navigates. Same shape as test/payroll-txn-view-full-width.dom.test.tsx.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CYCLE_LABELS = { regular: 'Regular', off_cycle: 'Off-cycle', bonus: 'Bonus', adjustment: 'Adjustment' };

const FIAMMA = '00000000-0000-0000-0000-0000000000c1';
const ISEDECOR = '00000000-0000-0000-0000-0000000000c2';

let seq = 0;
function slip(over: Partial<ProcessedPayslipViewRow> = {}): ProcessedPayslipViewRow {
  seq += 1;
  return {
    id: `00000000-0000-0000-0000-00000000${String(seq).padStart(4, '0')}`,
    employmentId: '00000000-0000-0000-0000-0000000000e1',
    employeeName: 'Employee 100814',
    employeeCode: '100814',
    companyId: FIAMMA,
    company: 'Fiamma (Chin Hin Property)',
    payPeriod: '2026-08',
    runType: 'regular',
    runSeq: 1,
    batchStatus: 'processed',
    releasedAt: null,
    version: 1,
    basic: '1000.00',
    allowance: '0.00',
    overtime: '0.00',
    bonus: '0.00',
    gross: '1000.00',
    statutory: { epfEmployee: 110 },
    // 970e4143 — ProcessedPayslipViewRow now carries the payslip's stored "Other deductions" column
    // (the two Transaction History surfaces could not reconcile without it). 0 on this baseline.
    otherDeductions: '0.00',
    totalDeductions: '110.00',
    net: '890.00',
    ...over,
  };
}

/** The reporter's own case: 3,100 ÷ 31 × 10 under the outgoing employer, × 21 under the incoming one. */
const AUG_FIAMMA = slip({ coverageFrom: '2026-08-01', coverageTo: '2026-08-10' });
const AUG_ISEDECOR = slip({
  companyId: ISEDECOR,
  company: 'ISEDECOR BINA SDN BHD',
  coverageFrom: '2026-08-11',
  coverageTo: '2026-08-31',
  basic: '2100.00',
  gross: '2100.00',
  statutory: { epfEmployee: 231 },
  totalDeductions: '231.00',
  net: '1869.00',
});
/** Somebody who never moved: the whole of August, under one employer. */
const AUG_WHOLE = slip({
  employeeName: 'Employee 100001',
  employeeCode: '100001',
  coverageFrom: '2026-08-01',
  coverageTo: '2026-08-31',
});

const wrap = (ui: React.ReactNode) => (
  <NextIntlClientProvider locale="en" messages={messages}>
    {ui}
  </NextIntlClientProvider>
);

function renderGrid(rows: ProcessedPayslipViewRow[]) {
  const grid = pivotHistoryGrid({ rows, year: 2026, months: [8] });
  render(
    wrap(
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
      />,
    ),
  );
  return grid;
}

/** Every `<tr>` whose leftmost code cell carries `code`. */
const rowsByCode = (code: string) =>
  screen.getAllByText(code).map((el) => el.closest('tr')!).filter((tr): tr is HTMLTableRowElement => tr != null);

describe('3c88d593 — Transaction Detail names the employer on every line', () => {
  it('renders a Company column with a caption, not a key path', () => {
    renderGrid([AUG_FIAMMA, AUG_ISEDECOR]);
    expect(screen.getByRole('columnheader', { name: 'Company' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('view.grid.');
    expect(document.body.textContent).not.toContain('view.history.');
    expect(document.body.textContent).not.toContain('MISSING_MESSAGE');
  });

  it('August is TWO Basic salary lines — one per employer, each with its own figure and its own dates', () => {
    renderGrid([AUG_FIAMMA, AUG_ISEDECOR]);
    const basic = rowsByCode('BASIC');
    expect(basic).toHaveLength(2);

    // Outgoing employer first (company sorts before run type), then the incoming one. Each line names
    // its employer, its figure, and the days that employer actually covered.
    const [out, inc] = basic;
    expect(within(out).getByText('Fiamma (Chin Hin Property)')).toBeTruthy();
    expect(within(out).getByText('Employed by this company 2026-08-01 to 2026-08-10')).toBeTruthy();
    expect(within(inc).getByText('ISEDECOR BINA SDN BHD')).toBeTruthy();
    expect(within(inc).getByText('Employed by this company 2026-08-11 to 2026-08-31')).toBeTruthy();

    // THE FIGURES ARE THE PAYSLIPS' OWN, shown on the two lines they were paid on. The 3,100.00 that
    // used to sit in one cell is now 1,000.00 + 2,100.00 and appears nowhere.
    const amountsOf = (tr: HTMLTableRowElement) => within(tr).getAllByRole('cell').map((c) => c.textContent);
    expect(amountsOf(out)).toContain('1,000.00');
    expect(amountsOf(inc)).toContain('2,100.00');
    expect(document.body.textContent).not.toContain('3,100.00');
  });

  it('AN EMPLOYEE WHO NEVER MOVED sees the company name alone — no dates, one line', () => {
    // The regression guard for everybody who is not the reporter: a whole-month payslip is not narrower
    // than its period, so it is not segmented, so nothing new is printed against it.
    renderGrid([AUG_WHOLE]);
    expect(rowsByCode('BASIC')).toHaveLength(1);
    expect(screen.getAllByText('Fiamma (Chin Hin Property)').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Employed by this company/)).toBeNull();
  });
});

describe('3c88d593 — the History list says WHY one month has two results', () => {
  it('marks a segmented payslip as a Split and prints the days it covered', () => {
    render(wrap(<HistoryTable rows={[AUG_FIAMMA, AUG_ISEDECOR]} hrdfRegisteredCompanyIds={[]} />));
    // Two lines were always here; what was missing is any statement of why.
    expect(screen.getAllByText('Split')).toHaveLength(2);
    expect(screen.getByText('Employed by this company 2026-08-01 to 2026-08-10')).toBeTruthy();
    expect(screen.getByText('Employed by this company 2026-08-11 to 2026-08-31')).toBeTruthy();
    expect(document.body.textContent).not.toContain('view.history.');
    expect(document.body.textContent).not.toContain('MISSING_MESSAGE');
  });

  it('leaves an ordinary month exactly as it was — no badge, no dates', () => {
    render(wrap(<HistoryTable rows={[AUG_WHOLE]} hrdfRegisteredCompanyIds={[]} />));
    expect(screen.getByText('2026-08')).toBeTruthy();
    expect(screen.queryByText('Split')).toBeNull();
    expect(screen.queryByText(/Employed by this company/)).toBeNull();
  });
});
