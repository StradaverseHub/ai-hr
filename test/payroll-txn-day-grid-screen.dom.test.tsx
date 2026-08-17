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
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
// c11e81aa — `variesByDay` comes off the item's own rule on the server (payRuleAllowsDayByDay).
// OT1_5 is per_hour: a day is worth its own hours, so day-by-day is offered.
const OT: TxnPayItem = {
  id: 'ot15',
  code: 'OT1_5',
  name: 'Overtime 1.5',
  kind: 'allowance',
  derives: true,
  inputUnit: 'hours',
  variesByDay: true,
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

/**
 * c11e81aa — a FIXED-AMOUNT pay item: one figure for the month, so it cannot be split across dates.
 * `variesByDay` is the server's answer (payRuleAllowsDayByDay over a `fixed` rule), not a UI guess —
 * note that it is indistinguishable from an item with NO rule by `derives`/`inputUnit` alone, which is
 * exactly why the screen is handed the third boolean rather than inferring it.
 */
const HANDPHONE: TxnPayItem = {
  id: 'hp',
  code: 'HANDPHONE',
  name: 'Handphone Allowance',
  kind: 'allowance',
  derives: false,
  inputUnit: null,
  variesByDay: false,
};

function renderWorkspace(
  panel: TxnPanel = EMPTY_PANEL,
  opts: { payItems?: TxnPayItem[]; batches?: TxnBatch[] } = {},
) {
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
  createMock.mockResolvedValue({ ok: true, id: 'n1' });
  detailMock.mockResolvedValue(null);
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TxnWorkspace
        employees={[EMPLOYEE]}
        batches={opts.batches ?? [BATCH]}
        companies={[COMPANY]}
        payItems={opts.payItems ?? [OT]}
        payrollCycles={[]}
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

/**
 * r191 — 009c8a37 (panel order) and e1e33ca0 (the payroll month leaves the panel), on the ONE screen that
 * does not render the shared `EmployeeScopePanel`.
 *
 * WHY THESE LIVE HERE AND NOT IN employee-scope-panel.dom.test.tsx. Individual Transaction draws its own
 * employee list over its own state — `EMPLOYEE_CAP` 50 against the shared panel's 25, a different row
 * subtitle, and selection held in client state behind `requestSelect`'s unsaved-form guard rather than a
 * `router.push`. The two were reordered to match BY HAND, so a test of the shared component proves nothing
 * about this one. This file already renders the whole workspace, which is what these need.
 *
 * WHAT e1e33ca0 IS AND IS NOT. It is a JSX MOVE. Requirement 6 of the request ("changing the month must not
 * make me pick the employee again") already held before this round and still holds — `periodFilter` is part
 * of `panelKey`, so changing it refires the fetch for the SAME `employmentId` and never touches
 * `selectedId`. The assertions below pin that it STAYED true across the move, which is the only thing a
 * move can break.
 */
describe('r191 · 009c8a37 + e1e33ca0 — the panel does one job, the toolbar does the other', () => {
  const PANEL: TxnPanel = {
    ...EMPTY_PANEL,
    rows: [panelRow({ id: 'r1', txnDate: '2026-08-01', quantity: '2.00', amount: '77.88' })],
    totals: { ...EMPTY_PANEL.totals, count: 1, total: '77.88', pendingCount: 1, pendingTotal: '77.88' },
  };

  it('009c8a37 — search first, the names next, the four narrowers behind a CLOSED More filters', async () => {
    const { container } = renderWorkspace(PANEL);
    const row = await screen.findByRole('button', { name: /Irwin Law/ });

    const fold = container.querySelector('details')!;
    expect(fold, 'the employee filters must sit behind a fold').not.toBeNull();
    expect(fold.open, 'closed on arrival — the reporter asked for closed every visit').toBe(false);
    expect(within(fold).getByText('More filters')).toBeInTheDocument();

    // Search employee is above the names; the fold is below them. DOM order is the only way to assert
    // that here — jsdom applies no CSS and computes no layout.
    const search = screen.getByLabelText('Search employee');
    expect(search.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    for (const caption of ['Company', 'Business unit', 'Department', 'Status']) {
      expect(within(fold).getByLabelText(caption), `${caption} belongs inside More filters`).toBeInTheDocument();
    }
    // …and the search box does NOT, because it is what the reorder exists to put first.
    expect(within(fold).queryByLabelText('Search employee')).toBeNull();
  });

  it('009c8a37 — this screen finally has a Reset, and it clears the search and the hidden filters', async () => {
    const user = userEvent.setup();
    const { container } = renderWorkspace(PANEL);
    await screen.findByRole('button', { name: /Irwin Law/ });
    const fold = container.querySelector('details')!;

    await user.type(screen.getByLabelText('Search employee'), 'nobody-by-that-name');
    await user.selectOptions(screen.getByLabelText('Status'), 'ended');
    expect(screen.getByText('No matching employees.')).toBeInTheDocument();
    // A filter narrowing from behind a closed fold has to say so, or a short list looks like a fault.
    expect(within(fold).getByText('1 on')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(await screen.findByRole('button', { name: /Irwin Law/ })).toBeInTheDocument();
    expect((screen.getByLabelText('Search employee') as HTMLInputElement).value).toBe('');
    expect(within(fold).queryByText('1 on')).toBeNull();
    // Company is a SINGLE-company tenant here. Reset restores the initialiser rather than blanking it —
    // the dropdown offers no blank option when there is one company, so a blank is unreachable state.
    expect(screen.getByLabelText('Company')).toHaveValue('c1');
  });

  it('009c8a37 — a lone pre-set Company on a one-company tenant is NOT counted as a filter', async () => {
    const { container } = renderWorkspace(PANEL);
    await screen.findByRole('button', { name: /Irwin Law/ });
    const fold = container.querySelector('details')!;
    expect(screen.getByLabelText('Company')).toHaveValue('c1');
    // A permanent "1 on" nobody can clear would teach the reader to ignore the badge entirely.
    expect(within(fold).queryByText(/\bon$/)).toBeNull();
  });

  it('e1e33ca0 — Payroll period sits beside Search transactions, and is NOT an employee filter', async () => {
    const { container } = renderWorkspace(PANEL);
    // The toolbar is part of the selected employee's transactions, so somebody has to be picked first.
    fireEvent.click(await screen.findByRole('button', { name: /Irwin Law/ }));

    const period = await screen.findByLabelText('Payroll period');
    const txnSearch = screen.getByLabelText('Search transactions');
    const clear = screen.getByRole('button', { name: 'Clear' });

    // Beside Search transactions, on the toolbar — the two controls that narrow the rows below, together.
    const toolbar = period.closest('div')!.parentElement!;
    expect(toolbar).toContainElement(txnSearch);
    expect(toolbar).toContainElement(clear);

    // NOT hidden inside More filters either: it was never an employee filter, so folding it in with them
    // would have re-made the exact mistake this item fixes.
    expect(period.closest('details')).toBeNull();
    expect(within(container.querySelector('details')!).queryByLabelText('Payroll period')).toBeNull();
    // It is below the employee list, not above it.
    const row = screen.getByRole('button', { name: /Irwin Law/ });
    expect(row.compareDocumentPosition(period) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The entry form's own month box is still "Month", so neither label is ambiguous.
    expect(screen.queryAllByLabelText('Payroll period')).toHaveLength(1);
  });

  it('e1e33ca0 — changing the month refetches the SAME employee, without re-selecting them', async () => {
    renderWorkspace(PANEL);
    const row = await screen.findByRole('button', { name: /Irwin Law/ });
    fireEvent.click(row);
    await waitFor(() => expect(panelMock).toHaveBeenCalled());
    panelMock.mockClear();

    fireEvent.change(await screen.findByLabelText('Payroll period'), { target: { value: '2026-07' } });

    await waitFor(() =>
      expect(panelMock).toHaveBeenCalledWith({ companyId: 'c1', employmentId: 'e1', payPeriod: '2026-07' }),
    );
    // THE POINT OF THE REQUIREMENT: the same employment, and the selection marker has not moved.
    expect(panelMock.mock.calls.every((c) => (c[0] as { employmentId: string }).employmentId === 'e1')).toBe(true);
    expect(screen.getByRole('button', { name: /Irwin Law/ })).toHaveAttribute('aria-current', 'true');
    // And the "Showing … only" note stays in the totals strip, where it already was.
    expect(await screen.findByText('Showing 2026-07 only')).toBeInTheDocument();
  });

  it('e1e33ca0 — Clear empties the month and the transaction search, and brings back every month', async () => {
    const user = userEvent.setup();
    renderWorkspace(PANEL);
    fireEvent.click(await screen.findByRole('button', { name: /Irwin Law/ }));
    await waitFor(() => expect(panelMock).toHaveBeenCalled());

    fireEvent.change(await screen.findByLabelText('Payroll period'), { target: { value: '2026-07' } });
    await user.type(screen.getByLabelText('Search transactions'), 'bonus');
    expect(await screen.findByText('Showing 2026-07 only')).toBeInTheDocument();
    panelMock.mockClear();

    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect((screen.getByLabelText('Payroll period') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Search transactions') as HTMLInputElement).value).toBe('');
    await waitFor(() =>
      expect(panelMock).toHaveBeenCalledWith({ companyId: 'c1', employmentId: 'e1', payPeriod: '' }),
    );
    expect(screen.queryByText('Showing 2026-07 only')).toBeNull();
    expect(screen.getByRole('button', { name: /Irwin Law/ })).toHaveAttribute('aria-current', 'true');
  });

  it('e1e33ca0 — Add still opens on the month set on the toolbar, so it is set once', async () => {
    const user = userEvent.setup();
    renderWorkspace(PANEL);
    fireEvent.click(await screen.findByRole('button', { name: /Irwin Law/ }));
    fireEvent.change(await screen.findByLabelText('Payroll period'), { target: { value: '2026-07' } });

    await user.click(await screen.findByRole('button', { name: '+ Add new transaction' }));
    // `startCreate` seeds the new entry from `periodFilter`. It reads the state, not the control's
    // position, which is exactly why the move had to keep the state in this component scope.
    expect(screen.getByLabelText('Month')).toHaveValue('2026-07');
  });
});

/**
 * c11e81aa — the listing says WHICH pay item, the entry surfaces open over it, the Pay cycle is a
 * control, and Day by day is not offered where it cannot work.
 *
 * These live here rather than in a new file for the reason the header above gives: every one of them is
 * client state that only exists after a click, so a dev-server log and a 200 cannot see any of it. The
 * three the approved plan singles out as the RISKS of this change are pinned first — the search predicate
 * silently narrowing, the FormState/DailyState invariant, and `resolvedBatchId` being turned into stored
 * state — because each is a regression that leaves the screen looking entirely correct.
 */
describe('c11e81aa · the listing identifies the pay item', () => {
  const NOTED: TxnPanel = {
    ...EMPTY_PANEL,
    rows: [
      panelRow({ id: 'r1', txnDate: '2026-08-01', quantity: '2.00', amount: '77.88', notes: 'Weekend callout' }),
    ],
    totals: { ...EMPTY_PANEL.totals, count: 1, total: '77.88', pendingCount: 1, pendingTotal: '77.88' },
  };

  it('prints the pay item CODE and its description — not the ledger kind and the typed note', async () => {
    const user = userEvent.setup();
    renderWorkspace(NOTED);
    await user.click(await screen.findByRole('button', { name: /Irwin Law/ }));

    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Description' })).toBeInTheDocument();
    expect(within(table).getByText('OT1_5')).toBeInTheDocument();
    expect(within(table).getByText('Overtime 1.5')).toBeInTheDocument();
    // "Earning" was the whole content of the Payroll item column before this change, on nearly every row.
    expect(within(table).queryByText('Earning')).toBeNull();
    // THE NOTE HAS LEFT THE LISTING. It is not deleted — the next case opens it.
    expect(within(table).queryByText('Weekend callout')).toBeNull();
  });

  it('View opens over the listing and is where the transaction’s own note now lives', async () => {
    const user = userEvent.setup();
    renderWorkspace(NOTED);
    await user.click(await screen.findByRole('button', { name: /Irwin Law/ }));
    await user.click(await screen.findByRole('button', { name: 'View' }));

    const prompt = screen.getByRole('dialog', { name: 'Transaction details' });
    expect(within(prompt).getByText('Weekend callout')).toBeInTheDocument();
    expect(within(prompt).getByText('OT1_5')).toBeInTheDocument();
    // OVER the listing, not instead of it — the reason for the change is that you keep your place.
    expect(screen.getByRole('table')).toBeInTheDocument();

    // Two ways out on purpose — the × in the header and the button at the foot. Click the button.
    const closes = within(prompt).getAllByRole('button', { name: 'Close' });
    await user.click(closes[closes.length - 1]);
    expect(screen.queryByRole('dialog', { name: 'Transaction details' })).toBeNull();
  });

  /**
   * RISK 1 OF 3 — the search predicate silently narrowing. Moving the note out of the listing invites
   * narrowing the match to what a column now shows, and the failure is invisible: the box still works,
   * it just stops finding rows by the remark somebody typed on them.
   */
  it('still finds a row by its REMARK, and now also by the pay item code and description', async () => {
    const user = userEvent.setup();
    renderWorkspace(NOTED);
    await user.click(await screen.findByRole('button', { name: /Irwin Law/ }));
    const box = await screen.findByLabelText('Search transactions');

    for (const term of ['callout', 'OT1_5', 'Overtime']) {
      await user.clear(box);
      await user.type(box, term);
      expect(await screen.findByText('1 row'), `searching "${term}"`).toBeInTheDocument();
    }
    await user.clear(box);
    await user.type(box, 'nothing-matches-this');
    expect(await screen.findByText('0 rows')).toBeInTheDocument();
  });
});

describe('c11e81aa · Add and Edit open in a prompt', () => {
  it('the entry form is a prompt over the listing, and the listing is still there behind it', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openAddForm(user);

    const prompt = screen.getByRole('dialog', { name: 'New transaction' });
    expect(within(prompt).getByLabelText('Month')).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  /**
   * RISK 2 OF 3 — the FormState/DailyState invariant. The two entry modes are a deliberate discriminated
   * union (4e403268) with at most one non-null, and putting them inside a prompt is exactly the change
   * that tempts somebody to fold them into one object with a mode flag. If that happened, both would be
   * on screen at once — which is what this asserts cannot be.
   */
  it('only ever shows ONE entry machine: switching to the grid closes the single-entry prompt', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openAddForm(user);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    await user.click(screen.getByRole('radio', { name: 'Day by day' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Add transactions day by day' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'New transaction' })).toBeNull();

    await user.click(screen.getByRole('radio', { name: 'One total for the month' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'New transaction' })).toBeInTheDocument();
  });

  /**
   * Dismissing the prompt is now the likelier way to lose unsaved work than switching employee — the
   * employee list is behind the backdrop while a form is open — so the unsaved-changes gate answers it.
   */
  it('asks before throwing away a half-typed entry when the prompt is dismissed', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openAddForm(user);
    await user.type(screen.getByLabelText('Amount'), '120');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();
    expect(screen.getByText('Do you want to save before closing?')).toBeInTheDocument();
    // The entry is still there behind the question — "Cancel" on the gate means "keep typing".
    expect(screen.getByRole('dialog', { name: 'New transaction' })).toBeInTheDocument();

    // The gate is rendered last, over the prompt it is asking about, so its Cancel is the last one.
    const cancels = screen.getAllByRole('button', { name: 'Cancel' });
    await user.click(cancels[cancels.length - 1]);
    expect(screen.queryByText('You have unsaved changes')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'New transaction' })).toBeInTheDocument();
  });
});

describe('c11e81aa · Pay cycle is a control, and the target run stays DERIVED', () => {
  const JULY: TxnBatch = { ...BATCH, id: 'b-jul', payPeriod: '2026-07', runType: 'regular', runSeq: 1 };
  const AUG_BONUS: TxnBatch = { ...BATCH, id: 'b-aug-bonus', payPeriod: '2026-08', runType: 'bonus', runSeq: 1 };

  it('is selectable when the month has exactly ONE run — 21 of 22 production months', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await openAddForm(user);

    // It used to be a paragraph here, with nothing to click, which is what made the field feel broken.
    const cycle = screen.getByLabelText('Pay cycle');
    expect(cycle.tagName).toBe('SELECT');
    expect(cycle).toHaveValue('b1');
    expect(within(cycle as HTMLSelectElement).getByRole('option', { name: 'Regular' })).toBeInTheDocument();
    // No blank option above one run: the derivation resolves '' straight back to the sole run, so an
    // option that cannot change the answer would be a second way of saying the same thing.
    expect(within(cycle as HTMLSelectElement).queryByRole('option', { name: '—' })).toBeNull();
  });

  /**
   * RISK 3 OF 3 — `resolvedBatchId` turned into stored state. It is DERIVED precisely so a pick cannot
   * outlive the month it was made in: a stored id is a second copy of what month + employee already
   * determine, and the window where they disagree is a window where a row is written against a run that
   * no longer covers the employee. Pick the bonus run in August, move to July, and the answer must be
   * July's own run — both on screen and in what the save posts.
   */
  it('a pick made in one month does not survive into another', async () => {
    const user = userEvent.setup();
    renderWorkspace(EMPTY_PANEL, { batches: [BATCH, AUG_BONUS, JULY] });
    await openAddForm(user);

    await user.selectOptions(screen.getByLabelText('Pay cycle'), 'b-aug-bonus');
    expect(screen.getByLabelText('Pay cycle')).toHaveValue('b-aug-bonus');

    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-07' } });
    expect(screen.getByLabelText('Pay cycle')).toHaveValue('b-jul');

    await user.type(screen.getByLabelText('Effective date'), '2026-07-10');
    await user.type(screen.getByLabelText('Amount'), '250');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createMock).toHaveBeenCalled());
    expect((createMock.mock.calls[0][0] as { batchId: string }).batchId).toBe('b-jul');
  });
});

describe('c11e81aa · Day by day is not offered for a fixed-amount pay item', () => {
  it('greys the option out and says why, instead of offering a choice that cannot work', async () => {
    const user = userEvent.setup();
    renderWorkspace(EMPTY_PANEL, { payItems: [OT, HANDPHONE] });
    await openAddForm(user);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Payroll item' }), 'c:hp');
    expect(screen.getByRole('radio', { name: 'Day by day' })).toBeDisabled();
    expect(screen.getByText(/cannot be split across dates/)).toBeInTheDocument();

    // …and an item whose rule reads hours is unaffected: a day is worth its own hours.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Payroll item' }), 'c:ot15');
    expect(screen.getByRole('radio', { name: 'Day by day' })).toBeEnabled();
    expect(screen.queryByText(/cannot be split across dates/)).toBeNull();
  });

  it('and it cannot be reached from inside the grid by changing the pay item', async () => {
    const user = userEvent.setup();
    renderWorkspace(EMPTY_PANEL, { payItems: [OT, HANDPHONE] });
    await openAddForm(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Payroll item' }), 'c:ot15');
    await user.click(screen.getByRole('radio', { name: 'Day by day' }));

    const picker = screen.getByRole('combobox', { name: 'Payroll item' });
    expect(within(picker).getByRole('option', { name: /HANDPHONE/ })).toBeDisabled();
    expect(within(picker).getByRole('option', { name: /OT1_5/ })).toBeEnabled();
  });
});
