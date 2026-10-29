// @vitest-environment jsdom
/**
 * 34062f81 — what the operator SEES for "Basic Salary / Calendar days in the month × Days worked".
 *
 *   A. Payroll > Pay Items: the division advisory is an informational note (role="note", neutral styling,
 *      "valid and can be saved"), never drawn like a refusal — and a GENUINE validation failure (a literal
 *      zero divisor) still shows its own error and no advisory.
 *   B. Individual Transaction > Day by Day: the batched preview asks per (Effective Date, quantity), so
 *      equal quantities dated in different months get different figures; changing a date re-asks and a
 *      reply for the old dates never paints over the new ones.
 *
 * The server actions are stubbed. The stub's answers are the reporter's own table (RM3,000 basic, 1 day):
 * literal strings, NOT recomputed here, so the test pins the mapping of each answer onto its own line.
 * The arithmetic itself is pinned against the real evaluator in fb-34062f81-calendar-days.test.ts.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import {
  TxnWorkspace,
  type TxnBatch,
  type TxnCompany,
  type TxnEmployee,
  type TxnPayItem,
} from '../app/payroll/transactions/individual/txn-workspace';
import type { TxnPanel } from '../app/payroll/transactions/individual/existing-context';
import { distinctDayEntries, dayEntryKey, blankDayLine } from '../app/payroll/transactions/individual/day-lines';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const panelMock = vi.fn();
const previewOneMock = vi.fn();
const previewManyMock = vi.fn();
const dayGridMock = vi.fn();

vi.mock('../app/payroll/transactions/individual/actions', () => ({
  fetchEmployeeTxnPanelAction: (...a: unknown[]) => panelMock(...a),
  fetchBatchImpactAction: () => Promise.resolve(null),
  fetchTxnDetailAction: () => Promise.resolve(null),
  previewTxnAmountAction: (...a: unknown[]) => previewOneMock(...a),
  previewTxnAmountsAction: (...a: unknown[]) => previewManyMock(...a),
  createIndividualTxnAction: () => Promise.resolve({ ok: true, id: 'n1' }),
  createIndividualTxnDayGridAction: (...a: unknown[]) => dayGridMock(...a),
  updateIndividualTxnAction: () => Promise.resolve({ ok: true }),
  deleteIndividualTxnAction: () => Promise.resolve({ ok: true }),
}));

/** The reporter's table — RM3,000 basic, 1 day worked. Independent literals. */
const EXPECTED_ONE_DAY: Record<string, string> = {
  '2026-09-28': '100.00',
  '2026-10-10': '96.77',
  '2026-02-15': '107.14',
  '2024-02-15': '103.45',
  '2026-04-10': '100.00',
};

const EMPLOYEE: TxnEmployee = {
  employmentId: 'e1',
  name: 'Fictional Person',
  employeeCode: 'X000099',
  department: 'Operations',
  departmentId: 'd1',
  businessUnit: null,
  businessUnitId: null,
  position: 'Clerk',
  company: 'Example Co',
  companyId: 'c1',
  status: 'active',
};
const BATCH: TxnBatch = {
  id: 'b1',
  companyId: 'c1',
  payPeriod: '2026-10',
  runType: 'regular',
  runSeq: 1,
  scope: null,
  status: 'draft',
  needsRecalcAt: null,
  recalcEmploymentIds: null,
  payrollCycleId: null,
};
const COMPANY: TxnCompany = { id: 'c1', name: 'Example Co', currency: 'MYR' };
const UNPAID: TxnPayItem = {
  id: 'upl',
  code: 'UPL',
  name: 'Unpaid Leave',
  kind: 'deduction',
  derives: true,
  inputUnit: 'days',
  variesByDay: true,
  readsCalendarDays: true,
};
const EMPTY_PANEL: TxnPanel = {
  rows: [],
  totals: {
    count: 0,
    total: '0.00',
    pendingCount: 0,
    pendingTotal: '0.00',
    processedCount: 0,
    processedTotal: '0.00',
    reprocessCount: 0,
    reprocessTotal: '0.00',
  },
  stranded: [],
};

type Entry = { txnDate: string; quantity: string };

function renderWorkspace() {
  panelMock.mockResolvedValue(EMPTY_PANEL);
  previewOneMock.mockResolvedValue({ ok: true, derived: false });
  previewManyMock.mockImplementation((input: { entries: Entry[] }) =>
    Promise.resolve({
      ok: true,
      derived: true,
      // Only 1-day lines on the reporter's dates are answered with his figures; anything else is a
      // visibly different placeholder so a mis-mapping cannot pass by coincidence.
      amounts: input.entries.map((e) => ({ ...e, amount: e.quantity === '1' ? (EXPECTED_ONE_DAY[e.txnDate] ?? '1.11') : '9.99' })),
      code: 'UPL',
      inputUnit: 'days',
      zeroDivisor: null,
    }),
  );
  dayGridMock.mockResolvedValue({ ok: true, id: 'n1', count: 5 });
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TxnWorkspace
        employees={[EMPLOYEE]}
        batches={[BATCH]}
        companies={[COMPANY]}
        payItems={[UNPAID]}
        payrollCycles={[]}
        processHref="/payroll"
        requireComponent={false}
        currentPeriod="2026-10"
        panelDefaultOpen
        panelCookieKey="k"
      />
    </NextIntlClientProvider>,
  );
}

async function openDayGrid(user: ReturnType<typeof userEvent.setup>, lineCount: number) {
  await user.click(await screen.findByRole('button', { name: /Fictional Person/ }));
  await user.click(await screen.findByRole('button', { name: '+ Add new transaction' }));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Payroll item' }), 'c:upl');
  await user.click(screen.getByRole('radio', { name: 'Day by day' }));
  for (let i = 1; i < lineCount; i++) await user.click(screen.getByRole('button', { name: 'Add date' }));
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('34062f81 · day-lines keys a figure by (Effective Date, quantity)', () => {
  it('equal quantities on different dates are different questions; the same date + quantity is one', () => {
    const lines = [
      { ...blankDayLine(), txnDate: '2026-10-10', quantity: '1' },
      { ...blankDayLine(), txnDate: '2026-09-28', quantity: '1.00' },
      { ...blankDayLine(), txnDate: '2026-09-28', quantity: '1' },
      { ...blankDayLine(), txnDate: '2026-02-30', quantity: '1' }, // not a real day ⇒ asked undated
      { ...blankDayLine(), txnDate: '', quantity: '0' }, // nothing to price
    ];
    expect(distinctDayEntries(lines)).toEqual([
      { txnDate: '', quantity: '1' },
      { txnDate: '2026-09-28', quantity: '1' },
      { txnDate: '2026-10-10', quantity: '1' },
    ]);
    expect(dayEntryKey({ txnDate: '2026-09-28', quantity: '1.00' })).toBe('2026-09-28|1');
    expect(dayEntryKey({ txnDate: '2026-02-30', quantity: '1' })).toBe('|1');
    expect(dayEntryKey({ txnDate: '2026-09-28', quantity: '' })).toBe('');
  });
});

describe('34062f81 · Day by Day prices each dated line on its own month', () => {
  it('shows the reporter’s five figures against their own dates and posts each line with its date and Days', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openDayGrid(user, 5);
    const dates = Object.keys(EXPECTED_ONE_DAY);
    const dateInputs = screen.getAllByLabelText('Effective date');
    const dayInputs = screen.getAllByLabelText('Days');
    expect(dateInputs).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      fireEvent.change(dateInputs[i], { target: { value: dates[i] } });
      await user.type(dayInputs[i], '1');
    }
    await waitFor(() => {
      const amounts = screen.getAllByLabelText('Calculated amount').map((el) => (el as HTMLInputElement).value);
      expect(amounts).toEqual(['100.00', '96.77', '107.14', '103.45', '100.00']);
    });
    // ONE request, carrying every (date, quantity) pair — the five dates are five questions.
    const last = previewManyMock.mock.calls.at(-1)?.[0] as { entries: Entry[]; unit: string };
    expect(last.unit).toBe('days');
    expect(last.entries).toEqual([
      { txnDate: '2024-02-15', quantity: '1' },
      { txnDate: '2026-02-15', quantity: '1' },
      { txnDate: '2026-04-10', quantity: '1' },
      { txnDate: '2026-09-28', quantity: '1' },
      { txnDate: '2026-10-10', quantity: '1' },
    ]);
    // The explanatory line appears because this item's formula reads Calendar Days in the Month.
    expect(
      screen.getByText(messages.payroll.transactions.individual.dayGridCalendarDaysHint),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save all dates' }));
    await waitFor(() => expect(dayGridMock).toHaveBeenCalledTimes(1));
    const posted = dayGridMock.mock.calls[0][0] as { unit: string; lines: { txnDate: string; quantity: number }[] };
    expect(posted.unit).toBe('days');
    expect(posted.lines.map((l) => [l.txnDate, l.quantity])).toEqual(dates.map((d) => [d, 1]));
  });

  it('changing a line’s date re-asks, and a late reply for the OLD date never paints over the new one', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openDayGrid(user, 1);
    const date = screen.getByLabelText('Effective date');
    fireEvent.change(date, { target: { value: '2026-09-28' } });
    await user.type(screen.getByLabelText('Days'), '1');
    await waitFor(() => expect((screen.getByLabelText('Calculated amount') as HTMLInputElement).value).toBe('100.00'));

    // Hold the next reply (the one for the OLD date) and let the one after it (NEW date) land first.
    let releaseOld: (() => void) | null = null;
    previewManyMock.mockImplementationOnce(
      (input: { entries: Entry[] }) =>
        new Promise((resolve) => {
          releaseOld = () =>
            resolve({ ok: true, derived: true, amounts: input.entries.map((e) => ({ ...e, amount: '555.55' })), code: 'UPL', inputUnit: 'days', zeroDivisor: null });
        }),
    );
    fireEvent.change(date, { target: { value: '2026-09-27' } }); // still September ⇒ held reply
    fireEvent.change(date, { target: { value: '2026-10-10' } }); // October ⇒ answered immediately
    await waitFor(() => expect((screen.getByLabelText('Calculated amount') as HTMLInputElement).value).toBe('96.77'));
    releaseOld!();
    await new Promise((r) => setTimeout(r, 0));
    expect((screen.getByLabelText('Calculated amount') as HTMLInputElement).value).toBe('96.77');
  });
});
