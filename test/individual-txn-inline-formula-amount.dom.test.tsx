/**
 * aac17dd0 — ADD/EDIT INDIVIDUAL TRANSACTION ON A "CALCULATED BY FORMULA" PAY ITEM.
 *
 * What the operator sees: the Input type select is no longer locked. It offers the item's own quantity
 * (Hours here) and Amount. Hours keeps the read-only calculated amount; Amount hides the Hours box, opens
 * the Amount box for typing and says the formula is not used. A saved Amount reopens as Amount.
 *
 * Only the server-action boundary is stubbed; what the save is CALLED WITH is asserted, because the contract
 * between the screen and the action is what decides whether a formula re-runs over a typed amount. The
 * pricing itself is pinned against the real database in individual-txn-inline-formula-amount.test.ts.
 * Fictional people and items only.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import {
  TxnWorkspace,
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
const createMock = vi.fn();
const detailMock = vi.fn();
const updateMock = vi.fn();
const previewMock = vi.fn();

vi.mock('../app/payroll/transactions/individual/actions', () => ({
  fetchEmployeeTxnPanelAction: (...a: unknown[]) => panelMock(...a),
  fetchBatchImpactAction: () => Promise.resolve(null),
  fetchTxnDetailAction: (...a: unknown[]) => detailMock(...a),
  previewTxnAmountAction: (...a: unknown[]) => previewMock(...a),
  previewTxnAmountsAction: () => Promise.resolve({ ok: true, derived: false }),
  createIndividualTxnAction: (...a: unknown[]) => createMock(...a),
  createIndividualTxnDayGridAction: () => Promise.resolve({ ok: true, id: 'n1', count: 1 }),
  updateIndividualTxnAction: (...a: unknown[]) => updateMock(...a),
  deleteIndividualTxnAction: () => Promise.resolve({ ok: true }),
}));

const EMPLOYEE: TxnEmployee = {
  employmentId: 'e1',
  name: 'Fictional Overtime Clerk',
  employeeCode: 'FX0001',
  department: 'Operations',
  departmentId: 'd1',
  businessUnit: null,
  businessUnitId: null,
  position: 'Clerk',
  company: 'Fictional Works Sdn Bhd',
  companyId: 'c1',
  status: 'active',
};
const COMPANY: TxnCompany = { id: 'c1', name: 'Fictional Works Sdn Bhd', currency: 'MYR' };
/** A "Calculated by Formula" item whose formula reads Hours (rule kind 'formula', resolved on the server). */
const OVERTIME: TxnPayItem = {
  id: 'ot',
  code: 'OTFX',
  name: 'Fictional Overtime',
  kind: 'allowance',
  derives: true,
  formulaBuilder: false,
  amountEntryAllowed: true,
  inputUnit: 'hours',
  variesByDay: true,
  readsCalendarDays: false,
};
const EMPTY_PANEL: TxnPanel = {
  rows: [],
  totals: { count: 0, total: '0.00', pendingCount: 0, pendingTotal: '0.00', processedCount: 0, processedTotal: '0.00', reprocessCount: 0, reprocessTotal: '0.00' },
  stranded: [],
};
const HINT = messages.payroll.transactions.individual.amountManualFormulaHint;

function renderWorkspace() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TxnWorkspace
        employees={[EMPLOYEE]}
        batches={[]}
        companies={[COMPANY]}
        payItems={[OVERTIME]}
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

const inputType = () => screen.getByRole('combobox', { name: 'Input type' }) as HTMLSelectElement;
const optionValues = (s: HTMLSelectElement) => Array.from(s.options).map((o) => [o.value, o.textContent]);

beforeEach(() => {
  vi.clearAllMocks();
  panelMock.mockResolvedValue(EMPTY_PANEL);
  createMock.mockResolvedValue({ ok: true, id: 'n1' });
  updateMock.mockResolvedValue({ ok: true, id: 'r1' });
  detailMock.mockResolvedValue(null);
  // The server's figure for 2 hours: a literal, never recomputed here.
  previewMock.mockResolvedValue({ ok: true, derived: true, amount: '25.00', code: 'OTFX', inputUnit: 'hours', zeroDivisor: null });
});

describe('aac17dd0 · Add transaction on a Calculated by Formula Pay Item', () => {
  it('offers Hours and Amount; Hours shows the read-only calculated amount', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(await screen.findByRole('button', { name: /Fictional Overtime Clerk/ }));
    await user.click(await screen.findByRole('button', { name: '+ Add new transaction' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Payroll item' }), 'c:ot');

    expect(inputType()).not.toBeDisabled();
    expect(inputType().value).toBe('hours');
    expect(optionValues(inputType())).toEqual([['hours', 'Hours'], ['amount', 'Amount']]);

    await user.type(screen.getByLabelText('Hours'), '2');
    const calculated = screen.getByLabelText('Calculated amount') as HTMLInputElement;
    expect(calculated.readOnly).toBe(true);
    await waitFor(() => expect(calculated.value).toBe('25.00'));
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it('Amount hides Hours, opens the Amount box with the note, and saves calculationMethod amount with no quantity', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(await screen.findByRole('button', { name: /Fictional Overtime Clerk/ }));
    await user.click(await screen.findByRole('button', { name: '+ Add new transaction' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Payroll item' }), 'c:ot');
    await user.selectOptions(inputType(), 'amount');

    expect(screen.queryByLabelText('Hours')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Calculated amount')).not.toBeInTheDocument();
    const amount = screen.getByLabelText('Amount') as HTMLInputElement;
    expect(amount.readOnly).toBe(false);
    expect(screen.getByText(HINT)).toBeInTheDocument();

    await user.type(amount, '500');
    fireEvent.change(screen.getByLabelText('Effective date'), { target: { value: '2026-10-15' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock.mock.calls[0][0]).toMatchObject({ componentId: 'ot', amount: 500, quantity: null, unit: 'amount', calculationMethod: 'amount' });
    // No formula preview was asked for while Amount was chosen.
    expect(previewMock.mock.calls.every(([a]) => (a as { unit: string }).unit !== 'amount')).toBe(true);
  });
});

describe('aac17dd0 · Edit reopens the saved Input type', () => {
  const panelRow = (patch: Record<string, unknown>) => ({
    id: 'r1', employmentId: 'e1', batchId: null, batchStatus: null, payPeriod: '2026-10', kind: 'earning', componentId: 'ot',
    componentCode: 'OTFX', componentName: 'Fictional Overtime', txnDate: '2026-10-15', notes: null, source: 'manual', createdOn: '2026-10-15',
    createdBy: null, changedAt: '2026-10-15T00:00:00.000Z', payslipCalculatedAt: null, batchNeedsRecalcForEmployment: false, status: 'pending',
    editable: true, attached: false, recalcOnEdit: false, ...patch,
  });
  const detail = (patch: Record<string, unknown>) => ({
    id: 'r1', employmentId: 'e1', companyId: 'c1', batchId: null, payPeriod: '2026-10', kind: 'earning', componentId: 'ot', txnDate: '2026-10-15',
    notes: null, intendedCycleId: null, editable: true, recalcOnEdit: false, ...patch,
  });
  async function openEdit(user: ReturnType<typeof userEvent.setup>, row: Record<string, unknown>) {
    detailMock.mockResolvedValue(detail(row));
    panelMock.mockResolvedValue({
      ...EMPTY_PANEL,
      rows: [panelRow({ amount: row.amount, quantity: row.quantity, unit: row.unit })],
      totals: { ...EMPTY_PANEL.totals, count: 1, total: String(row.amount), pendingCount: 1, pendingTotal: String(row.amount) },
    });
    await user.click(await screen.findByRole('button', { name: /Fictional Overtime Clerk/ }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await screen.findByRole('combobox', { name: 'Input type' });
  }

  it('a typed Amount row opens in Amount with its value; switching back to Hours sends calculationMethod null', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openEdit(user, { amount: '500.00', quantity: null, unit: 'amount', calculationMethod: 'amount', pricingSource: null });

    expect(inputType().value).toBe('amount');
    expect(inputType()).not.toBeDisabled();
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('500');
    expect(screen.queryByLabelText('Hours')).not.toBeInTheDocument();
    expect(screen.getByText(HINT)).toBeInTheDocument();

    await user.selectOptions(inputType(), 'hours');
    await user.type(screen.getByLabelText('Hours'), '2');
    await waitFor(() => expect((screen.getByLabelText('Calculated amount') as HTMLInputElement).value).toBe('25.00'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock.mock.calls[0][0]).toMatchObject({ id: 'r1', quantity: 2, unit: 'hours', calculationMethod: null });
  });

  it('a quantity row still opens in Hours with the read-only calculated amount', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openEdit(user, { amount: '25.00', quantity: '2.00', unit: 'hours', calculationMethod: null, pricingSource: 'pay_item_rule' });

    expect(inputType().value).toBe('hours');
    expect((screen.getByLabelText('Hours') as HTMLInputElement).value).toBe('2');
    const calculated = screen.getByLabelText('Calculated amount') as HTMLInputElement;
    expect(calculated.readOnly).toBe(true);
    await waitFor(() => expect(calculated.value).toBe('25.00'));
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });
});
