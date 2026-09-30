/**
 * Item e0b6e3b8, r367 — THE THIRD SCREEN: Transaction View → History renders the two payslip section
 * headings too, and it is the one of the three that had to be RENDERED to be checked at all.
 *
 * WHY THIS FILE EXISTS SEPARATELY. `history-table.tsx` is a CLIENT component and its breakdown only exists
 * once a row is expanded — no server-side render and no source grep can reach what it draws. Its `tSlip` is
 * bound to `me.payslip`, so it inherited both bracketed headings; it had NOT bound
 * `payroll.individualPayslip`, so it could not resolve the note that now carries what the brackets carried.
 * An unbound namespace raises MISSING_MESSAGE at render — behind a 200, past tsc, past `next build` and
 * past every source-shape assertion — which is exactly why this is a render.
 *
 * SCOPE NOTE (inherited from the other dom tests): jsdom applies no CSS and computes no layout, so this
 * catches rendering logic, not a visual regression. The remaining five locales are covered by the
 * value-level assertions in test/payslip-section-headings-r367.test.ts.
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

const row: ProcessedPayslipViewRow = {
  id: '00000000-0000-0000-0000-000000000001',
  employmentId: '00000000-0000-0000-0000-0000000000e1',
  employeeName: 'Aisyah Rahman',
  employeeCode: 'EMP-001',
  companyId: '00000000-0000-0000-0000-0000000000c1',
  company: 'Demo Sdn Bhd',
  payPeriod: '2026-03',
  runType: 'regular',
  runSeq: 1,
  batchStatus: 'processed',
  releasedAt: null,
  version: 1,
  basic: '6500.00',
  allowance: '500.00',
  overtime: '0.00',
  bonus: '0.00',
  gross: '7000.00',
  statutory: {
    epfEmployee: 715, socsoEmployee: 24.75, eisEmployee: 9.9, pcb: 350,
    epfEmployer: 925, socsoEmployer: 86.65, eisEmployer: 9.9, hrdf: 70,
  },
  totalDeductions: '1099.65',
  net: '5900.35',
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

const SLIP = messages.me.payslip;
const IP = messages.payroll.individualPayslip;

describe('r367 — the History breakdown drops the brackets and gains the note', () => {
  it('heads its two statutory sections with the plain words', async () => {
    await renderExpanded();
    // The VALUES out of the catalogue the provider was handed, so a heading that still resolved a
    // bracketed string would fail here rather than passing a key-shaped check.
    expect(SLIP.deductionsHeading, 'the catalogue really is the plain word').toBe('Deductions');
    expect(SLIP.employerContributionsHeading).toBe('Employer contributions');
    expect(screen.getByText(SLIP.deductionsHeading)).toBeInTheDocument();
    expect(screen.getByText(SLIP.employerContributionsHeading)).toBeInTheDocument();
  });

  it('THE LOAD-BEARING HALF: the employer-contributions note renders', async () => {
    await renderExpanded();
    // This panel draws `me.payslip.epf`, `socso` and `eis` in BOTH sections, so before this round the
    // bracket was the only thing separating employee money from employer money in the breakdown.
    expect(screen.getByText(IP.employerContributionsNote)).toBeInTheDocument();
  });

  it('renders NO bracketed qualifier and NO retire marker anywhere in the breakdown', async () => {
    await renderExpanded();
    const body = document.body.textContent ?? '';
    expect(body, 'non-vacuity: the breakdown really did open').toContain(SLIP.deductionsHeading);
    expect(body).not.toContain('(your share)');
    expect(body).not.toContain('(not deducted from you)');
    expect(body, 'a retired key that still resolves paints its own marker on the screen').not.toContain(
      '[retired r',
    );
  });

  it('the SAME row labels appear in both sections — which is why the note is load-bearing', async () => {
    await renderExpanded();
    // EPF, SOCSO and EIS each appear TWICE: once as a deduction, once as an employer contribution. If this
    // ever stopped being true the note would stop being load-bearing and a later round could drop it.
    for (const label of [SLIP.epf, SLIP.socso, SLIP.eis]) {
      expect(screen.getAllByText(label).length, `${label} is drawn in both sections`).toBeGreaterThanOrEqual(2);
    }
  });
});
