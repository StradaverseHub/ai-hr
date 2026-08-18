/**
 * Transaction View → History names every earning by its PAY ITEM, PROVED BY RENDERING (6b134681 + 417d4937).
 *
 * WHY A RENDERING TEST AND NOT ONLY test/history-breakdown.test.ts. That file proves what the derivation
 * DECIDED. Both board items are complaints about what a person SEES: A0002's "B0001 — ANGPOW" read as
 * "Bonus", and A0004's "A0040 — MEAL ALLOWANCE" appeared nowhere by name in the earnings breakdown even
 * though the RM400 was in Allowances, in gross and in net the whole time. A derivation can be correct
 * while the component renders a different field of it — which is exactly what was happening: the
 * breakdown already carried `code`, and the sub-line printed `name` alone.
 *
 * Scope note (inherited from the other dom tests): jsdom applies no CSS and computes no layout, so this
 * catches rendering logic, not a visual regression. The remaining five locales are covered structurally
 * by test/i18n-coverage.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { HistoryTable } from '../app/payroll/transaction-view/history-table';
import type { ProcessedPayslipViewRow } from '../core/payroll-view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

/**
 * The two reports in one payslip, in the shape production stores them:
 *  · A0040 MEAL ALLOWANCE — PCB non-taxable, so the kernel stamps it into the `reimburse` bucket. Paid,
 *    inside the RM650 allowance column, and (before this change) the only allowance with no named line.
 *  · B0001 ANGPOW — additional remuneration, so it lands in `bonus` and was shown as the category word.
 */
const componentLines = [
  { code: 'A0027', name: 'HANDPHONE', amount: 100, buckets: [{ bucket: 'wage', amount: 100 }] },
  { code: 'S0008', name: 'REPLACEMENT', amount: 150, buckets: [{ bucket: 'wage', amount: 150 }] },
  { code: 'A0040', name: 'MEAL ALLOWANCE', amount: 400, buckets: [{ bucket: 'reimburse', amount: 400 }] },
  { code: 'B0001', name: 'ANGPOW', amount: 500, buckets: [{ bucket: 'bonus', amount: 500 }] },
];

const row: ProcessedPayslipViewRow = {
  id: '00000000-0000-0000-0000-000000000001',
  employmentId: '00000000-0000-0000-0000-0000000000e1',
  employeeName: 'Ismail bin Abdullah',
  employeeCode: 'A0002',
  companyId: '00000000-0000-0000-0000-0000000000c1',
  company: 'Isedecor Bina Sdn Bhd',
  payPeriod: '2026-01',
  runType: 'regular',
  runSeq: 1,
  batchStatus: 'processed',
  releasedAt: null,
  version: 1,
  basic: '5000.00',
  allowance: '650.00',
  overtime: '0.00',
  bonus: '500.00',
  gross: '6150.00',
  statutory: {
    epfEmployee: 616, socsoEmployee: 27.75, eisEmployee: 11.1, pcb: 1680,
    epfEmployer: 672, socsoEmployer: 97.15, eisEmployer: 11.1, hrdf: 56,
    componentLines,
    recordLines: [{ code: 'A0040', name: 'MEAL ALLOWANCE', amount: 400, nonPayable: false }],
  },
  totalDeductions: '2334.85',
  net: '3815.15',
} as ProcessedPayslipViewRow;

async function renderExpanded() {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <HistoryTable rows={[row]} hrdfRegisteredCompanyIds={[row.companyId]} />
    </NextIntlClientProvider>,
  );
  // The breakdown only exists once the row is opened — no server-side check can reach it.
  await userEvent.click(screen.getByRole('button', { name: /show/i }));
}

describe('History breakdown — the pay item, not the category', () => {
  it('shows the bonus one-off as B0001 · ANGPOW, not as the word Bonus alone', async () => {
    await renderExpanded();
    expect(screen.getByText('B0001 · ANGPOW')).toBeInTheDocument();
    // The Bonus HEADING legitimately remains — it is the box, and RM500.00 sits beside it. What must no
    // longer be true is that the box is the only thing naming the money.
    expect(screen.getByText('Bonus')).toBeInTheDocument();
  });

  it('lists the PCB-exempt Meal Allowance by name under Allowances — the "missing" RM400', async () => {
    await renderExpanded();
    expect(screen.getByText('A0027 · HANDPHONE')).toBeInTheDocument();
    expect(screen.getByText('S0008 · REPLACEMENT')).toBeInTheDocument();
    // A0040 appears TWICE on the expanded row, and that is the point: once as an earnings sub-line under
    // Allowances (the `reimburse` bucket, previously not itemised at all) and once under Recorded items.
    // The two used to disagree — the record line carried the stale "A0020 — DIRECTOR FEE" remark while the
    // earnings breakdown named nothing. Both now read the pay item.
    const meal = screen.getAllByText('A0040 · MEAL ALLOWANCE');
    expect(meal.length).toBeGreaterThanOrEqual(2);
    expect(meal.some((el) => el.closest('li') != null), 'itemised under the Allowances figure').toBe(true);
    expect(screen.queryByText(/DIRECTOR FEE/)).toBeNull();
  });

  it('still prints every money figure exactly as stored — this is a display change', async () => {
    await renderExpanded();
    expect(screen.getAllByText('RM 6,150.00').length).toBeGreaterThan(0); // gross
    expect(screen.getAllByText('RM 3,815.15').length).toBeGreaterThan(0); // net
    expect(screen.getAllByText('RM 500.00').length).toBeGreaterThan(0); // bonus, and its one named line
    expect(screen.getAllByText('RM 650.00').length).toBeGreaterThan(0); // allowances
  });
});

/**
 * 417d4937 — THE REPAIR OF AN ALREADY-CALCULATED RUN, PROVED BY RENDERING.
 *
 * r196 (d8d34a1f) taught the kernel to name a consumed one-off's record line from the PAY ITEM instead of
 * from the transaction's free-text remark. It is FORWARD-ONLY — it acts when a run is CALCULATED — and no
 * screen re-derived it, so every payroll already run kept "A0020 - DIRECTOR FEE" against pay item A0040
 * and the reporter saw exactly what they had reported. That is not a regression and not an unshipped fix:
 * it is a fix with no retroactive reach, and nothing on the plan said so.
 *
 * The repair reads the CODE the line stored and prints the catalogue's description against it, keeping the
 * words that were typed beside it as the remark. Rendered here rather than asserted on the derivation,
 * because the last three attempts at this pair were all correct derivations feeding a renderer that
 * printed a different field.
 */
describe('417d4937 — a record line written before r196 is repaired at read time', () => {
  /** The reporter's own row: pay item A0040, stored under a PREVIOUS item's remark. */
  const staleRow = {
    ...row,
    id: '00000000-0000-0000-0000-000000000002',
    statutory: {
      ...(row.statutory as Record<string, unknown>),
      recordLines: [
        { code: 'A0040', name: 'A0020 - DIRECTOR FEE', amount: 400, nonPayable: false },
        // A synthetic one-off line: its code can never match a pay_component, so it must be untouched.
        { code: 'TXN_OVERTIME', name: 'Sunday callout', amount: 120, nonPayable: false },
        // A code the catalogue no longer holds — the stored words are all there is, and they stand.
        { code: 'Z9999', name: 'RETIRED ITEM', amount: 50, nonPayable: false },
      ],
    },
  } as ProcessedPayslipViewRow;

  const payItemNames = { A0040: 'MEAL ALLOWANCE', A0020: 'DIRECTOR FEE' };

  async function renderStale(names?: Record<string, string>) {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <HistoryTable rows={[staleRow]} hrdfRegisteredCompanyIds={[row.companyId]} payItemNames={names} />
      </NextIntlClientProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: /show/i }));
  }

  it('prints the pay item’s own description, and keeps the words that were typed as the remark', async () => {
    await renderStale(payItemNames);
    expect(screen.getAllByText('A0040 · MEAL ALLOWANCE').length).toBeGreaterThan(0);
    // NOTHING IS DELETED. The original wording is still on screen, as the remark — which is what an audit
    // needs and what "never rewrite the record" means in practice.
    expect(screen.getByText('Entered as “A0020 - DIRECTOR FEE”')).toBeInTheDocument();
  });

  it('leaves a synthetic TXN_ line and an unknown code exactly as stored', async () => {
    await renderStale(payItemNames);
    expect(screen.getByText('TXN_OVERTIME · Sunday callout')).toBeInTheDocument();
    expect(screen.getByText('Z9999 · RETIRED ITEM')).toBeInTheDocument();
    // Neither carries a remark, because neither was repaired — there is nothing to disclose.
    expect(screen.queryByText(/Entered as “Sunday callout”/)).toBeNull();
    expect(screen.queryByText(/Entered as “RETIRED ITEM”/)).toBeNull();
  });

  it('with NO catalogue to hand it degrades to the stored words, never to a blank', async () => {
    await renderStale(undefined);
    expect(screen.getByText('A0040 · A0020 - DIRECTOR FEE')).toBeInTheDocument();
    expect(screen.queryByText(/Entered as/)).toBeNull();
  });

  it('not one figure moves — the repair is words only', async () => {
    await renderStale(payItemNames);
    expect(screen.getAllByText('RM 6,150.00').length).toBeGreaterThan(0); // gross
    expect(screen.getAllByText('RM 3,815.15').length).toBeGreaterThan(0); // net
    expect(screen.getAllByText('RM 400.00').length).toBeGreaterThan(0); // the repaired line's amount
    expect(screen.getAllByText('RM 120.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('RM 50.00').length).toBeGreaterThan(0);
  });
});
