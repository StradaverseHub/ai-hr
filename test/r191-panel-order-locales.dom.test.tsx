/**
 * r191 — 009c8a37 + e1e33ca0 rendered in ALL SIX locales, because a dev-server log cannot reach the
 * surfaces these two items add.
 *
 * WHY THIS FILE EXISTS. The render check loaded all seven screens that mount the employee panel, in all
 * six locales, and the dev log came back clean. That proves the SERVER-rendered pass. It cannot prove the
 * two new surfaces on Individual Transaction, because both of them only exist AFTER a click:
 *
 *   · the transaction toolbar (`Payroll period`, `Search transactions`, `Clear`) renders only once an
 *     employee is selected, and selection on that screen is CLIENT state, not a query param — so no URL
 *     a curl can request will ever render it;
 *   · the More-filters count renders only once one of the folded filters is set.
 *
 * A missing key in one of those paints `MISSING_MESSAGE` in the browser, returns 200, and passes tsc,
 * the suite and `next build`. `scripts/i18n-check.mjs` and i18n-coverage's check A prove the six
 * catalogues have the same keys with the same placeholders; this proves the components actually resolve
 * them, against the REAL catalogue for each locale.
 *
 * Scope note, inherited from the other dom tests: jsdom applies no CSS and computes no layout. "Closed"
 * is asserted as `details.open === false`, which is the state the browser's own fold reads — but how it
 * LOOKS is not in scope here.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import { EmployeeScopePanel, type ScopeEmployee } from '../components/collapsible-employee-panel';
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
vi.mock('../app/payroll/transactions/individual/actions', () => ({
  fetchEmployeeTxnPanelAction: (...a: unknown[]) => panelMock(...a),
  fetchBatchImpactAction: () => Promise.resolve(null),
  fetchTxnDetailAction: () => Promise.resolve(null),
  previewTxnAmountAction: () => Promise.resolve({ ok: true, derived: false }),
  previewTxnAmountsAction: () => Promise.resolve({ ok: true, derived: false, amounts: [] }),
  createIndividualTxnAction: () => Promise.resolve({ ok: true }),
  createIndividualTxnDayGridAction: () => Promise.resolve({ ok: true }),
  updateIndividualTxnAction: () => Promise.resolve({ ok: true }),
  deleteIndividualTxnAction: () => Promise.resolve({ ok: true }),
}));

const LOCALES = [
  ['en', en],
  ['ms', ms],
  ['ta', ta],
  ['th', th],
  ['vi', vi_],
  ['zh', zh],
] as const;

const PEOPLE: ScopeEmployee[] = [
  {
    employmentId: 'e1',
    name: 'Aisha Rahman',
    employeeCode: 'EMP-001',
    company: 'Acme Sdn Bhd',
    companyId: 'co-a',
    department: 'Finance',
    departmentId: 'dept-fin',
    businessUnit: 'HQ',
    businessUnitId: 'bu-hq',
    status: 'active',
  },
  {
    employmentId: 'e2',
    name: 'Bala Krishnan',
    employeeCode: 'EMP-002',
    company: 'Beta Sdn Bhd',
    companyId: 'co-b',
    department: 'Operations',
    departmentId: 'dept-ops',
    businessUnit: 'Plant',
    businessUnitId: 'bu-plant',
    status: 'ended',
  },
];

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
  payrollCycleId: null,
};
const COMPANY: TxnCompany = { id: 'c1', name: 'Demo Group Holdings Bhd', currency: 'MYR' };
const OT: TxnPayItem = {
  id: 'ot15',
  code: 'OT1_5',
  name: 'Overtime 1.5',
  kind: 'allowance',
  derives: true,
  inputUnit: 'hours',
  // c11e81aa — per_hour, so a day can be worth something different from the day beside it.
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

const wrap = (locale: string, messages: unknown, ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale={locale} messages={messages as never}>
      {ui}
    </NextIntlClientProvider>,
  );

/**
 * What a caption must NOT look like. next-intl paints the KEY PATH when a message is missing and leaves
 * `{placeholder}` un-substituted when the argument does not arrive — both of which return 200 and pass
 * every other gate this repo runs.
 */
const resolves = (el: HTMLElement | null, what: string) => {
  expect(el, `${what}: nothing rendered`).not.toBeNull();
  const txt = el!.textContent ?? '';
  expect(txt.trim(), `${what}: empty`).not.toBe('');
  expect(txt, `${what}: unresolved ICU placeholder`).not.toMatch(/\{[a-zA-Z]/);
  expect(txt, `${what}: a raw key path, i.e. MISSING_MESSAGE`).not.toMatch(/\b(employeePanel|payroll)\./);
};

beforeEach(() => {
  vi.clearAllMocks();
  panelMock.mockResolvedValue(EMPTY_PANEL);
});

describe.each(LOCALES)('r191 · %s — every new caption resolves against the real catalogue', (loc, m) => {
  const msgs = m as unknown as {
    employeePanel: Record<string, string>;
    payroll: { transactions: { individual: Record<string, string> } };
  };

  it('the shared panel: search first, names next, and a closed More filters that reports its count', () => {
    const { container } = wrap(loc, m, <EmployeeScopePanel employees={PEOPLE} selectedId={null} basePath="/x" />);

    const fold = container.querySelector('details')!;
    expect(fold.open).toBe(false);
    resolves(fold.querySelector('summary'), `${loc} employeePanel.moreFilters`);
    expect(within(fold).getByText(msgs.employeePanel.moreFilters)).toBeInTheDocument();

    // The count only appears once something behind the fold is narrowing, so it has to be provoked.
    fireEvent.change(screen.getByDisplayValue(msgs.employeePanel.allCompanies), { target: { value: 'co-a' } });
    const badge = [...fold.querySelectorAll('summary span')].find(
      (s) => s.textContent && s.textContent !== msgs.employeePanel.moreFilters && s.textContent !== '▾',
    ) as HTMLElement | undefined;
    resolves(badge ?? null, `${loc} employeePanel.moreFiltersActive`);
    expect(badge!.textContent).toContain('1');
  });

  it('Individual Transaction: the toolbar the server never renders — period, search and Clear', async () => {
    const ind = msgs.payroll.transactions.individual;
    const { container } = wrap(
      loc,
      m,
      <TxnWorkspace
        employees={[EMPLOYEE]}
        batches={[BATCH]}
        companies={[COMPANY]}
        payItems={[OT]}
        payrollCycles={[]}
        processHref="/payroll"
        requireComponent={false}
        currentPeriod="2026-08"
        panelDefaultOpen
        panelCookieKey="k"
      />,
    );

    // The panel's own fold, in this locale.
    const fold = container.querySelector('details')!;
    expect(fold.open).toBe(false);
    expect(within(fold).getByText(ind.moreFilters)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ind.reset })).toBeInTheDocument();

    // Selecting is what brings the toolbar into existence — no URL can do it on this screen.
    fireEvent.click(await screen.findByRole('button', { name: /Irwin Law/ }));
    await waitFor(() => expect(panelMock).toHaveBeenCalled());

    for (const key of ['periodFilter', 'searchTxnLabel'] as const) {
      const control = screen.getByLabelText(ind[key]);
      expect(control, `${loc} individual.${key}`).toBeInTheDocument();
      resolves(control.closest('label'), `${loc} individual.${key}`);
    }
    expect(screen.getByRole('button', { name: ind.clearFilters })).toBeInTheDocument();

    // "Showing {period} only" is the one message on this row carrying an argument; it stayed in the
    // totals strip across the move, so a broken substitution would surface here and nowhere else.
    fireEvent.change(screen.getByLabelText(ind.periodFilter), { target: { value: '2026-07' } });
    const scope = await screen.findByText((t) => t.includes('2026-07') && !t.includes('{'));
    resolves(scope, `${loc} individual.periodScope`);
  });
});
