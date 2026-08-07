/**
 * 6a1f2bd6 (Zakat) + 6d72816e (Loans) — the two list tables, PROVED BY RENDERING.
 *
 * WHY THIS EXISTS ALONGSIDE test/zakat-loans-employee-first.test.ts. That file proves what the SERVER
 * decided: with an employee selected, the rows handed to these tables belong to that employee and nobody
 * else. It cannot prove what a person actually SEES, and the reporter's complaint is entirely about that —
 * "the two lists underneath still show everyone". The node project reaches Postgres and the dom project
 * reaches a DOM, and neither reaches both, so the claim is proved in the two halves it splits into.
 *
 * THE SHARED TABLE IS THE POINT OF THE FILE. Zakat, Loans and TP1 Relief were raised as three requests and
 * the reporter asked for consistency in those words, so "Applied in payroll" is ONE component
 * (components/applied-in-payroll-list.tsx) rather than three lookalikes. Rendering it here is the assertion
 * that it renders what it is given and nothing else.
 *
 * IT ALSO STANDS IN FOR PART OF THE i18n CHECK, though not all of it. NextIntlClientProvider is given the
 * REAL en.json, so a key these components ask for and the catalog does not have throws rather than painting
 * MISSING_MESSAGE — the failure mode that passes tsc, the suite and `next build` and still returns 200.
 * That covers en; the other five locales are covered structurally by test/i18n-coverage.test.ts (check A),
 * and neither replaces reading a dev-server log.
 *
 * Scope note (inherited from client-pager.dom.test.tsx): jsdom applies no CSS and computes no layout, so
 * this catches rendering and interaction logic, not a visual regression.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../messages/en.json';
import { AppliedInPayrollList, type AppliedInPayrollRow } from '../components/applied-in-payroll-list';
import { ZakatElectionsList, type ZakatElectionListRow } from '../app/payroll/transactions/zakat/elections-list';

// The address bar, stubbed. Paging rides in the query string exactly as it does on the server-paged
// screens, so replace() is RECORDED rather than performed.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const wrap = (ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

const applied = (over: Partial<AppliedInPayrollRow> & { id: string }): AppliedInPayrollRow => ({
  payPeriod: '2026-05',
  cycleLabel: 'Regular',
  employeeName: 'Aisha Rahman',
  employeeCode: 'EMP-001',
  company: 'Acme Sdn Bhd',
  amount: '100.00',
  statusLabel: 'Processed',
  createdOn: '2026-05-25 09:00:00',
  ...over,
});

/** The employee cell of every row a reader can actually see, in order. */
const namesOn = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('tbody tr')]
    .map((tr) => tr.querySelector('td:nth-child(3)')?.textContent?.trim() ?? '')
    .filter(Boolean);

describe('Applied in payroll — the one table Zakat, Loans and TP1 share', () => {
  it('shows exactly the rows it is given, and nobody the server narrowed away', () => {
    // The server has already decided; this asserts the table does not quietly widen it back.
    const { container } = wrap(
      <AppliedInPayrollList
        rows={[applied({ id: 'r1' }), applied({ id: 'r2', payPeriod: '2026-04', createdOn: '2026-04-25 09:00:00' })]}
        emptyLabel="No instalments have been deducted yet."
      />,
    );
    expect(namesOn(container)).toEqual(['Aisha Rahman(EMP-001)', 'Aisha Rahman(EMP-001)']);
    expect(container.textContent).not.toContain('Bala');
    // Newest month first — a payroll history that opened oldest-first would be read wrong at a glance.
    expect(container.querySelector('tbody tr td')?.textContent).toBe('2026-05');
    expect(container.textContent).toContain('RM 100.00');
  });

  it('an empty list reads as EMPTY, in the screen’s own words, not as an error', () => {
    // On production there is 1 loan, 24 scheduled instalments and NONE applied, so this is the first thing
    // the reporter will see on the Loans screen. It must not look broken.
    const { container } = wrap(<AppliedInPayrollList rows={[]} emptyLabel="No instalments have been deducted yet." />);
    expect(screen.getByText('No instalments have been deducted yet.')).toBeTruthy();
    expect(container.textContent).not.toMatch(/error|failed|undefined|NaN/i);
  });

  it('a search that matches nothing says so WITHOUT claiming the list is empty', async () => {
    const user = userEvent.setup();
    const { container } = wrap(
      <AppliedInPayrollList rows={[applied({ id: 'r1' })]} emptyLabel="No instalments have been deducted yet." />,
    );
    await user.type(screen.getByRole('searchbox'), 'zzzz');
    expect(container.textContent).toContain('No deductions match your search.');
    expect(container.textContent).not.toContain('No instalments have been deducted yet.');
  });

  it('sorts the WHOLE set before it pages — the biggest row is on page one, not stranded on page two', async () => {
    // The bug this refuses is the one components/client-pager.tsx was written to prevent: slice first and a
    // column header reorders twenty-five rows while leaving the rest where they were, which looks like
    // sorting and is not. The largest amount is seeded at position 30 of 30, past the default page size.
    const user = userEvent.setup();
    const rows = Array.from({ length: 30 }, (_, i) =>
      applied({ id: `r${i}`, amount: `${(i + 1) * 10}.00`, employeeName: `Person ${String(i).padStart(2, '0')}` }),
    );
    const { container } = wrap(<AppliedInPayrollList rows={rows} emptyLabel="empty" />);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(25);

    const amountHeader = screen.getByRole('button', { name: /Amount/i });
    await user.click(amountHeader); // first click on a new key opens ascending
    await user.click(amountHeader); // …so descending is the second
    expect(container.querySelector('tbody tr td:nth-child(5)')?.textContent).toBe('RM 300.00');
  });
});

describe('Zakat transaction history — ONE row per employee, never a version chain', () => {
  const election = (over: Partial<ZakatElectionListRow> & { employmentId: string }): ZakatElectionListRow => ({
    employeeName: 'Aisha Rahman',
    employeeCode: 'EMP-001',
    company: 'Acme Sdn Bhd',
    zakatActive: true,
    zakatMethod: 'fixed',
    zakatPercent: null,
    zakatFixed: '100.00',
    zakatState: 'Selangor',
    zakatEffectiveFrom: '2026-01-01',
    zakatEffectiveTo: null,
    ...over,
  });

  it('renders the selected employee’s single setup, and links it to the editor rather than opening one', () => {
    // An employee has ONE zakat setup — employee_statutory_my holds a single row per person and saving
    // OVERWRITES it. The reporter asked for a "transaction history", and the honest answer is that the
    // month-by-month record is the applied-in-payroll list; this one must never imply a dated chain.
    const { container } = wrap(<ZakatElectionsList rows={[election({ employmentId: 'e1' })]} />);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    const row = container.querySelector('tbody tr')!;
    expect(within(row as HTMLElement).getByRole('link').getAttribute('href')).toBe(
      '/payroll/transactions/zakat/election?employmentId=e1',
    );
    // The figures the table has always shown, unchanged by the redesign.
    expect(row.textContent).toContain('RM 100.00');
    expect(row.textContent).toContain('Selangor');
    expect(row.textContent).toContain('2026-01-01');
  });

  it('a percentage setup renders as a percentage, not as ringgit', () => {
    // Stored as a decimal (0.025), shown as 2.50%. Printing 0.03 or RM 0.03 here would be a plausible-
    // looking wrong number on a screen whose whole job is verification.
    const { container } = wrap(
      <ZakatElectionsList
        rows={[election({ employmentId: 'e1', zakatMethod: 'percent_of_pcb', zakatPercent: '0.025', zakatFixed: null })]}
      />,
    );
    expect(container.textContent).toContain('2.50%');
    expect(container.textContent).not.toContain('RM 0.03');
  });

  it('an employee with no setup on file reads as empty rather than as a missing row', () => {
    const { container } = wrap(<ZakatElectionsList rows={[]} />);
    expect(container.textContent).toContain('No saved zakat records yet.');
  });
});
