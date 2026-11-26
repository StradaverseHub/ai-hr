/**
 * 289634a6 — imported Non-Payable pay items (BKCAR benefit-in-kind car, BKDRV driver) PROVED BY RENDERING on
 * Transaction View: the History breakdown lists them once under Non-payable amounts with the PCB treatment the
 * import stamped, and the Grid lists them as Recorded Items on the "Monthly - By Import" row.
 *
 * The row is the shape the history import writes (core/payroll-history-import.ts and the revision owner's
 * `historyMaintenance`); fictional names and amounts. jsdom computes no layout; this catches rendering logic.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import { HistoryTable } from '../app/payroll/transaction-view/history-table';
import { HistoryGrid } from '../app/payroll/transaction-view/history-grid';
import { pivotHistoryGrid } from '../app/payroll/transaction-view/history-pivot';
import type { ProcessedPayslipViewRow } from '../core/payroll-view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/payroll/transaction-view',
}));

const catalogues = { en, ms, zh, ta, th, vi: viMessages };

const imported: ProcessedPayslipViewRow = {
  id: '00000000-0000-0000-0000-0000000000a1',
  employmentId: '00000000-0000-0000-0000-0000000000e1',
  employeeName: 'Fictional benefit employee',
  employeeCode: 'F0098',
  companyId: '00000000-0000-0000-0000-0000000000c1',
  company: 'Fictional Sdn Bhd',
  payPeriod: '2026-01',
  runType: 'adjustment',
  runSeq: 2,
  batchStatus: 'closed',
  historyImportAttemptId: '00000000-0000-0000-0000-0000000000f1',
  historyImportCycleName: 'Monthly',
  releasedAt: null,
  version: 1,
  basic: '9000.00',
  allowance: '0.00',
  overtime: '0.00',
  bonus: '0.00',
  gross: '9000.00',
  statutory: {
    epfEmployee: 990, socsoEmployee: 0, eisEmployee: 0, pcb: 1287.15,
    epfEmployer: 1080, socsoEmployer: 0, eisEmployer: 0, hrdf: 0, socsoSkbbk: 0, lp: 0, zakat: 0,
    importedTaxBasis: {
      version: 1, state: 'ready', year: 2026, settingsHash: 'fictional', missing: [],
      settings: [
        { id: 'pc-bkcar', code: 'BKCAR', name: 'Benefit-in-kind car', includedInPcb: true, isNonPayable: true },
        { id: 'pc-bkdrv', code: 'BKDRV', name: 'Benefit-in-kind driver', includedInPcb: false, isNonPayable: true },
      ],
      lines: [
        { rowNum: 3, originalCode: 'BKCAR', code: 'BKCAR', settingId: 'pc-bkcar', amount: 2083.33, direction: 'noncash' },
        { rowNum: 4, originalCode: 'BKDRV', code: 'BKDRV', settingId: 'pc-bkdrv', amount: 600, direction: 'noncash' },
      ],
    },
    historyMaintenance: { version: 1, items: [
      { key: 'component:pc-bkcar', code: 'BKCAR', label: 'Benefit-in-kind car', originalCodes: ['BKCAR'], amount: '2083.33', destination: 'noncash', direction: 'noncash', sourceRows: [3] },
      { key: 'component:pc-bkdrv', code: 'BKDRV', label: 'Benefit-in-kind driver', originalCodes: ['BKDRV'], amount: '600.00', destination: 'noncash', direction: 'noncash', sourceRows: [4] },
    ] },
  },
  otherDeductions: '0.00',
  totalDeductions: '2277.15',
  net: '6722.85',
};

const wrap = (node: React.ReactNode, locale: keyof typeof catalogues = 'en') =>
  render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]}>{node}</NextIntlClientProvider>);

describe('289634a6 — Transaction View → History', () => {
  it('lists each imported Non-Payable item once, with its PCB treatment, and leaves gross and net as stored', async () => {
    wrap(<HistoryTable rows={[imported]} hrdfRegisteredCompanyIds={[]} />);
    await userEvent.click(screen.getByRole('button', { name: /show/i }));
    const box = screen.getByText(en.payroll.transactions.view.history.nonPayableHeading).closest('section')!;
    expect(within(box).getByText(en.payroll.transactions.view.history.nonPayableFromImport)).toBeInTheDocument();
    const car = within(box).getByText('BKCAR · Benefit-in-kind car').parentElement!;
    expect(within(car).getByText(en.payroll.transactions.view.history.countsForPcb)).toBeInTheDocument();
    const driver = within(box).getByText('BKDRV · Benefit-in-kind driver').parentElement!;
    expect(within(driver).getByText(en.payroll.transactions.view.history.notTaxed)).toBeInTheDocument();
    expect(within(box).getByText('RM 2,083.33')).toBeInTheDocument();
    expect(within(box).getByText('RM 600.00')).toBeInTheDocument();
    expect(within(box).getByText('RM 2,683.33')).toBeInTheDocument();
    // Shown once on the whole panel.
    expect(screen.getAllByText('BKCAR · Benefit-in-kind car')).toHaveLength(1);
    // Gross and net are the stored figures.
    expect(screen.getAllByText('RM 9,000.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('RM 6,722.85').length).toBeGreaterThan(0);
  });

  it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('renders the PCB markers from the %s catalogue, never a raw key', async (locale) => {
    const t = catalogues[locale].payroll.transactions.view.history;
    wrap(<HistoryTable rows={[imported]} hrdfRegisteredCompanyIds={[]} />, locale);
    await userEvent.click(screen.getByRole('button', { name: t.showBreakdown }));
    for (const words of [t.countsForPcb, t.notTaxed, t.nonPayableFromImport]) expect(screen.getAllByText(words).length).toBeGreaterThan(0);
    expect(screen.queryByText(/view\.history\./)).toBeNull();
  });
});

describe('289634a6 — Transaction View → Grid', () => {
  it('lists BKCAR and BKDRV as Recorded Items on the "Monthly - By Import" row', () => {
    const grid = pivotHistoryGrid({ rows: [imported], year: 2026 });
    wrap(
      <HistoryGrid
        rows={grid.rows}
        months={grid.months}
        monthLabels={['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']}
        cycleLabels={{ regular: 'Regular', off_cycle: 'Off cycle', bonus: 'Bonus', adjustment: 'Adjustment' }}
        exportParams={{}}
        payslipCount={grid.payslipCount}
        detailNotRecorded={grid.detailNotRecorded}
        basesNotRecorded={grid.basesNotRecorded}
        subjectFromCatalogue={grid.subjectFromCatalogue}
      />,
    );
    const car = screen.getByText('BKCAR').closest('tr')!;
    expect(within(car).getByText('Monthly - By Import')).toBeInTheDocument();
    expect(within(car).getByText('Benefit-in-kind car')).toBeInTheDocument();
    expect(within(car).getAllByText('2,083.33').length).toBeGreaterThan(0);
    const driver = screen.getByText('BKDRV').closest('tr')!;
    expect(within(driver).getByText('Monthly - By Import')).toBeInTheDocument();
  });
});
