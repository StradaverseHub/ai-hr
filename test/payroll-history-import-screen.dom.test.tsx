/**
 * The Import Payroll History screen, PROVED BY RENDERING (4157a498).
 *
 * WHY THIS EXISTS ALONGSIDE test/payroll-history-import.test.ts. That file proves what the SERVER
 * decided. It cannot prove what a person actually SEES — and the two panels that matter most here, the
 * validation result and the import summary, are rendered from CLIENT state after a server action returns.
 * A dev-server log never sees them: a `t('…')` that resolves to a message with `{placeholders}` throws
 * FORMATTING_ERROR in the BROWSER, paints the raw key path on screen, and leaves the route returning 200
 * with tsc, the suite and `next build` all green. So the panels are rendered here with the REAL en.json
 * and read back.
 *
 * WHAT IS ASSERTED, beyond "it renders":
 *   · the empty state (before any file) shows the reporter's seven headings and the Override warning;
 *   · the validation result carries their seven columns — Excel Row No., Employee No., Payroll Period,
 *     DOE Code, Error Type, Error Description, Import Status — with their own Error Type strings;
 *   · the eight summary counters are all present, and "Updated / overridden" shows 0;
 *   · the Import button is DISABLED until the cannot-be-undone acknowledgement is ticked. That gate is
 *     the last thing standing between a migrator and an irreversible write, so it is asserted, not
 *     eyeballed.
 *
 * Scope note (inherited from the other dom tests): jsdom applies no CSS and computes no layout, so this
 * catches rendering and interaction logic, not a visual regression. The other five locales are covered
 * structurally by test/i18n-coverage.test.ts, and neither replaces reading a dev-server log.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../messages/en.json';
import { HistoryImport } from '../app/payroll/history-import/history-import';
import {
  STATUTORY_IMPORT_CODES,
  type HistoryImportPreview,
  type HistoryImportResult,
} from '../lib/payroll-history-import-schema';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

// The server actions. Validate returns a preview carrying one of everything the panels can render:
// a failed line, a needs-action line, and a warning line.
const validateMock = vi.fn();
const commitMock = vi.fn();
vi.mock('../app/payroll/history-import/actions', () => ({
  validateHistoryImportAction: (...a: unknown[]) => validateMock(...a),
  commitHistoryImportAction: (...a: unknown[]) => commitMock(...a),
}));

const PREVIEW: HistoryImportPreview = {
  companyId: 'c1',
  total: 12,
  valid: 6,
  invalid: 6,
  duplicates: 1,
  existingMonths: 1,
  months: [
    {
      key: 'A1001|2024-01',
      employeeNo: 'A1001',
      period: '2024-01',
      cycle: 'ME',
      companyCode: 'ACME',
      rowNums: [2, 3, 4, 5, 6, 7],
      lineCount: 6,
      ok: true,
      existing: false,
      gross: 5300,
      net: 4532.35,
      errorCount: 0,
      warningCount: 1,
    },
    {
      key: 'A1002|2024-02',
      employeeNo: 'A1002',
      period: '2024-02',
      cycle: 'ME',
      companyCode: 'ACME',
      rowNums: [8, 9, 10],
      lineCount: 3,
      ok: false,
      existing: true,
      gross: 4200,
      net: 3700,
      errorCount: 3,
      warningCount: 0,
    },
    {
      key: 'A9999|2024-03',
      employeeNo: 'A9999',
      period: '2024-03',
      cycle: 'ME',
      companyCode: 'ACME',
      rowNums: [11, 12, 13],
      lineCount: 0,
      ok: false,
      existing: false,
      gross: 0,
      net: 0,
      errorCount: 3,
      warningCount: 0,
    },
  ],
  issues: [
    {
      rowNum: 8,
      employeeNo: 'A1002',
      period: '202402',
      doeCode: 'BASIC',
      type: 'Existing record',
      description: '2024-02 already has payroll for this company — the existing record is kept.',
      status: 'Needs action',
    },
    {
      rowNum: 11,
      employeeNo: 'A9999',
      period: '202403',
      doeCode: 'BASIC',
      type: 'Invalid Employee No',
      description: 'Employee does not exist in Employee Master for this company',
      status: 'Failed',
    },
    {
      rowNum: 2,
      employeeNo: 'A1001',
      period: '202401',
      doeCode: 'BASIC',
      type: 'EA breakdown',
      description: 'Every earning line is coded to basic pay.',
      status: 'Warning',
    },
  ],
  missingColumns: [],
};

const RESULT: HistoryImportResult = {
  companyId: 'c1',
  total: 12,
  valid: 6,
  invalid: 6,
  imported: 6,
  importedMonths: 1,
  updated: 0,
  duplicates: 1,
  existing: 1,
  failed: 6,
  issues: PREVIEW.issues,
};

const wrap = (ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

const screenUnderTest = () =>
  wrap(
    <HistoryImport
      companies={[{ id: 'c1', name: 'Acme Sdn Bhd', companyLabel: 'ACME' }]}
      defaultCompanyId="c1"
      codes={[...STATUTORY_IMPORT_CODES]}
      cyclesByCompany={{ c1: [{ name: 'Monthly', code: 'ME' }] }}
    />,
  );

/**
 * The failure this file exists to catch: next-intl paints the raw dotted key path when a message is
 * missing or cannot format. Nothing on this screen should ever contain one.
 */
const expectNoRawKeys = (container: HTMLElement) => {
  expect(container.textContent ?? '').not.toMatch(/payroll\.historyImport\./);
  expect(container.textContent ?? '').not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR|IntlError/);
};

describe('Import Payroll History screen', () => {
  it('the empty state shows the reporter’s seven headings and says Override cannot replace', async () => {
    const user = userEvent.setup();
    const { container } = screenUnderTest();

    // The upload affordance and the Company Code the file must carry.
    expect(screen.getByText('Upload file')).toBeTruthy();
    expect(screen.getByText('ACME')).toBeTruthy();

    // Open the reference panel — the seven headings live there, verbatim and in order.
    await user.click(screen.getByText('Columns, codes and cycles this import accepts'));
    const headings = [...container.querySelectorAll('ol code')].map((c) => c.textContent);
    expect(headings).toEqual([
      'Employee No',
      'Payroll Period',
      'Payroll Cycle',
      'DOE Code',
      'Company Code',
      'Amount',
      'Override?',
    ]);

    // The refusal to overwrite is stated where a migrator reads it, not only in a code comment.
    expect(container.textContent).toMatch(/Override is read and checked/);
    expect(container.textContent).toMatch(/never written over/);
    // The cycle code and the accepted DOE codes are both listed.
    expect(container.textContent).toMatch(/ME/);
    expect(container.textContent).toMatch(/EEEPF/);
    expectNoRawKeys(container);
  });

  it('after a check with errors, renders the reporter’s seven-column validation result', async () => {
    validateMock.mockResolvedValue(PREVIEW);
    const user = userEvent.setup();
    const { container } = screenUnderTest();

    await user.click(screen.getByText('Or paste the rows instead'));
    await user.type(screen.getByPlaceholderText(/Employee No,Payroll Period/), 'x');
    await user.click(screen.getByRole('button', { name: 'Check the file' }));
    await screen.findByText('Validation result');

    // The eight summary counters the reporter listed.
    for (const label of [
      'Total uploaded',
      'Valid records',
      'Invalid records',
      'Duplicate records',
      'Existing months held',
      'Updated / overridden',
    ]) {
      expect(screen.getAllByText(label).length, `summary must show "${label}"`).toBeGreaterThan(0);
    }

    // The validation-result table, column for column.
    const resultCard = screen.getByText('Validation result').closest('div')!.parentElement!;
    const headers = [...resultCard.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headers).toEqual([
      'Excel Row No.',
      'Employee No.',
      'Payroll Period',
      'DOE Code',
      'Error Type',
      'Error Description',
      'Import Status',
    ]);

    // The reporter's own Error Type strings, and the three import statuses.
    expect(container.textContent).toMatch(/Invalid Employee No/);
    expect(container.textContent).toMatch(/Existing record/);
    expect(screen.getAllByText('Needs action').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Failed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Warning').length).toBeGreaterThan(0);

    // The employee-month table shows the held month, including the one whose every line failed.
    const monthsCard = screen.getByText('Employee months').closest('div')!.parentElement!;
    const monthRows = [...monthsCard.querySelectorAll('tbody tr')].map((tr) =>
      (tr.querySelector('td')?.textContent ?? '').trim(),
    );
    expect(monthRows).toEqual(['A1001', 'A1002', 'A9999']);
    expectNoRawKeys(container);
  });

  it('the Import button stays disabled until the cannot-be-undone acknowledgement is ticked', async () => {
    validateMock.mockResolvedValue(PREVIEW);
    commitMock.mockResolvedValue(RESULT);
    const user = userEvent.setup();
    const { container } = screenUnderTest();

    await user.click(screen.getByText('Or paste the rows instead'));
    await user.type(screen.getByPlaceholderText(/Employee No,Payroll Period/), 'x');
    await user.click(screen.getByRole('button', { name: 'Check the file' }));

    const importBtn = await screen.findByRole('button', { name: /Import 1 month/ });
    expect((importBtn as HTMLButtonElement).disabled, 'must be disabled before acknowledgement').toBe(true);

    await user.click(screen.getByRole('checkbox'));
    expect((importBtn as HTMLButtonElement).disabled, 'must be enabled after acknowledgement').toBe(false);

    // …and the summary that follows carries all eight counters, with Updated / overridden at 0.
    await user.click(importBtn);
    await screen.findByText('Payroll history import summary');
    const summaryCard = screen.getByText('Payroll history import summary').closest('div')!.parentElement!;
    const cells = [...summaryCard.querySelectorAll('dl > div')].map((d) => [
      d.querySelector('dt')?.textContent,
      d.querySelector('dd')?.textContent,
    ]);
    expect(cells).toEqual([
      ['Total uploaded', '12'],
      ['Valid records', '6'],
      ['Invalid records', '6'],
      ['Records imported', '6'],
      ['Updated / overridden', '0'],
      ['Duplicate records', '1'],
      ['Failed records', '6'],
      ['Existing months held', '1'],
    ]);
    expect(within(summaryCard).getByText(/Override is read and checked/)).toBeTruthy();
    expectNoRawKeys(container);
  });
});
