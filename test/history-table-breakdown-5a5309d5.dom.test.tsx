/**
 * Transaction View → History: overtime legs with hours, named deductions under Other deductions, and a
 * separate Non-payable amounts box — PROVED BY RENDERING (feedback 5a5309d5).
 *
 * test/history-breakdown.test.ts proves what the derivation DECIDES. This file proves what the operator
 * SEES once the row is opened, including the invariant the plan promised: every list printed under a
 * figure adds up to that figure, read back off the rendered text rather than off the derivation.
 *
 * jsdom applies no CSS and computes no layout: this catches rendering logic, not a visual regression.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { HistoryTable } from '../app/(app)/payroll/transaction-view/history-table';
import type { ProcessedPayslipViewRow } from '../core/payroll-view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const HISTORY = messages.payroll.transactions.view.history;
const SLIP = messages.me.payslip;

const base = {
  employmentId: '00000000-0000-0000-0000-0000000000e1',
  employeeName: 'Tan Mei Ling',
  employeeCode: 'E0012',
  companyId: '00000000-0000-0000-0000-0000000000c1',
  company: 'Acme Sdn Bhd',
  payPeriod: '2026-10',
  runType: 'regular',
  runSeq: 1,
  batchStatus: 'processed',
  releasedAt: null,
  version: 1,
  basic: '4000.00',
  allowance: '150.00',
  overtime: '240.00',
  bonus: '500.00',
  gross: '4890.00',
  otherDeductions: '20.00',
  totalDeductions: '458.60',
  net: '4431.40',
};

/** The approved mockup's slip: pay item allowances and bonus, attendance overtime in three legs, a
 *  Monthly Parking deduction item, and a BIK the run stamped non-payable. */
const itemised = {
  ...base,
  id: '00000000-0000-0000-0000-000000000001',
  statutory: {
    epfEmployee: 380, socsoEmployee: 20, eisEmployee: 8, pcb: 30.6,
    componentLines: [
      { code: 'A0010', name: 'Travel Allowance', amount: 100, buckets: [{ bucket: 'wage', amount: 100 }] },
      { code: 'A0011', name: 'Phone Allowance', amount: 50, buckets: [{ bucket: 'wage', amount: 50 }] },
      { code: 'B0001', name: 'Performance Bonus', amount: 500, buckets: [{ bucket: 'bonus', amount: 500 }] },
      { code: 'D0030', name: 'MONTHLY PARKING', amount: 20, buckets: [{ bucket: 'deduct', amount: 20 }] },
    ],
    otDetail: {
      lines: [
        { kind: 'workday', qty: 4, unit: 'hours', rate: 25, amount: 100 },
        { kind: 'rest_day', qty: 4, unit: 'hours', rate: 20, amount: 80 },
        { kind: 'holiday', qty: 2, unit: 'hours', rate: 30, amount: 60 },
      ],
    },
    recordLines: [{ code: 'BIK_HOUSE', name: 'BIK (Household Servant)', amount: 500, nonPayable: true }],
  },
} as ProcessedPayslipViewRow;

/** A run calculated before per-item detail was stamped (pre-862ed0ad): totals only. */
const legacy = {
  ...base,
  id: '00000000-0000-0000-0000-000000000002',
  statutory: {
    epfEmployee: 380, socsoEmployee: 20, eisEmployee: 8, pcb: 30.6,
    recordLines: [{ code: 'TXN_EARNING', name: 'Sunday callout', amount: 120, nonPayable: false }],
  },
} as ProcessedPayslipViewRow;

const money = (s: string | null | undefined) => Number((s ?? '').replace(/[^0-9.-]/g, ''));

async function renderRows(rows: ProcessedPayslipViewRow[]) {
  const view = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <HistoryTable rows={rows} hrdfRegisteredCompanyIds={[base.companyId]} />
    </NextIntlClientProvider>,
  );
  for (const button of screen.getAllByRole('button', { name: /show/i })) await userEvent.click(button);
  return view;
}

/** The expanded panel's section whose heading reads `heading`. */
function section(heading: string): HTMLElement {
  const h = screen.getAllByRole('heading', { level: 3 }).find((el) => el.textContent === heading);
  expect(h, `section "${heading}" is rendered`).toBeTruthy();
  return h!.closest('section') as HTMLElement;
}

describe('5a5309d5 — History breakdown, rendered', () => {
  it('lists each attendance overtime leg by name with its hours under the Overtime figure', async () => {
    await renderRows([itemised]);
    const earnings = section(SLIP.earnings);
    for (const [label, hours, amount] of [
      [SLIP.otLegWorkday, '4 hours', 'RM 100.00'],
      [SLIP.otLegRestDay, '4 hours', 'RM 80.00'],
      [SLIP.otLegHoliday, '2 hours', 'RM 60.00'],
    ]) {
      const li = within(earnings).getByText(label).closest('li') as HTMLElement;
      expect(li, `${label} is a sub-line`).toBeTruthy();
      expect(within(li).getByText(hours)).toBeInTheDocument();
      expect(within(li).getByText(amount)).toBeInTheDocument();
    }
  });

  it('names the deduction item under Other deductions, and the deductions still add up to the total', async () => {
    await renderRows([itemised]);
    const deductions = section(SLIP.deductionsHeading);
    const li = within(deductions).getByText('D0030 · MONTHLY PARKING').closest('li') as HTMLElement;
    expect(within(li).getByText('RM 20.00')).toBeInTheDocument();
    // Independent arithmetic: the top-level rows (not the sub-lines) add up to TOTAL DEDUCTIONS, so the
    // named item is shown beneath its row and is not counted a second time.
    const rows = [...deductions.querySelectorAll(':scope > div')];
    const total = rows.pop()!;
    expect(total.textContent).toContain(SLIP.totalDeductions);
    const rowSum = rows.reduce((t, r) => t + money(r.lastElementChild?.textContent), 0);
    expect(Math.round(rowSum * 100) / 100).toBe(458.6);
    expect(money(total.lastElementChild?.textContent)).toBe(458.6);
  });

  it('puts the BIK in its own Non-payable amounts box with a total and the note, not in the mixed list', async () => {
    await renderRows([itemised]);
    const box = section(HISTORY.nonPayableHeading);
    expect(within(box).getByText('BIK_HOUSE · BIK (Household Servant)')).toBeInTheDocument();
    expect(within(box).getByText(SLIP.nonPayableTotal)).toBeInTheDocument();
    expect(within(box).getByText(HISTORY.nonPayableNote)).toBeInTheDocument();
    expect(HISTORY.nonPayableNote).toBe('Not paid to the employee and not included in gross or net pay.');
    // The mixed list had nothing else in it, so it is not rendered at all.
    expect(screen.queryByRole('heading', { name: HISTORY.itemsHeading })).toBeNull();
  });

  it('INVARIANT: every rendered sub-list sums to the figure printed directly above it', async () => {
    await renderRows([itemised]);
    const lists = [...document.querySelectorAll('section ul')] as HTMLElement[];
    // Allowances, Overtime, Bonus and Other deductions are all itemised on this slip.
    expect(lists.length).toBe(4);
    for (const ul of lists) {
      const figureRow = ul.previousElementSibling as HTMLElement;
      const label = figureRow.firstElementChild?.textContent;
      const figure = money(figureRow.lastElementChild?.textContent);
      const lines = [...ul.querySelectorAll('li')].map((li) => money(li.lastElementChild?.lastElementChild?.textContent));
      expect(lines.length, `${label} has lines`).toBeGreaterThan(0);
      expect(Math.round(lines.reduce((t, n) => t + n, 0) * 100) / 100, `${label} lines sum to its figure`).toBe(figure);
    }
  });

  it('a run that never stored item detail keeps its bare totals, says so, and keeps its recorded items list', async () => {
    await renderRows([legacy]);
    expect(screen.getByText(HISTORY.detailNotRecorded)).toBeInTheDocument();
    expect(document.querySelectorAll('section ul')).toHaveLength(0);
    expect(screen.queryByText(SLIP.otLegWorkday)).toBeNull();
    expect(screen.queryByRole('heading', { name: HISTORY.nonPayableHeading })).toBeNull();
    expect(screen.getByRole('heading', { name: HISTORY.itemsHeading })).toBeInTheDocument();
    expect(screen.getByText('TXN_EARNING · Sunday callout')).toBeInTheDocument();
    // The Overtime and Other deductions figures are still printed exactly as stored.
    expect(screen.getAllByText('RM 240.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('RM 20.00').length).toBeGreaterThan(0);
  });

  it('falls back to the bare Overtime total when the recorded legs do not add up to it', async () => {
    await renderRows([{ ...itemised, overtime: '250.00', gross: '4900.00' } as ProcessedPayslipViewRow]);
    expect(screen.queryByText(SLIP.otLegWorkday)).toBeNull();
    expect(screen.getAllByText('RM 250.00').length).toBeGreaterThan(0);
  });
});
