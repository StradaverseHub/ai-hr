// @vitest-environment jsdom
/**
 * ad6ed930 — the New transaction window for someone who has LEFT.
 *
 *   • It starts on the leaving month and the last day, caps the Effective Date picker there, says so under both
 *     fields and explains (one info line) that entries up to that day can still be paid by a later run.
 *   • A later date is refused with the named sentence "This employee left on … Choose an effective date on or
 *     before that day." — on the screen before a round trip, from the server's refusal (whose date wins), and
 *     from the amount preview of a formula item, instead of "check how it is set up under Payroll Items".
 *   • An employee who has not left sees exactly the window they saw before.
 *
 * Server actions are stubbed; the refusals themselves are proven against the database in
 * payroll-leaver-formula-pricing-ad6ed930.test.ts. Fictional people and codes only.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const panelMock = vi.fn();
const previewOneMock = vi.fn();
const createMock = vi.fn();
vi.mock('../app/payroll/transactions/individual/actions', () => ({
  fetchEmployeeTxnPanelAction: (...a: unknown[]) => panelMock(...a),
  fetchBatchImpactAction: () => Promise.resolve(null),
  fetchTxnDetailAction: () => Promise.resolve(null),
  previewTxnAmountAction: (...a: unknown[]) => previewOneMock(...a),
  previewTxnAmountsAction: () => Promise.resolve({ ok: true, derived: false }),
  createIndividualTxnAction: (...a: unknown[]) => createMock(...a),
  createIndividualTxnDayGridAction: () => Promise.resolve({ ok: true, id: 'n1', count: 1 }),
  updateIndividualTxnAction: () => Promise.resolve({ ok: true }),
  deleteIndividualTxnAction: () => Promise.resolve({ ok: true }),
}));

const BASE: TxnEmployee = {
  employmentId: 'e1',
  name: 'Fictional Leaver',
  employeeCode: 'X000042',
  department: 'Operations',
  departmentId: 'd1',
  businessUnit: null,
  businessUnitId: null,
  position: 'Clerk',
  company: 'Example Co',
  companyId: 'c1',
  status: 'ended',
  leftOn: '2026-10-29',
  hasLeft: true,
};
const ACTIVE: TxnEmployee = { ...BASE, employmentId: 'e2', name: 'Fictional Stayer', employeeCode: 'X000043', status: 'active', leftOn: null, hasLeft: false };
const BATCH: TxnBatch = {
  id: 'b1', companyId: 'c1', payPeriod: '2026-10', runType: 'regular', runSeq: 1, scope: null, status: 'draft',
  needsRecalcAt: null, recalcEmploymentIds: null, payrollCycleId: null,
};
const COMPANY: TxnCompany = { id: 'c1', name: 'Example Co', currency: 'MYR' };
const NORMAL_OT: TxnPayItem = {
  id: 'onor', code: 'ONOR', name: 'NORMAL OT', kind: 'allowance', formulaBuilder: true, derives: true, inputUnit: null,
  variesByDay: true, readsCalendarDays: false,
};
const EMPTY_PANEL: TxnPanel = {
  rows: [],
  totals: { count: 0, total: '0.00', pendingCount: 0, pendingTotal: '0.00', processedCount: 0, processedTotal: '0.00', reprocessCount: 0, reprocessTotal: '0.00' },
  stranded: [],
};
const ind = messages.payroll.transactions.individual;
const NAMED = 'This employee left on 29 Oct 2026. Choose an effective date on or before that day.';

function renderWorkspace() {
  panelMock.mockResolvedValue(EMPTY_PANEL);
  previewOneMock.mockResolvedValue({ ok: true, derived: false });
  createMock.mockResolvedValue({ ok: true, id: 'n1' });
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TxnWorkspace
        employees={[BASE, ACTIVE]}
        batches={[BATCH]}
        companies={[COMPANY]}
        payItems={[NORMAL_OT]}
        payrollCycles={[]}
        processHref="/payroll"
        requireComponent={false}
        currentPeriod="2026-11"
        panelDefaultOpen
        panelCookieKey="k"
      />
    </NextIntlClientProvider>,
  );
}

async function openCreate(user: ReturnType<typeof userEvent.setup>, who: RegExp) {
  await user.click(await screen.findByRole('button', { name: who }));
  await user.click(await screen.findByRole('button', { name: ind.addTxn }));
}
const monthInput = () => screen.getByLabelText(ind.monthLabel) as HTMLInputElement;
const dateInput = () => screen.getByLabelText(ind.colEffectiveDate) as HTMLInputElement;

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('ad6ed930 · New transaction for a former employee', () => {
  it('starts on the leaving month and last day, caps the date there and explains it', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openCreate(user, /Fictional Leaver/);
    expect(monthInput().value).toBe('2026-10');
    expect(dateInput().value).toBe('2026-10-29');
    expect(dateInput().max).toBe('2026-10-29');
    expect(screen.getByTestId('txn-leaver-identity').textContent).toContain('Left on 29 Oct 2026');
    expect(screen.getByTestId('txn-leaver-identity').textContent).toContain('X000042');
    expect(screen.getByText('Starts at the leaving month.')).toBeInTheDocument();
    expect(screen.getByText('Latest allowed: 29 Oct 2026 (last working day).')).toBeInTheDocument();
    expect(screen.getByTestId('txn-leaver-info').textContent).toBe(
      'This employee has left. Entries dated on or before 29 Oct 2026 can still be paid; an entry keyed into a later month is picked up by that month’s payroll run.',
    );
  });

  it('refuses a later date on the screen with the named sentence and posts nothing', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openCreate(user, /Fictional Leaver/);
    await user.selectOptions(screen.getByRole('combobox', { name: ind.colItem }), 'k:overtime');
    fireEvent.change(dateInput(), { target: { value: '2026-10-31' } });
    await user.type(screen.getByLabelText(ind.colAmount), '50');
    await user.click(screen.getByRole('button', { name: ind.save }));
    expect(await screen.findByText(NAMED)).toBeInTheDocument();
    expect(screen.queryByText(ind.derivedAmountUnavailable)).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('shows the server’s refusal with the server’s date (the server is the authority)', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    createMock.mockResolvedValue({ ok: false, error: 'txnAfterLeavingDate', errorValues: { leftOn: '2026-10-27' } });
    await openCreate(user, /Fictional Leaver/);
    await user.selectOptions(screen.getByRole('combobox', { name: ind.colItem }), 'k:overtime');
    await user.type(screen.getByLabelText(ind.colAmount), '50');
    await user.click(screen.getByRole('button', { name: ind.save }));
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock.mock.calls[0][0]).toMatchObject({ txnDate: '2026-10-29', payPeriod: '2026-10' });
    expect(await screen.findByText('This employee left on 27 Oct 2026. Choose an effective date on or before that day.')).toBeInTheDocument();
  });

  it('a formula item’s preview refusal names the leaving date instead of blaming the Pay Item set-up', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    previewOneMock.mockResolvedValue({ ok: false, error: 'txnAfterLeavingDate', errorValues: { leftOn: '2026-10-29' } });
    await openCreate(user, /Fictional Leaver/);
    await user.selectOptions(screen.getByRole('combobox', { name: ind.colItem }), 'c:onor');
    await user.type(screen.getByLabelText(ind.quantity), '9');
    expect(await screen.findByText(NAMED)).toBeInTheDocument();
    expect(screen.queryByText(ind.derivedAmountUnavailable)).toBeNull();
    const asked = previewOneMock.mock.calls.at(-1)?.[0] as { txnDate: string; payPeriod: string; calculationMethod: string };
    expect(asked).toMatchObject({ txnDate: '2026-10-29', payPeriod: '2026-10', calculationMethod: 'formula' });
  });
});

describe('ad6ed930 · an employee who has not left is unchanged', () => {
  it('opens on the current month with no default date, no cap, the usual hint and no leaver line', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openCreate(user, /Fictional Stayer/);
    expect(monthInput().value).toBe('2026-11');
    expect(dateInput().value).toBe('');
    expect(dateInput().max).toBe('');
    expect(screen.getByText(ind.effectiveDateHint)).toBeInTheDocument();
    expect(screen.queryByTestId('txn-leaver-info')).toBeNull();
    expect(screen.queryByTestId('txn-leaver-identity')).toBeNull();
    expect(screen.queryByText('Starts at the leaving month.')).toBeNull();
  });
});
