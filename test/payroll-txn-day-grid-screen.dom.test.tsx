/**
 * The Individual Transaction workspace's DAY-BY-DAY grid, PROVED BY RENDERING (4e403268).
 *
 * WHY THIS EXISTS ALONGSIDE test/payroll-txn-day-by-day.test.ts. That file proves what the SERVICE does
 * with a set of dated rows. It cannot prove what a person actually sees, and everything this item adds is
 * client state rendered AFTER a server action returns: the mode switch, the per-line calculated figure,
 * the running totals, the grouped view. A dev-server log never sees any of it — a `t('…')` resolving to a
 * message with `{placeholders}` throws in the BROWSER, paints the raw key path on screen, and leaves the
 * route returning 200 with tsc, the suite and `next build` all green. r185 hit exactly that and answered
 * it with a DOM test; this is the same answer.
 *
 * WHAT IS ASSERTED:
 *   · the Input Method selector exists on a new entry, defaults to One total for the month, and is NOT
 *     offered on an edit (an existing row IS one day);
 *   · choosing Day by day replaces the single date + quantity with a dated grid, and Add date grows it;
 *   · the pay item is picked ONCE for the whole grid — which is the friction the request is about;
 *   · each line shows the figure the SERVER worked out for its own quantity, and the totals add up;
 *   · the batched preview is ONE call carrying the DISTINCT quantities, not one call per row;
 *   · the grouped listing shows one line per month + pay item with the summed hours and money, and
 *     opening it shows the days with their Source.
 *
 * Scope note, inherited from the other dom tests: jsdom applies no CSS and computes no layout, so this
 * catches rendering and interaction logic, not a visual regression. It does not replace reading a
 * dev-server log, and it is not run against the other five locales — test/i18n-coverage.test.ts covers
 * those structurally and scripts/i18n-check.mjs pins parity.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { TxnWorkspace, type TxnBatch, type TxnCompany, type TxnEmployee, type TxnPayItem } from '../app/payroll/transactions/individual/txn-workspace';
import type { TxnPanel } from '../app/payroll/transactions/individual/existing-context';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// ── The server actions, stubbed. The RATE is the one from production: Irwin Law's basic 5000 plus his
// live fixed allowance 400, / 26 / 8 * 1.5 = 38.942307… an hour. Each figure is rounded to the cent on
// its own, exactly as the real action does with `toFixed(2)`, so the totals below are the real ones. ──
const HOURLY = ((5000 + 400) / 26 / 8) * 1.5;
const panelMock = vi.fn();
const previewOneMock = vi.fn();
const previewManyMock = vi.fn();
const dayGridMock = vi.fn();
const createMock = vi.fn();
const detailMock = vi.fn();

vi.mock('../app/payroll/transactions/individual/actions', () => ({
  fetchEmployeeTxnPanelAction: (...a: unknown[]) => panelMock(...a),
  fetchBatchImpactAction: () => Promise.resolve(null),
  fetchTxnDetailAction: (...a: unknown[]) => detailMock(...a),
  previewTxnAmountAction: (...a: unknown[]) => previewOneMock(...a),
  previewTxnAmountsAction: (...a: unknown[]) => previewManyMock(...a),
  createIndividualTxnAction: (...a: unknown[]) => createMock(...a),
  createIndividualTxnDayGridAction: (...a: unknown[]) => dayGridMock(...a),
  updateIndividualTxnAction: () => Promise.resolve({ ok: true }),
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
const BATCH: TxnBatch = {
  id: 'b1',
  companyId: 'c1',
  payPeriod: '2026-08',
  runType: 'regular',
  runSeq: 1,
  scope: null,
  status: 'draft',
  needsRecalcAt: null,
  recalcEmploymentIds: null,
};
const COMPANY: TxnCompany = { id: 'c1', name: 'Demo Group Holdings Bhd', currency: 'MYR' };
const OT: TxnPayItem = { id: 'ot15', code: 'OT1_5', name: 'Overtime 1.5', kind: 'allowance', derives: true, inputUnit: 'hours' };

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

function renderWorkspace(panel: TxnPanel = EMPTY_PANEL) {
  panelMock.mockResolvedValue(panel);
  previewOneMock.mockResolvedValue({ ok: true, derived: false });
  previewManyMock.mockImplementation((input: { quantities: string[] }) =>
    Promise.resolve({
      ok: true,
      derived: true,
      amounts: input.quantities.map((q) => ({ quantity: q, amount: (HOURLY * Number(q)).toFixed(2) })),
      code: 'OT1_5',
      inputUnit: 'hours',
      zeroDivisor: null,
    }),
  );
  dayGridMock.mockResolvedValue({ ok: true, id: 'n1', count: 5 });
  detailMock.mockResolvedValue(null);
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TxnWorkspace
        employees={[EMPLOYEE]}
        batches={[BATCH]}
        companies={[COMPANY]}
        payItems={[OT]}
        processHref="/payroll"
        requireComponent={false}
        currentPeriod="2026-08"
        panelDefaultOpen
        panelCookieKey="k"
      />
    </NextIntlClientProvider>,
  );
}

/** Pick the employee and open the Add form — the state every test below starts from. */
async function openAddForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Irwin Law/ }));
  await user.click(await screen.findByRole('button', { name: '+ Add new transaction' }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('4e403268 · the Input Method selector', () => {
  it('offers both methods on a new entry, with One total for the month chosen', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openAddForm(user);

    const lump = screen.getByRole('radio', { name: 'One total for the month' });
    const daily = screen.getByRole('radio', { name: 'Day by day' });
    expect(lump).toBeChecked();
    expect(daily).not.toBeChecked();
    // The single-entry form is the screen exactly as it was — one date box, one quantity box.
    expect(screen.getByLabelText('Effective date')).toBeInTheDocument();
  });

  it('switching to Day by day replaces the single entry with a dated grid', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openAddForm(user);
    await user.click(screen.getByRole('radio', { name: 'Day by day' }));

    expect(screen.getByRole('radio', { name: 'Day by day' })).toBeChecked();
    expect(screen.getByRole('heading', { name: 'Add transactions day by day' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add date' })).toBeInTheDocument();
    // ONE pay item control for the whole grid. That is the friction the request names: today five days
    // means opening the form five times and re-picking the pay item each time.
    expect(screen.getAllByRole('combobox', { name: 'Payroll item' })).toHaveLength(1);
  });

  it('switches back, carrying the month and the pay item — not making the operator re-pick', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openAddForm(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Payroll item' }), 'c:ot15');
    await user.click(screen.getByRole('radio', { name: 'Day by day' }));
    expect(screen.getByRole('combobox', { name: 'Payroll item' })).toHaveValue('c:ot15');
    await user.click(screen.getByRole('radio', { name: 'One total for the month' }));
    expect(screen.getByRole('combobox', { name: 'Payroll item' })).toHaveValue('c:ot15');
    expect(screen.getByLabelText('Effective date')).toBeInTheDocument();
  });
});

describe('4e403268 · the dated grid', () => {
  it('adds and removes dates', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openAddForm(user);
    await user.click(screen.getByRole('radio', { name: 'Day by day' }));

    expect(screen.getAllByLabelText('Effective date')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Add date' }));
    await user.click(screen.getByRole('button', { name: 'Add date' }));
    expect(screen.getAllByLabelText('Effective date')).toHaveLength(3);

    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    expect(screen.getAllByLabelText('Effective date')).toHaveLength(2);
  });

  it('never lets the grid become empty — the last line cannot be deleted', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openAddForm(user);
    await user.click(screen.getByRole('radio', { name: 'Day by day' }));
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  /**
   * THE PER-LINE FIGURE, AND WHERE IT COMES FROM. The browser does no arithmetic: each line shows what
   * the SERVER worked out for that line's quantity, through the same evaluator the payslip uses. The
   * mock here is deliberately a real multiply-and-round so the numbers below are the production ones.
   */
  it('shows the server’s figure for each date, and totals them', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openAddForm(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Payroll item' }), 'c:ot15');
    await user.click(screen.getByRole('radio', { name: 'Day by day' }));
    await user.click(screen.getByRole('button', { name: 'Add date' }));

    const dates = screen.getAllByLabelText('Effective date');
    const hours = screen.getAllByLabelText('Hours');
    await user.type(dates[0], '2026-08-01');
    await user.type(hours[0], '2');
    await user.type(dates[1], '2026-08-05');
    await user.type(hours[1], '3');

    const amounts = await screen.findAllByLabelText('Calculated amount');
    expect(amounts[0]).toHaveValue((HOURLY * 2).toFixed(2));
    expect(amounts[1]).toHaveValue((HOURLY * 3).toFixed(2));

    // The day-of-week column, derived for display and never stored. 1 Aug 2026 is a Saturday.
    expect(screen.getByText('Sat')).toBeInTheDocument();
    expect(screen.getByText('Wed')).toBeInTheDocument();

    // Running totals: 5.00 hours, and the two rounded figures added.
    const expectedTotal = (Number((HOURLY * 2).toFixed(2)) + Number((HOURLY * 3).toFixed(2))).toFixed(2);
    expect(screen.getByText('Total — 2 dates')).toBeInTheDocument();
    expect(screen.getByText('5.00')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(expectedTotal.replace('.', '\\.')))).toBeInTheDocument();
  });

  /**
   * ONE REQUEST, CARRYING THE DISTINCT QUANTITIES. Fanning out one action per row would put a request in
   * flight per row per keystroke, each opening its own transaction to resolve the same employee's same
   * month, with the answers landing in an order nobody controls.
   */
  it('asks the server ONCE per distinct quantity, not once per row', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openAddForm(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Payroll item' }), 'c:ot15');
    await user.click(screen.getByRole('radio', { name: 'Day by day' }));
    await user.click(screen.getByRole('button', { name: 'Add date' }));
    await user.click(screen.getByRole('button', { name: 'Add date' }));

    const hours = screen.getAllByLabelText('Hours');
    await user.type(hours[0], '2');
    await user.type(hours[1], '2');
    await user.type(hours[2], '3');
    await screen.findAllByLabelText('Calculated amount');

    // Whatever the keystroke-by-keystroke history, the LAST call is the settled state — and it carries
    // two quantities for three rows, because two of the rows ask the same question.
    const last = previewManyMock.mock.calls.at(-1)?.[0] as { quantities: string[] };
    expect(last.quantities).toEqual(['2', '3']);
  });

  it('posts every line in ONE action — all of them or none', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openAddForm(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Payroll item' }), 'c:ot15');
    await user.click(screen.getByRole('radio', { name: 'Day by day' }));
    await user.click(screen.getByRole('button', { name: 'Add date' }));

    const dates = screen.getAllByLabelText('Effective date');
    const hours = screen.getAllByLabelText('Hours');
    await user.type(dates[0], '2026-08-01');
    await user.type(hours[0], '2');
    await user.type(dates[1], '2026-08-05');
    await user.type(hours[1], '3');
    await screen.findAllByLabelText('Calculated amount');

    await user.click(screen.getByRole('button', { name: 'Save all dates' }));
    expect(dayGridMock).toHaveBeenCalledTimes(1);
    const posted = dayGridMock.mock.calls[0][0] as {
      lines: { txnDate: string; quantity: number; amount: number }[];
      componentId: string;
      unit: string;
    };
    expect(posted.lines).toHaveLength(2);
    expect(posted.componentId).toBe('ot15');
    expect(posted.unit).toBe('hours');
    expect(posted.lines.map((l) => l.txnDate)).toEqual(['2026-08-01', '2026-08-05']);
    expect(posted.lines[0].amount).toBeCloseTo(Number((HOURLY * 2).toFixed(2)), 2);
  });

  it('refuses to save a line with no date, and names THAT line', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openAddForm(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Payroll item' }), 'c:ot15');
    await user.click(screen.getByRole('radio', { name: 'Day by day' }));
    await user.type(screen.getByLabelText('Hours'), '2');
    await screen.findByLabelText('Calculated amount');

    await user.click(screen.getByRole('button', { name: 'Save all dates' }));
    expect(dayGridMock).not.toHaveBeenCalled();
    // The message appears twice on purpose: once against the offending row, once at the foot of the form.
    expect(screen.getAllByText(/fix the highlighted rows/).length).toBeGreaterThan(0);
  });

  it('says the rounding out loud rather than letting a cent surprise anyone', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openAddForm(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Payroll item' }), 'c:ot15');
    await user.click(screen.getByRole('radio', { name: 'Day by day' }));
    expect(screen.getByText(/rounded to the cent on its own/)).toBeInTheDocument();
  });
});

// ─────────────────────────────── the grouped listing ───────────────────────────────

const panelRow = (p: Partial<Record<string, unknown>> & { id: string }) =>
  ({
    employmentId: 'e1',
    payPeriod: '2026-08',
    txnDate: '2026-08-01',
    kind: 'earning',
    amount: '77.88',
    quantity: '2.00',
    unit: 'hours',
    notes: 'Overtime 1.5',
    componentId: 'ot15',
    componentCode: 'OT1_5',
    componentName: 'Overtime 1.5',
    source: 'manual',
    runType: 'regular',
    runSeq: 1,
    batchStatus: 'draft',
    createdOn: '2026-08-01',
    createdBy: 'Admin',
    changedAt: '2026-08-01T00:00:00.000000',
    payslipCalculatedAt: null,
    batchNeedsRecalcForEmployment: false,
    status: 'pending',
    editable: true,
    attached: true,
    recalcOnEdit: false,
    ...p,
  }) as never;

describe('4e403268 · the grouped listing', () => {
  const PANEL: TxnPanel = {
    ...EMPTY_PANEL,
    rows: [
      panelRow({ id: 'r1', txnDate: '2026-08-01', quantity: '2.00', amount: '77.88' }),
      panelRow({ id: 'r2', txnDate: '2026-08-05', quantity: '3.00', amount: '116.83' }),
      panelRow({ id: 'r3', txnDate: '2026-08-12', quantity: '2.50', amount: '97.36' }),
    ],
    totals: { ...EMPTY_PANEL.totals, count: 3, total: '292.07', pendingCount: 3, pendingTotal: '292.07' },
  };

  it('rolls three days into one line with the summed hours and money', async () => {
    const user = userEvent.setup();
    renderWorkspace(PANEL);
    await user.click(await screen.findByRole('button', { name: /Irwin Law/ }));
    await user.click(await screen.findByRole('button', { name: 'Grouped' }));

    expect(screen.getByText('1 group')).toBeInTheDocument();
    const table = screen.getAllByRole('table')[0];
    expect(within(table).getByText('OT1_5')).toBeInTheDocument();
    expect(within(table).getByText('7.5 Hours')).toBeInTheDocument();
    expect(within(table).getByText('MYR 292.07')).toBeInTheDocument();
  });

  it('opens to the days behind the figure, with their Source — the request’s audit trail', async () => {
    const user = userEvent.setup();
    renderWorkspace(PANEL);
    await user.click(await screen.findByRole('button', { name: /Irwin Law/ }));
    await user.click(await screen.findByRole('button', { name: 'Grouped' }));
    await user.click(screen.getByRole('button', { name: 'Show the dates behind this total' }));

    expect(screen.getByText('2026-08-01')).toBeInTheDocument();
    expect(screen.getByText('2026-08-05')).toBeInTheDocument();
    expect(screen.getByText('2026-08-12')).toBeInTheDocument();
    // Every row is Manual today; the column exists so Attendance and Leave can fill it in later.
    expect(screen.getAllByText('Manual')).toHaveLength(3);
  });

  /**
   * NO MODE SWITCH ON AN EDIT, and this is a design decision rather than an omission. An existing row IS
   * one day. Opening it as a five-line grid would be a grid that can delete rows the operator never
   * opened, and folding five days back into one box has no honest answer.
   */
  it('does NOT offer the Input Method selector when editing an existing row', async () => {
    const user = userEvent.setup();
    renderWorkspace(PANEL);
    detailMock.mockResolvedValue({
      id: 'r1',
      employmentId: 'e1',
      companyId: 'c1',
      payPeriod: '2026-08',
      batchId: 'b1',
      kind: 'earning',
      componentId: 'ot15',
      txnDate: '2026-08-01',
      amount: '77.88',
      quantity: '2.00',
      unit: 'hours',
      notes: 'Overtime 1.5',
      editable: true,
      recalcOnEdit: false,
    });
    await user.click(await screen.findByRole('button', { name: /Irwin Law/ }));
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]);

    expect(await screen.findByRole('heading', { name: 'Edit transaction' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Day by day' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'One total for the month' })).not.toBeInTheDocument();
  });

  it('still offers the flat, editable list — grouped is a view, not a replacement', async () => {
    const user = userEvent.setup();
    renderWorkspace(PANEL);
    await user.click(await screen.findByRole('button', { name: /Irwin Law/ }));
    expect(await screen.findByText('3 rows')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Grouped' }));
    expect(screen.queryAllByRole('button', { name: 'Edit' })).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'By transaction' }));
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(3);
  });
});
