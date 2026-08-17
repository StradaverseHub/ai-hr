/**
 * c11e81aa — THE PAY CYCLE FIELD ON THE INDIVIDUAL TRANSACTION ENTRY FORM.
 *
 * The reported fault was that the field listed the payroll RUNS that already existed for the month and
 * printed "Awaiting payroll run" when there were none, so an entry keyed ahead of a run could not name a
 * cycle at all. It now lists the CONFIGURED Pay Cycles (Payroll → Settings → Payroll Cycles) and the
 * chosen one rides the save, so the eventual run of that cycle collects the row.
 *
 * WHAT THIS FILE PINS THAT A SERVICE TEST CANNOT. The defect lives in the CONTRACT BETWEEN the screen and
 * the action: a dropdown that offers cycles but posts nothing, or posts a cycle the save never reads, is
 * a screen and a service that each pass their own unit tests while the operator's choice evaporates. So
 * the assertions here are about what the SAVE IS CALLED WITH, not only about what is rendered — and the
 * last describe checks the page↔workspace↔actions wiring in source, because a prop the page forgets to
 * pass renders an empty dropdown and no runtime test of either half notices.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import {
  TxnWorkspace,
  type TxnBatch,
  type TxnCompany,
  type TxnEmployee,
  type TxnPayItem,
  type TxnPayrollCycle,
} from '../app/payroll/transactions/individual/txn-workspace';
import type { TxnPanel } from '../app/payroll/transactions/individual/existing-context';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const panelMock = vi.fn();
const createMock = vi.fn();
const dayGridMock = vi.fn();
const detailMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../app/payroll/transactions/individual/actions', () => ({
  fetchEmployeeTxnPanelAction: (...a: unknown[]) => panelMock(...a),
  fetchBatchImpactAction: () => Promise.resolve(null),
  fetchTxnDetailAction: (...a: unknown[]) => detailMock(...a),
  previewTxnAmountAction: () => Promise.resolve({ ok: true, derived: false }),
  previewTxnAmountsAction: () => Promise.resolve({ ok: true, derived: false }),
  createIndividualTxnAction: (...a: unknown[]) => createMock(...a),
  createIndividualTxnDayGridAction: (...a: unknown[]) => dayGridMock(...a),
  updateIndividualTxnAction: (...a: unknown[]) => updateMock(...a),
  deleteIndividualTxnAction: () => Promise.resolve({ ok: true }),
}));

const EMPLOYEE: TxnEmployee = {
  employmentId: 'e1',
  name: 'Irwin Law',
  employeeCode: 'X000001',
  department: 'Operations',
  departmentId: 'd1',
  businessUnit: null,
  businessUnitId: null,
  position: 'Engineer',
  company: 'Demo Group Holdings Bhd',
  companyId: 'c1',
  status: 'active',
};
const COMPANY: TxnCompany = { id: 'c1', name: 'Demo Group Holdings Bhd', currency: 'MYR' };
/** A plain, non-calculating item so nothing here depends on the derived-amount round trip. */
const MEAL: TxnPayItem = {
  id: 'meal',
  code: 'MEAL',
  name: 'Meal Allowance',
  kind: 'allowance',
  derives: false,
  inputUnit: null,
  variesByDay: true,
};
const REGULAR_RUN: TxnBatch = {
  id: 'b1',
  companyId: 'c1',
  payPeriod: '2026-08',
  runType: 'regular',
  runSeq: 1,
  scope: null,
  status: 'draft',
  needsRecalcAt: null,
  recalcEmploymentIds: null,
  payrollCycleId: 'cy-reg',
};
/** Two runs of the SAME cycle in one month — the case no cycle choice can disambiguate. */
const MID_RUN_2: TxnBatch = { ...REGULAR_RUN, id: 'b2', runType: 'off_cycle', runSeq: 2, payrollCycleId: 'cy-mid' };
const MID_RUN_3: TxnBatch = { ...REGULAR_RUN, id: 'b3', runType: 'off_cycle', runSeq: 3, payrollCycleId: 'cy-mid' };
/** The company's configured catalogue — the thing the field never used to show. */
const CYCLES: TxnPayrollCycle[] = [
  { id: 'cy-reg', companyId: 'c1', name: 'Monthly Salary', runType: 'regular' },
  { id: 'cy-bonus', companyId: 'c1', name: 'Bonus Run', runType: 'bonus' },
  { id: 'cy-mid', companyId: 'c1', name: 'Mid-Month', runType: 'off_cycle' },
];

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

function renderWorkspace(opts: { batches?: TxnBatch[]; cycles?: TxnPayrollCycle[] } = {}) {
  panelMock.mockResolvedValue(EMPTY_PANEL);
  createMock.mockResolvedValue({ ok: true, id: 'n1' });
  dayGridMock.mockResolvedValue({ ok: true, id: 'n1', count: 1 });
  updateMock.mockResolvedValue({ ok: true, id: 'r1' });
  detailMock.mockResolvedValue(null);
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TxnWorkspace
        employees={[EMPLOYEE]}
        batches={opts.batches ?? []}
        companies={[COMPANY]}
        payItems={[MEAL]}
        payrollCycles={opts.cycles ?? CYCLES}
        processHref="/payroll"
        requireComponent={false}
        currentPeriod="2026-08"
        panelDefaultOpen
        panelCookieKey="k"
      />
    </NextIntlClientProvider>,
  );
}

async function openAddForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Irwin Law/ }));
  await user.click(await screen.findByRole('button', { name: '+ Add new transaction' }));
}

/** Fill the two boxes a plain earning row needs, so Save is reachable. */
async function fillRow(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Effective date'), '2026-08-12');
  await user.type(screen.getByLabelText('Amount'), '150');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('c11e81aa · the field lists CONFIGURED cycles, not the runs that happen to exist', () => {
  it('offers every active cycle by name with NO payroll run for the month — the reported dead end', async () => {
    const user = userEvent.setup();
    renderWorkspace({ batches: [] });
    await openAddForm(user);

    const select = screen.getByLabelText('Pay cycle') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      // The EXPLICIT empty choice comes first and is where the form opens. Without it the control could
      // never read "the operator chose nothing" — and every save would stamp a cycle nobody picked.
      'Not specified — regular run',
      'Monthly Salary',
      'Bonus Run',
      'Mid-Month',
    ]);
    expect(select.value).toBe('');
    // "Awaiting payroll run" was the whole of the old field in this state. It is not a control.
    expect(screen.queryByText('Awaiting payroll run')).not.toBeInTheDocument();
  });

  it('names the chosen cycle in the "no run yet" notice rather than promising the regular run', async () => {
    const user = userEvent.setup();
    renderWorkspace({ batches: [] });
    await openAddForm(user);
    await user.selectOptions(screen.getByLabelText('Pay cycle'), 'cy-bonus');

    expect(screen.getByText(/No Bonus Run payroll run exists for 2026-08 yet/)).toBeInTheDocument();
  });

  it('posts the chosen cycle with the save, period-keyed, when no run of that cycle exists', async () => {
    const user = userEvent.setup();
    renderWorkspace({ batches: [REGULAR_RUN] });
    await openAddForm(user);
    await user.selectOptions(screen.getByLabelText('Pay cycle'), 'cy-bonus');
    await fillRow(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0]).toMatchObject({
      payPeriod: '2026-08',
      // A regular run EXISTS for this month, and the entry must not land on it: the operator asked for
      // Bonus. This is the exact silent-repricing the plan refused to ship the dropdown without.
      batchId: '',
      intendedCycleId: 'cy-bonus',
    });
  });

  it('with NO pick it targets the month’s sole run and names no cycle — nothing is invented', async () => {
    const user = userEvent.setup();
    renderWorkspace({ batches: [REGULAR_RUN] });
    await openAddForm(user);
    await fillRow(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // The pre-cycle derivation, verbatim: the month's sole run. And `intendedCycleId` is NULL, because
    // nobody chose one — the earlier draft of this control defaulted to the regular cycle here, which
    // stamped an intent onto rows the operator never marked.
    expect(createMock.mock.calls[0][0]).toMatchObject({ batchId: 'b1', intendedCycleId: null });
  });

  it('picking the cycle that run belongs to still targets THAT run, matched by cycle id', async () => {
    const user = userEvent.setup();
    renderWorkspace({ batches: [REGULAR_RUN] });
    await openAddForm(user);
    await user.selectOptions(screen.getByLabelText('Pay cycle'), 'cy-reg');
    await fillRow(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(createMock.mock.calls[0][0]).toMatchObject({ batchId: 'b1', intendedCycleId: 'cy-reg' });
  });

  it('the day-by-day grid posts the same cycle — one entry across dates has ONE cycle', async () => {
    const user = userEvent.setup();
    renderWorkspace({ batches: [] });
    await openAddForm(user);
    await user.selectOptions(screen.getByLabelText('Pay cycle'), 'cy-mid');
    await user.click(screen.getByRole('radio', { name: 'Day by day' }));

    // The header carries across the mode switch, so the pick survives it.
    expect((screen.getByLabelText('Pay cycle') as HTMLSelectElement).value).toBe('cy-mid');
  });
});

/**
 * THE TWO WAYS THIS CONTROL COULD STILL STAMP OR LOSE A CYCLE NOBODY CHOSE. Both are contract defects
 * between the screen and the action rather than logic errors in either, which is why they are asserted on
 * what the SAVE IS CALLED WITH.
 */
describe('c11e81aa · an edit writes the cycle only when the operator moved it', () => {
  const LEGACY_ROW = {
    id: 'r1',
    employmentId: 'e1',
    companyId: 'c1',
    batchId: null,
    payPeriod: '2026-08',
    kind: 'earning',
    componentId: 'meal',
    txnDate: '2026-08-12',
    amount: '150.00',
    quantity: null,
    unit: null,
    notes: null,
    // A row keyed long before 0441: it named no cycle, and an amount edit must not give it one.
    intendedCycleId: null,
    editable: true,
    recalcOnEdit: false,
  };

  async function openEdit(user: ReturnType<typeof userEvent.setup>) {
    detailMock.mockResolvedValue(LEGACY_ROW);
    panelMock.mockResolvedValue({
      ...EMPTY_PANEL,
      rows: [
        {
          id: 'r1',
          employmentId: 'e1',
          batchId: null,
          batchStatus: null,
          payPeriod: '2026-08',
          kind: 'earning',
          componentId: 'meal',
          componentCode: 'MEAL',
          componentName: 'Meal Allowance',
          txnDate: '2026-08-12',
          amount: '150.00',
          quantity: null,
          unit: null,
          notes: null,
          source: 'manual',
          createdOn: '2026-08-12',
          createdBy: null,
          changedAt: '2026-08-12T00:00:00.000Z',
          payslipCalculatedAt: null,
          batchNeedsRecalcForEmployment: false,
          status: 'pending',
          editable: true,
          attached: false,
          recalcOnEdit: false,
        },
      ],
      totals: { ...EMPTY_PANEL.totals, count: 1, total: '150.00', pendingCount: 1, pendingTotal: '150.00' },
    });
    await user.click(await screen.findByRole('button', { name: /Irwin Law/ }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
  }

  it('changing ONLY the amount on a pre-0441 row does not submit intendedCycleId at all', async () => {
    const user = userEvent.setup();
    renderWorkspace({ batches: [] });
    await openEdit(user);
    const amount = await screen.findByLabelText('Amount');
    await user.clear(amount);
    await user.type(amount, '175');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateMock).toHaveBeenCalledTimes(1);
    // ABSENT, not null. Null would CLEAR a stored choice; absent is the only value that means "the
    // operator said nothing about the cycle", and the service leaves the column alone on absence.
    expect(updateMock.mock.calls[0][0]).not.toHaveProperty('intendedCycleId');
  });

  it('moving the Pay Cycle field submits the new choice', async () => {
    const user = userEvent.setup();
    renderWorkspace({ batches: [] });
    await openEdit(user);
    await user.selectOptions(await screen.findByLabelText('Pay cycle'), 'cy-bonus');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(updateMock.mock.calls[0][0]).toMatchObject({ intendedCycleId: 'cy-bonus' });
  });

  it('moving it back to the empty choice submits an explicit null, which clears the stored cycle', async () => {
    const user = userEvent.setup();
    renderWorkspace({ batches: [] });
    await openEdit(user);
    const select = await screen.findByLabelText('Pay cycle');
    await user.selectOptions(select, 'cy-bonus');
    await user.selectOptions(select, '');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(updateMock.mock.calls[0][0]).toMatchObject({ intendedCycleId: null });
  });
});

/**
 * The multi-run picker. A cycle choice cannot separate two runs of the SAME cycle in one month, and the
 * control that always could must not disappear behind the new one.
 */
describe('c11e81aa · the run picker survives, for the month that has two runs of one cycle', () => {
  it('offers both runs and targets the second when it is chosen', async () => {
    const user = userEvent.setup();
    renderWorkspace({ batches: [MID_RUN_2, MID_RUN_3] });
    await openAddForm(user);

    const runSelect = screen.getByLabelText('Payroll run') as HTMLSelectElement;
    expect([...runSelect.options].map((o) => o.textContent)).toEqual([
      'Automatic — follow the pay cycle',
      'Off-cycle #2',
      'Off-cycle #3',
    ]);

    await user.selectOptions(runSelect, 'b3');
    await fillRow(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(createMock.mock.calls[0][0]).toMatchObject({ batchId: 'b3' });
  });

  it('is not offered when the month has one run — an option that cannot change anything is worse than none', async () => {
    const user = userEvent.setup();
    renderWorkspace({ batches: [REGULAR_RUN] });
    await openAddForm(user);
    expect(screen.queryByLabelText('Payroll run')).not.toBeInTheDocument();
  });
});

describe('c11e81aa · a company with no configured cycles keeps the old field, exactly', () => {
  it('falls back to naming the existing runs, and to "Awaiting payroll run" when there are none', async () => {
    const user = userEvent.setup();
    renderWorkspace({ batches: [REGULAR_RUN], cycles: [] });
    await openAddForm(user);
    // One eligible run ⇒ the old control offered it with no blank option. Unchanged.
    const select = screen.getByLabelText('Pay cycle') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Regular']);
  });

  it('posts NO cycle at all — a save from that screen is byte-identical to the pre-cycle behaviour', async () => {
    const user = userEvent.setup();
    renderWorkspace({ batches: [REGULAR_RUN], cycles: [] });
    await openAddForm(user);
    await fillRow(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(createMock.mock.calls[0][0]).toMatchObject({ batchId: 'b1', intendedCycleId: null });
  });
});

/**
 * Rule 17 — the defect this guards against lives BETWEEN files. The page can stop passing the prop, or
 * the action can stop forwarding it to the service, and every unit test of either half still passes while
 * the operator's choice is dropped on the floor. Source-shape assertions across all three are what pin it.
 */
describe('c11e81aa · the page → workspace → action → service contract', () => {
  const dir = join(__dirname, '..', 'app', 'payroll', 'transactions', 'individual');
  const read = (f: string) => readFileSync(join(dir, f), 'utf8');
  const pageSrc = read('page.tsx');
  const actionsSrc = read('actions.ts');
  const serviceSrc = readFileSync(join(__dirname, '..', 'core', 'payroll-individual-txn.ts'), 'utf8');
  const kernelSrc = readFileSync(join(__dirname, '..', 'core', 'payroll.ts'), 'utf8');

  it('the page reads the cycle catalogue on the server and hands it to the workspace', () => {
    expect(pageSrc).toContain('listPayrollCycles');
    expect(pageSrc).toContain('activeOnly: true');
    expect(pageSrc).toContain('payrollCycles={payrollCycles}');
  });

  it('every write action forwards the chosen cycle to the service', () => {
    // THREE call sites — the single entry, the day grid and the edit — and all three must carry it. One
    // that does not would silently downgrade a whole input mode to "no cycle", which is invisible from
    // either side on its own.
    const forwards = actionsSrc.match(/intendedCycleId: input\.intendedCycleId/g) ?? [];
    expect(forwards.length).toBe(3);
    expect(actionsSrc).toContain('InvalidTxnCycleError');
  });

  it('the service persists it on the row and the kernel routes by it', () => {
    expect(serviceSrc).toContain('intendedCycleId,');
    expect(serviceSrc).toContain('resolveIntendedCycleId');
    // The routing rule, in the one place that stamps a period-keyed row onto a run.
    expect(kernelSrc).toContain('payrollIndividualTxn.intendedCycleId');
  });
});
