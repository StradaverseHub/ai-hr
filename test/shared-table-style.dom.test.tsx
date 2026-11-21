import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { HistoryTable } from '../app/payroll/transaction-view/history-table';
import { EmployeeName } from '../components/ui';
import { UiThemeProvider } from '../components/ui-theme-context';
import type { ProcessedPayslipViewRow } from '../core/payroll-view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const row = {
  id: 'table-style-slip', employmentId: 'e1', companyId: 'c1',
  employeeCode: 'E100', employeeName: 'A long employee name', company: 'Example Company Sdn Bhd',
  payPeriod: '2026-10', runType: 'regular', runSeq: 1, batchStatus: 'processed',
  releasedAt: null, version: 1, basic: '5000.00', allowance: '0.00', overtime: '0.00', bonus: '0.00',
  gross: '5000.00', totalDeductions: '573.00', net: '4427.00',
  statutory: { epfEmployee: 550, socsoEmployee: 20, eisEmployee: 3, pcb: 0,
    epfEmployer: 600, socsoEmployer: 70, eisEmployer: 3, hrdf: 0 },
} as ProcessedPayslipViewRow;

function history(rows = [row]) {
  return render(<NextIntlClientProvider locale="en" messages={messages} timeZone="Asia/Kuala_Lumpur">
    <UiThemeProvider theme="atelier"><HistoryTable rows={rows} hrdfRegisteredCompanyIds={[]} /></UiThemeProvider>
  </NextIntlClientProvider>);
}

describe('shared table presentation preserves payroll behaviour', () => {
  it('keeps figures associated with their matching headings after moving identity and net pay forward', () => {
    history();
    const table = screen.getByRole('table');
    const headers = within(table).getAllByRole('columnheader');
    const cells = within(within(table).getAllByRole('row')[1]).getAllByRole('cell');
    expect(headers).toHaveLength(15);
    expect(cells).toHaveLength(15);
    const column = (label: string) => cells[headers.findIndex(h => h.textContent === label)].textContent;
    expect(column(messages.payroll.batch.colEmployee)).toContain('E100A long employee name');
    expect(column(messages.payroll.list.colCompany)).toBe('Example Company Sdn Bhd');
    expect(column(messages.payroll.list.colPeriod)).toBe('2026-10');
    expect(column(messages.payroll.batch.colGross)).toBe('RM 5,000.00');
    expect(column(messages.payroll.batch.colNet)).toBe('RM 4,427.00');
    expect(column(messages.payroll.batch.colEpf)).toBe('RM 550.00');
    expect(column(messages.payroll.batch.colSocso)).toBe('RM 20.00');
    expect(column(messages.payroll.batch.colEis)).toBe('RM 3.00');
    expect(column(messages.payroll.batch.colPcb)).toBe('RM 0.00');
    expect(column(messages.payroll.batch.totalDeductions)).toBe('RM 573.00');
  });

  it('keeps paging outside the keyboard-scrollable table and expansion keyboard operable', async () => {
    const { container } = history();
    const scroll = screen.getByRole('region', { name: messages.payroll.transactions.view.tabs.history });
    expect(scroll).toHaveAttribute('tabindex', '0');
    expect(scroll.contains(container.querySelector('[data-ui-pager]'))).toBe(false);
    const expand = screen.getByRole('button', { name: messages.payroll.transactions.view.history.showBreakdown });
    expand.focus();
    await userEvent.keyboard('{Enter}');
    expect(expand).toHaveAttribute('aria-expanded', 'true');
    expect(expand.closest('tr')?.nextElementSibling?.querySelector('td')).toHaveAttribute('colspan', '15');
    await userEvent.keyboard('{Enter}');
    expect(expand).toHaveAttribute('aria-expanded', 'false');
  });

  it('preserves the full empty-state span and nullable employee codes', () => {
    history([]);
    expect(screen.getByRole('table').querySelector('tbody td')).toHaveAttribute('colspan', '15');
    const { container } = render(<EmployeeName name="Employee without a code" code={null} />);
    expect(container.textContent).toBe('Employee without a code');
  });
});
