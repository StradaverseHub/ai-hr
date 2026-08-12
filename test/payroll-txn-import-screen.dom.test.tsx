/**
 * The Fixed / Individual Transaction Excel import, PROVED BY RENDERING (5c65367d).
 *
 * WHY THIS EXISTS ALONGSIDE test/payroll-txn-import.test.ts. That file proves what the SERVER decided.
 * It cannot prove what a person actually SEES — and everything this item promises the reporter is
 * rendered from CLIENT state after a server action returns: the validation table, the valid/error
 * counts, the Download error report button, and the Confirm Import button that must not be pressable
 * when there is nothing valid to write. A dev-server log never sees any of it. r185 hit exactly this and
 * answered it with a DOM test; this is the same answer for the same reason.
 *
 * WHAT IS ASSERTED:
 *   · a .csv is REFUSED with the reporter's own words, and the server is never called;
 *   · a validated file shows every row with Valid or its own reason, and the three counters;
 *   · the reason is resolved from a KEY against the real en.json, with its ICU values filled in — a
 *     server-built sentence would be English in six locales, which is why the server sends keys;
 *   · Confirm Import is DISABLED when nothing is valid, and writes only on the press;
 *   · the summary after a commit reports what was written, what failed, and which runs now need
 *     reprocessing.
 *
 * Scope note, inherited from the other dom tests: jsdom applies no CSS and computes no layout, so this
 * catches rendering and interaction logic, not a visual regression.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../messages/en.json';
import { TxnImportButtons } from '../app/payroll/transactions/import-excel/txn-import-dialog';
import type { TxnImportPreview, TxnImportResult } from '../lib/payroll-txn-import-schema';
import type { TxnTemplateReference } from '../lib/import-template-xlsx';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const validateMock = vi.fn();
const commitMock = vi.fn();
vi.mock('../app/payroll/transactions/import-excel/actions', () => ({
  validateTxnImportAction: (...a: unknown[]) => validateMock(...a),
  commitTxnImportAction: (...a: unknown[]) => commitMock(...a),
}));

// The .xlsx reader, stubbed: jsdom has no real File.arrayBuffer worth exercising here, and what this
// file is about is the panels, not SheetJS (test/payroll-txn-import-template.test.ts drives the real
// reader against a real workbook).
vi.mock('../lib/spreadsheet', async (orig) => ({
  ...(await orig<typeof import('../lib/spreadsheet')>()),
  workbookToCsvText: vi.fn(async () => 'Employee ID,Pay Item Code,Amount,Start Date\nX000001,BONUS,100,2026-08-01\n'),
  buildXlsx: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

const REFERENCE: TxnTemplateReference = {
  headings: {
    employees: 'Employees', employeeId: 'Employee ID', employeeName: 'Employee name', company: 'Company',
    department: 'Department', payItems: 'Pay items', payItemCode: 'Pay item code', payItemName: 'Pay item',
    payItemKind: 'Type', payItemInput: 'Input required', cycles: 'Cycles', cycleCode: 'Payroll cycle',
    cycleLabel: 'Description', kinds: 'Kinds', kindCode: 'Kind', kindLabel: 'Description', example: 'Example',
    note: 'Fill in the FIRST sheet.',
  },
  employees: [{ code: 'X000001', name: 'Irwin Law', company: 'Demo', department: 'Ops' }],
  payItems: [{ code: 'BONUS', name: 'Bonus', kind: 'allowance', input: '' }],
  cycles: [{ code: 'regular', label: 'Regular' }],
  kinds: [{ code: 'earning', label: 'Earning' }],
};

const PREVIEW: TxnImportPreview = {
  kind: 'fixed',
  total: 3,
  valid: 1,
  invalid: 2,
  rows: [
    {
      rowNum: 2,
      employeeId: 'X000001',
      employeeName: 'Irwin Law',
      payItemCode: 'BONUS',
      payItem: 'Bonus',
      effectiveFrom: '2026-08-01',
      amount: '100.00',
      ok: true,
      reason: '',
    },
    {
      rowNum: 3,
      employeeId: 'NOBODY-1',
      employeeName: '',
      payItemCode: 'BONUS',
      payItem: '',
      effectiveFrom: '2026-08-01',
      amount: '100.00',
      ok: false,
      reason: 'employeeUnknown',
      detail: { value: 'NOBODY-1' },
    },
    {
      rowNum: 4,
      employeeId: 'X000001',
      employeeName: 'Irwin Law',
      payItemCode: 'HANDPHONE',
      payItem: 'Handphone Allowance',
      effectiveFrom: '2026-09-01',
      amount: '50.00',
      ok: false,
      reason: 'overlap',
      detail: { code: 'HANDPHONE', from: '2026-01-01', to: '2026-12-31' },
    },
  ],
};

const RESULT: TxnImportResult = {
  kind: 'fixed',
  written: 1,
  failed: [
    {
      rowNum: 2,
      employeeId: 'X000001',
      employeeName: 'Irwin Law',
      payItemCode: 'BONUS',
      payItem: 'Bonus',
      effectiveFrom: '2026-08-01',
      amount: '100.00',
      ok: false,
      reason: 'closedRun',
      detail: { period: '2026-08' },
    },
  ],
  recalcBatchIds: ['b1'],
};

function renderButtons(kind: 'fixed' | 'individual' = 'fixed') {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TxnImportButtons kind={kind} reference={REFERENCE} />
    </NextIntlClientProvider>,
  );
}

/** A File the component will accept or refuse purely on its NAME — which is the gate under test. */
const file = (name: string) => new File(['x'], name, { type: 'application/octet-stream' });

beforeEach(() => {
  vi.clearAllMocks();
  validateMock.mockResolvedValue(PREVIEW);
  commitMock.mockResolvedValue(RESULT);
});

describe('5c65367d · the toolbar', () => {
  it('offers Import Excel and Download template on both screens', async () => {
    renderButtons('fixed');
    expect(screen.getByRole('button', { name: 'Import Excel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download template' })).toBeInTheDocument();
  });

  it('names the screen it is importing for', async () => {
    const user = userEvent.setup();
    renderButtons('individual');
    await user.click(screen.getByRole('button', { name: 'Import Excel' }));
    expect(screen.getByRole('heading', { name: 'Import Individual Transactions from Excel' })).toBeInTheDocument();
  });
});

describe('5c65367d · the file-type gate', () => {
  /** The reporter asked for this message, in these words, for anything that is not .xlsx. */
  it.each(['transactions.csv', 'transactions.xls', 'notes.txt', 'scan.pdf'])('refuses %s', async (name) => {
    // `applyAccept: false` is a SETUP option in user-event 14 (not an argument to upload). Without it
    // userEvent filters the file against the input's `accept` attribute and no change event fires at
    // all — the test would then pass while the guard never ran. The accept attribute is only a picker
    // hint, which an operator bypasses with "All files"; the extension check inside the component is the
    // actual gate, and it is what this asserts.
    const user = userEvent.setup({ applyAccept: false });
    renderButtons();
    await user.click(screen.getByRole('button', { name: 'Import Excel' }));
    await user.upload(screen.getByLabelText('Choose .xlsx file'), file(name));

    expect(
      screen.getByText('Invalid file format. Please upload an Excel file in .xlsx format.'),
    ).toBeInTheDocument();
    // And the server was never asked — the refusal is local, so a wrong file costs no round trip.
    expect(validateMock).not.toHaveBeenCalled();
  });

  it('accepts .xlsx and validates it', async () => {
    const user = userEvent.setup();
    renderButtons();
    await user.click(screen.getByRole('button', { name: 'Import Excel' }));
    await user.upload(screen.getByLabelText('Choose .xlsx file'), file('transactions.xlsx'));
    expect(await screen.findByText('3 records')).toBeInTheDocument();
    expect(validateMock).toHaveBeenCalledTimes(1);
    expect(validateMock.mock.calls[0][1]).toBe('fixed');
  });
});

describe('5c65367d · the preview', () => {
  const openWithFile = async (user: ReturnType<typeof userEvent.setup>) => {
    renderButtons();
    await user.click(screen.getByRole('button', { name: 'Import Excel' }));
    await user.upload(screen.getByLabelText('Choose .xlsx file'), file('transactions.xlsx'));
    return screen.findByText('3 records');
  };

  it('counts total, valid and failed', async () => {
    const user = userEvent.setup();
    await openWithFile(user);
    expect(screen.getByText('3 records')).toBeInTheDocument();
    expect(screen.getByText('1 valid')).toBeInTheDocument();
    expect(screen.getByText('2 with errors')).toBeInTheDocument();
  });

  it('lists every row with its own reason, resolved from the KEY with its values filled in', async () => {
    const user = userEvent.setup();
    await openWithFile(user);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Valid')).toBeInTheDocument();
    // The server sent `employeeUnknown` + { value }; the SCREEN turned it into a sentence, which is what
    // makes the same failure readable in Malay for a Malay-reading admin.
    expect(within(table).getByText('Employee ID NOBODY-1 does not exist')).toBeInTheDocument();
    // And the overlap reason names the clashing record and its dates — the whole point of carrying
    // `detail` off a typed error rather than a pre-built string.
    expect(
      within(table).getByText('The employee already has HANDPHONE covering 2026-01-01 to 2026-12-31 — the dates overlap'),
    ).toBeInTheDocument();
    // The spreadsheet's own row numbers, so the operator can find the line.
    expect(within(table).getByText('2')).toBeInTheDocument();
    expect(within(table).getByText('4')).toBeInTheDocument();
  });

  it('offers the error report only when something failed', async () => {
    const user = userEvent.setup();
    await openWithFile(user);
    expect(screen.getByRole('button', { name: 'Download error report' })).toBeInTheDocument();
  });

  it('writes NOTHING until Confirm is pressed, and then writes only the valid rows', async () => {
    const user = userEvent.setup();
    await openWithFile(user);
    expect(commitMock).not.toHaveBeenCalled();

    const confirm = screen.getByRole('button', { name: 'Import 1 valid record' });
    await user.click(confirm);
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(commitMock.mock.calls[0][1]).toBe('fixed');
  });

  it('DISABLES Confirm when nothing in the file is valid', async () => {
    validateMock.mockResolvedValue({ ...PREVIEW, valid: 0, invalid: 3 });
    const user = userEvent.setup();
    renderButtons();
    await user.click(screen.getByRole('button', { name: 'Import Excel' }));
    await user.upload(screen.getByLabelText('Choose .xlsx file'), file('transactions.xlsx'));
    await screen.findByText('3 records');
    expect(screen.getByRole('button', { name: 'Import 0 valid records' })).toBeDisabled();
  });

  it('a whole-FILE refusal replaces the table rather than listing three hundred identical rows', async () => {
    validateMock.mockResolvedValue({ kind: 'fixed', total: 0, valid: 0, invalid: 0, rows: [], fileError: 'missingColumns' });
    const user = userEvent.setup();
    renderButtons();
    await user.click(screen.getByRole('button', { name: 'Import Excel' }));
    await user.upload(screen.getByLabelText('Choose .xlsx file'), file('transactions.xlsx'));
    expect(
      await screen.findByText('That file is missing required columns. Download the template and use its headings unchanged.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('5c65367d · what actually happened', () => {
  it('reports what was written, what failed and which runs now need reprocessing', async () => {
    const user = userEvent.setup();
    renderButtons();
    await user.click(screen.getByRole('button', { name: 'Import Excel' }));
    await user.upload(screen.getByLabelText('Choose .xlsx file'), file('transactions.xlsx'));
    await screen.findByText('3 records');
    await user.click(screen.getByRole('button', { name: 'Import 1 valid record' }));

    expect(await screen.findByText('1 record imported')).toBeInTheDocument();
    expect(screen.getByText('1 record could not be imported')).toBeInTheDocument();
    // A row that passed the pre-flight and was refused at WRITE time is reported, never swallowed.
    expect(screen.getByText('Row 2 (X000001): The pay run for 2026-08 is closed')).toBeInTheDocument();
    // The request's payroll-status rule, said out loud rather than left for the operator to discover.
    expect(
      screen.getByText(
        '1 processed pay run now needs reprocessing — imported transactions behave exactly like ones entered by hand.',
      ),
    ).toBeInTheDocument();
  });
});
