/**
 * b240c0ff — imported payroll history, PROVED BY RENDERING on Transaction View (History + Grid) and the
 * printed payslip.
 *
 * The row below is the shape the history import writes (test/b240c0ff-imported-history-by-import.test.ts
 * asserts that shape against the real database): an `adjustment` run in storage, carrying the import's
 * attempt id and the file's Pay Cycle name, with each pay item line stamped as `statutory.importedLines`.
 *
 *  · the cycle column reads "Monthly - By Import", never "Adjustment";
 *  · UPL and a second deduction are listed by name under Other deductions, which still prints its total;
 *  · a NORMAL run with no deduction lines renders exactly as before (no sub-lines, its own run-type word).
 *
 * jsdom computes no layout; this catches rendering logic, not a visual regression.
 */
import { describe, expect, it, vi } from 'vitest';
import zlib from 'node:zlib';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { HistoryTable } from '../app/(app)/payroll/transaction-view/history-table';
import { HistoryGrid } from '../app/(app)/payroll/transaction-view/history-grid';
import { pivotHistoryGrid } from '../app/(app)/payroll/transaction-view/history-pivot';
import { buildPayslipPdfData, renderPayslipPdf } from '../lib/payslip-pdf';
import type { ProcessedPayslipViewRow } from '../core/payroll-view';
import { data as fixtureData, labels } from './fixtures/payslip-pdf-fixture';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/payroll/transaction-view',
}));

const imported: ProcessedPayslipViewRow = {
  id: '00000000-0000-0000-0000-0000000000a1',
  employmentId: '00000000-0000-0000-0000-0000000000e1',
  employeeName: 'Fictional import employee',
  employeeCode: '0007',
  companyId: '00000000-0000-0000-0000-0000000000c1',
  company: 'Fictional Sdn Bhd',
  payPeriod: '2024-01',
  runType: 'adjustment',
  runSeq: 2,
  batchStatus: 'closed',
  historyImportAttemptId: '00000000-0000-0000-0000-0000000000f1',
  historyImportCycleName: 'Monthly',
  releasedAt: null,
  version: 1,
  basic: '5000.00',
  allowance: '300.00',
  overtime: '0.00',
  bonus: '0.00',
  gross: '5300.00',
  statutory: {
    epfEmployee: 583, socsoEmployee: 24.75, eisEmployee: 9.9, pcb: 150,
    epfEmployer: 689, socsoEmployer: 86.65, eisEmployer: 9.9, hrdf: 0, socsoSkbbk: 0, lp: 0, zakat: 0,
    version: 'my-2024',
    importedLines: [
      { code: 'A010', name: 'Meal allowance', amount: 300, buckets: [{ bucket: 'wage', amount: 300 }] },
      { code: 'UPL', name: 'Unpaid leave', amount: 250, buckets: [{ bucket: 'deduct', amount: 250 }] },
      { code: 'D002', name: 'Staff welfare fund', amount: 100, buckets: [{ bucket: 'deduct', amount: 100 }] },
    ],
  },
  otherDeductions: '350.00',
  totalDeductions: '1117.65',
  net: '4182.35',
};

/** A kernel run with no stamped deduction lines — must render as it always did. */
const ordinary: ProcessedPayslipViewRow = {
  ...imported,
  id: '00000000-0000-0000-0000-0000000000a2',
  payPeriod: '2024-02',
  runType: 'adjustment',
  runSeq: 1,
  historyImportAttemptId: null,
  historyImportCycleName: null,
  statutory: { ...(imported.statutory as Record<string, unknown>), importedLines: undefined },
};

const cycleLabels = {
  regular: messages.payroll.transactions.individual.cycle.regular,
  off_cycle: messages.payroll.transactions.individual.cycle.off_cycle,
  bonus: messages.payroll.transactions.individual.cycle.bonus,
  adjustment: messages.payroll.transactions.individual.cycle.adjustment,
};

function wrap(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>,
  );
}

describe('b240c0ff — Transaction View → History', () => {
  it('names imported history "Monthly - By Import" and an ordinary adjustment run by its run type', () => {
    wrap(<HistoryTable rows={[imported, ordinary]} hrdfRegisteredCompanyIds={[]} />);
    expect(screen.getByText('Monthly - By Import')).toBeInTheDocument();
    // The run number is not appended to the import label; the ordinary run keeps its own word.
    expect(screen.queryByText(/Monthly - By Import #/)).toBeNull();
    expect(screen.getByText(cycleLabels.adjustment)).toBeInTheDocument();
  });

  it('lists UPL and the second deduction by name under Other deductions, total unchanged', async () => {
    wrap(<HistoryTable rows={[imported]} hrdfRegisteredCompanyIds={[]} />);
    await userEvent.click(screen.getByRole('button', { name: /show/i }));
    const upl = screen.getByText('UPL · Unpaid leave');
    const d002 = screen.getByText('D002 · Staff welfare fund');
    expect(upl.closest('li')).not.toBeNull();
    expect(within(upl.closest('li')!).getByText('RM 250.00')).toBeInTheDocument();
    expect(within(d002.closest('li')!).getByText('RM 100.00')).toBeInTheDocument();
    // The category row and the total are what they were.
    expect(screen.getAllByText('RM 350.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('RM 1,117.65').length).toBeGreaterThan(0);
    expect(screen.getAllByText('RM 4,182.35').length).toBeGreaterThan(0);
  });

  it('an ordinary run with no deduction lines grows no sub-lines', async () => {
    wrap(<HistoryTable rows={[ordinary]} hrdfRegisteredCompanyIds={[]} />);
    await userEvent.click(screen.getByRole('button', { name: /show/i }));
    expect(screen.queryByText(/Unpaid leave/)).toBeNull();
    expect(screen.getAllByText('RM 350.00').length).toBeGreaterThan(0);
  });
});

describe('b240c0ff — Transaction View → Grid', () => {
  it('labels the imported run "Monthly - By Import" and lists UPL and D002 as their own rows', () => {
    const grid = pivotHistoryGrid({ rows: [imported, ordinary], year: 2024 });
    wrap(
      <HistoryGrid
        rows={grid.rows}
        months={grid.months}
        monthLabels={['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']}
        cycleLabels={cycleLabels}
        exportParams={{}}
        payslipCount={grid.payslipCount}
        detailNotRecorded={grid.detailNotRecorded}
        basesNotRecorded={grid.basesNotRecorded}
        subjectFromCatalogue={grid.subjectFromCatalogue}
      />,
    );
    expect(screen.getAllByText('Monthly - By Import').length).toBeGreaterThan(0);
    // The imported run and the ordinary adjustment run are two different runs, never merged.
    expect(screen.getAllByText(cycleLabels.adjustment).length).toBeGreaterThan(0);
    const uplRow = screen.getByText('UPL').closest('tr')!;
    expect(within(uplRow).getByText('Monthly - By Import')).toBeInTheDocument();
    expect(within(uplRow).getByText('Unpaid leave')).toBeInTheDocument();
    expect(screen.getByText('D002').closest('tr')).not.toBeNull();
  });
});

/** The text a PDF draws, inflated out of its content streams (same reader as test/payslip-pdf.test.ts). */
function drawnText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const s = buf.indexOf('stream', i);
    if (s < 0) break;
    const e = buf.indexOf('endstream', s);
    if (e < 0) break;
    let start = s + 6;
    if (buf[start] === 0x0d) start += 1;
    if (buf[start] === 0x0a) start += 1;
    const raw = buf.subarray(start, e);
    let body: Buffer;
    try {
      body = zlib.inflateSync(raw);
    } catch {
      body = raw;
    }
    out.push(body.toString('latin1'));
    i = e + 9;
  }
  return [...out.join('\n').matchAll(/(?:<([0-9A-Fa-f\s]*)>|\(((?:\\.|[^\\()])*)\))\s*Tj/g)]
    .map((m) => (m[1] != null ? Buffer.from(m[1].replace(/\s+/g, ''), 'hex').toString('latin1') : m[2]))
    .join('\n');
}

describe('b240c0ff — the printed payslip', () => {
  const pdfData = (row: ProcessedPayslipViewRow) => {
    const built = buildPayslipPdfData(
      {
        employee: row.employeeName, employeeCode: row.employeeCode, company: row.company, companyReg: null,
        payPeriod: row.payPeriod, basic: row.basic, allowance: row.allowance, overtime: row.overtime, bonus: row.bonus,
        gross: row.gross, statutory: row.statutory, otherDeductions: row.otherDeductions,
        totalDeductions: row.totalDeductions, net: row.net, employerCost: 0, daysWorked: null,
      },
      { epf: 'EPF', socso: 'SOCSO', skbbk: 'SKBBK', eis: 'EIS', tax: 'PCB' },
    );
    return { ...fixtureData, ...built, employerPeriodTotals: undefined };
  };

  it('prints Unpaid leave and Staff welfare fund in place of the Other deductions lump', async () => {
    const text = drawnText(await renderPayslipPdf(pdfData(imported), labels));
    expect(text).toContain('Unpaid leave');
    expect(text).toContain('Staff welfare fund');
    expect(text).toContain('Meal allowance');
    expect(text).not.toContain('Other deductions');
    expect(text).toContain('1,117.65');
  });

  it('an ordinary slip with no deduction lines still prints Other deductions', async () => {
    const text = drawnText(await renderPayslipPdf(pdfData(ordinary), labels));
    expect(text).toContain('Other deductions');
    expect(text).not.toContain('Unpaid leave');
  });
});
