/**
 * r256 (4b909202 rev 2) — THE ONE CONFIRMATION, PROVED BY RENDERING.
 *
 * WHY A DOM TEST AND NOT ONLY A SERVICE TEST. The whole of this round is a change of PRESENTATION: the
 * service's decision is r255's, and what the reporter rejected was the two steps they had to take to
 * reach it — a message that read like a refusal, then a separate "Add {employee} to this run" button.
 * "One question with two answers" is a claim about what a person sees and can only be proved by looking.
 * A message resolving with `{placeholders}` throws in the BROWSER, paints the raw key on screen, and
 * leaves the route returning 200 with tsc, the suite and `next build` all green (the repo's rule 6).
 *
 * WHAT IS ASSERTED:
 *   · a save the run's scope refuses raises ONE prompt with Continue and Cancel — and no separate
 *     "Add … to this run" control anywhere on the screen;
 *   · the prompt says what is true: who, which run, why it excludes them, and — on a processed run —
 *     that Continue also marks a reprocessing;
 *   · Cancel calls the server again ZERO times and leaves the entry exactly as it was;
 *   · Continue re-submits the SAME save with `confirmAddToRun`, and nothing else about it changes;
 *   · a refusal the operator cannot resolve (the leaver: the action withholds `confirmAddToRun`) is
 *     shown as text with NO Continue — the r255 guard, under the new presentation;
 *   · a confirmed save refused for another reason takes the prompt down and shows the reason, rather
 *     than answering through a dialog still asking the question.
 *
 *   · and the whole prompt renders against the REAL catalogue of each of the six locales — the last
 *     block below — because a message that will not compile in ms or th shows up nowhere else.
 *
 * jsdom applies no CSS and computes no layout, so this catches rendering and interaction logic, not a
 * visual regression.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';
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
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn() } }));

const panelMock = vi.fn();
const createMock = vi.fn();
const dayGridMock = vi.fn();

vi.mock('../app/payroll/transactions/individual/actions', () => ({
  fetchEmployeeTxnPanelAction: (...a: unknown[]) => panelMock(...a),
  fetchBatchImpactAction: () => Promise.resolve(null),
  fetchTxnDetailAction: () => Promise.resolve(null),
  previewTxnAmountAction: () => Promise.resolve({ ok: true, derived: false }),
  previewTxnAmountsAction: (input: { quantities: string[] }) =>
    Promise.resolve({
      ok: true,
      derived: true,
      amounts: input.quantities.map((q) => ({ quantity: q, amount: (100 * Number(q)).toFixed(2) })),
      code: 'OT1_5',
      inputUnit: 'hours',
      zeroDivisor: null,
    }),
  createIndividualTxnAction: (...a: unknown[]) => createMock(...a),
  createIndividualTxnDayGridAction: (...a: unknown[]) => dayGridMock(...a),
  updateIndividualTxnAction: () => Promise.resolve({ ok: true }),
  deleteIndividualTxnAction: () => Promise.resolve({ ok: true }),
}));

const EMPLOYEE: TxnEmployee = {
  employmentId: 'e1',
  name: 'Kim Chi',
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
/** A PROCESSED run — the reporter's own situation, and the one where Continue also marks a reprocess. */
const BATCH: TxnBatch = {
  id: 'b1',
  companyId: 'c1',
  payPeriod: '2026-01',
  runType: 'regular',
  runSeq: 1,
  scope: null,
  status: 'processed',
  needsRecalcAt: null,
  recalcEmploymentIds: null,
  payrollCycleId: null,
};
const COMPANY: TxnCompany = { id: 'c1', name: 'Demo Group Holdings Bhd', currency: 'MYR' };
/** per_hour, so a day is worth its own hours — which is what makes Day by day offerable at all. */
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

/** The refusal the SERVICE produces for a widenable employee, exactly as `txnFailure` shapes it. */
const REFUSAL_WITH_CONFIRM = {
  ok: false as const,
  error: 'employeeNotInScope',
  errorValues: { employee: 'Kim Chi', period: '2026-01', scope: 'departments', canAdd: 'yes' },
  confirmAddToRun: {
    batchId: 'b1',
    employmentId: 'e1',
    employee: 'Kim Chi',
    period: '2026-01',
    scope: 'departments',
    processed: true,
  },
};

/** And the refusal for somebody widening cannot help — no `confirmAddToRun`, so no Continue. */
const REFUSAL_NO_WAY_FORWARD = {
  ok: false as const,
  error: 'employeeNotInScope',
  errorValues: { employee: 'Kim Chi', period: '2026-01', scope: 'departments', canAdd: 'no' },
};

function renderWorkspace(locale = 'en', msgs: unknown = messages, payItems: TxnPayItem[] = []) {
  panelMock.mockResolvedValue(EMPTY_PANEL);
  return render(
    <NextIntlClientProvider locale={locale} messages={msgs as never}>
      <TxnWorkspace
        employees={[EMPLOYEE]}
        batches={[BATCH]}
        companies={[COMPANY]}
        payItems={payItems}
        payrollCycles={[]}
        processHref="/payroll"
        requireComponent={false}
        currentPeriod="2026-01"
        panelDefaultOpen
        panelCookieKey="k"
      />
    </NextIntlClientProvider>,
  );
}

/** Pick the employee, open Add, key the reporter's own example (a bonus) and press Save. */
async function keyAndSave(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Kim Chi/ }));
  await user.click(await screen.findByRole('button', { name: '+ Add new transaction' }));
  await user.type(screen.getByLabelText('Effective date'), '2026-01-15');
  await user.type(screen.getByLabelText('Amount'), '500');
  await user.click(screen.getByRole('button', { name: 'Save' }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('r256 · one confirmation, two answers', () => {
  it('asks ONE question with Continue and Cancel — and offers no separate "Add to this run" button', async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValue(REFUSAL_WITH_CONFIRM);
    renderWorkspace();
    await keyAndSave(user);

    // The question, naming the person and the run — the reporter's complaint was a message that named
    // nothing followed by a control they had to find.
    expect(await screen.findByText('Add Kim Chi to the 2026-01 payroll run?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    // Two answers, and only two.
    expect(screen.getAllByRole('button', { name: 'Cancel' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Add Kim Chi to this run/ })).not.toBeInTheDocument();

    // WHY the run excludes them, and WHAT Continue will do — including the reprocessing, which is the
    // half a prompt could quietly leave unsaid and the half that commits the operator to more work.
    expect(screen.getByText(/that run was set up for selected departments only/)).toBeInTheDocument();
    expect(screen.getByText(/marks them for reprocessing/)).toBeInTheDocument();
    expect(screen.getByText(/Cancel saves nothing/)).toBeInTheDocument();
  });

  it('CANCEL writes nothing — no second call to the server, and the entry is still there', async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValue(REFUSAL_WITH_CONFIRM);
    renderWorkspace();
    await keyAndSave(user);
    await screen.findByRole('button', { name: 'Continue' });
    expect(createMock).toHaveBeenCalledTimes(1);

    // The prompt's own Cancel is the LAST one rendered (it sits over the entry prompt, whose Cancel is
    // still in the tree behind it).
    const cancels = screen.getAllByRole('button', { name: 'Cancel' });
    await user.click(cancels[cancels.length - 1]);

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument());
    // Nothing else was sent. Cancel is not "save without widening" and is not "widen without saving".
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
    // And the operator is back on the entry they keyed, with their figure intact, free to change the run.
    expect(screen.getByLabelText('Amount')).toHaveValue(500);
  });

  it('CONTINUE re-submits the SAME save, confirmed — not a different write', async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValueOnce(REFUSAL_WITH_CONFIRM).mockResolvedValueOnce({
      ok: true,
      id: 'n1',
      recalcBatchId: 'b1',
      addedToRun: true,
    });
    renderWorkspace();
    await keyAndSave(user);
    await user.click(await screen.findByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(2));
    const first = createMock.mock.calls[0][0] as Record<string, unknown>;
    const second = createMock.mock.calls[1][0] as Record<string, unknown>;
    // The ONLY difference is the confirmation. The employee, the run, the date and the money are the
    // ones the operator was looking at when they answered — a Continue that rebuilt the entry could save
    // something they never saw.
    expect(second.confirmAddToRun).toBe(true);
    expect(first.confirmAddToRun).toBeUndefined();
    expect({ ...second, confirmAddToRun: undefined }).toEqual({ ...first, confirmAddToRun: undefined });
    expect(second.batchId).toBe('b1');
    expect(second.amount).toBe(500);

    // And the operator is told all three things that happened, not the bare "Transaction added" of a
    // save that widened nothing.
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        'Kim Chi has been added to the 2026-01 payroll run, the transaction has been saved, and they are marked for reprocessing.',
      ),
    );
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
  });

  /**
   * r255's guard, under r256's presentation, and the one the plan singles out. A leaver cannot be added
   * to a run whose month does not cover them — adding them marks a recalculation no screen can ever
   * perform — so the SERVICE withholds `confirmAddToRun` and the screen must state the reason rather
   * than offer a Continue that could not work.
   */
  it('offers NO Continue when adding cannot help — it states the reason instead', async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValue(REFUSAL_NO_WAY_FORWARD);
    renderWorkspace();
    await keyAndSave(user);

    await waitFor(() => expect(screen.getByText(/is not one of the people covered by/)).toBeInTheDocument());
    expect(screen.getByText(/was not employed during that pay period/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    expect(screen.queryByText('Add Kim Chi to the 2026-01 payroll run?')).not.toBeInTheDocument();
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  /**
   * THE DAY GRID ASKS THE SAME QUESTION AND ANSWERS IT THE SAME WAY.
   *
   * It is a second write path on the same screen, and the r255 shape had exactly one bug of this class:
   * a control wired for the single entry and forgotten for the grid reads as working right up until an
   * operator keys five days for somebody the run does not cover. Nothing but a render catches it —
   * `confirmAddToRun` is optional on both actions, so a missing spread is tsc-clean.
   */
  it('the day grid raises the same prompt, and Continue re-submits the whole grid confirmed', async () => {
    const user = userEvent.setup();
    dayGridMock.mockResolvedValueOnce(REFUSAL_WITH_CONFIRM).mockResolvedValueOnce({
      ok: true,
      id: 'n1',
      count: 1,
      recalcBatchId: 'b1',
      addedToRun: true,
    });
    renderWorkspace('en', messages, [OT]);
    await user.click(await screen.findByRole('button', { name: /Kim Chi/ }));
    await user.click(await screen.findByRole('button', { name: '+ Add new transaction' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Payroll item' }), 'c:ot15');
    await user.click(screen.getByRole('radio', { name: 'Day by day' }));
    await user.type(screen.getByLabelText('Effective date'), '2026-01-15');
    await user.type(screen.getByLabelText('Hours'), '2');
    await user.click(screen.getByRole('button', { name: 'Save all dates' }));

    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(dayGridMock).toHaveBeenCalledTimes(2));
    const first = dayGridMock.mock.calls[0][0] as Record<string, unknown>;
    const second = dayGridMock.mock.calls[1][0] as Record<string, unknown>;
    expect(first.confirmAddToRun).toBeUndefined();
    expect(second.confirmAddToRun).toBe(true);
    // The same grid, not a rebuilt one.
    expect(second.lines).toEqual(first.lines);
  });

  /**
   * A CONFIRMED save can still be refused — the employment was terminated between the prompt and the
   * answer, or this operator lacks the authority a processed run demands. The prompt has to come down
   * before the reason is shown, or the operator reads an answer through a dialog still asking them.
   */
  it('takes the prompt down and shows the reason when a confirmed save is refused anyway', async () => {
    const user = userEvent.setup();
    createMock
      .mockResolvedValueOnce(REFUSAL_WITH_CONFIRM)
      .mockResolvedValueOnce({ ok: false, error: 'addToRunNotEmployed' });
    renderWorkspace();
    await keyAndSave(user);
    await user.click(await screen.findByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument());
    expect(screen.getByText(/was not employed during that pay period/)).toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
    // Two calls and no more: a refused Continue does not retry itself.
    expect(createMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * AND THE SAME PROMPT IN ALL SIX LOCALES, RENDERED.
 *
 * scripts/i18n-check.mjs proves the six catalogues carry the same keys with the same placeholders, and
 * the locale cases in test/payroll-txn-scope-confirm-r256.test.ts prove the ICU selects have all their
 * branches. Neither can prove that next-intl actually COMPILES these messages: a malformed select or a
 * stray brace in one locale paints the key path (`MISSING_MESSAGE`) or an un-substituted `{employee}`,
 * in the browser only, with tsc, the suite, `next build` and a dev-server log all clean. The prompt is
 * pure client state raised by a failed server action, so no URL a render check can request will ever
 * show it. This drives it, in each locale, against that locale's real catalogue.
 */
describe.each([
  ['en', messages],
  ['ms', ms],
  ['ta', ta],
  ['th', th],
  ['vi', vi_],
  ['zh', zh],
] as const)('r256 · %s — the prompt resolves against the real catalogue', (loc, m) => {
  const ind = (m as unknown as { payroll: { transactions: { individual: Record<string, string> } } }).payroll
    .transactions.individual;

  it('asks the question, gives the grounds and names both answers', async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValue(REFUSAL_WITH_CONFIRM);
    renderWorkspace(loc, m);

    await user.click(await screen.findByRole('button', { name: /Kim Chi/ }));
    await user.click(await screen.findByRole('button', { name: ind.addTxn }));
    await user.type(screen.getByLabelText(ind.colEffectiveDate), '2026-01-15');
    await user.type(screen.getByLabelText(ind.amount), '500');
    await user.click(screen.getByRole('button', { name: ind.save }));

    // The entry form is itself a dialog and is still in the tree behind this one; the confirmation is
    // rendered LAST, over it, which is what makes "the last dialog" the right one to read.
    const dialogs = await screen.findAllByRole('dialog');
    const dialog = dialogs[dialogs.length - 1];
    const txt = dialog.textContent ?? '';
    // next-intl paints the KEY PATH when a message will not compile and leaves `{placeholder}`
    // un-substituted when an argument does not arrive. Both return 200 and pass every other gate.
    expect(txt, `${loc}: unresolved ICU placeholder`).not.toMatch(/\{[a-zA-Z]/);
    expect(txt, `${loc}: a raw key path, i.e. MISSING_MESSAGE`).not.toMatch(/payroll\.transactions/);
    // The facts crossed as DATA and were interpolated by this locale's own sentence.
    expect(txt, `${loc}: the question does not name the employee`).toContain('Kim Chi');
    expect(txt, `${loc}: the question does not name the run`).toContain('2026-01');
    // Two answers, both labelled in this locale.
    expect(within(dialog).getByRole('button', { name: ind.scopeConfirmContinue })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: ind.cancel })).toBeInTheDocument();
  });
});
