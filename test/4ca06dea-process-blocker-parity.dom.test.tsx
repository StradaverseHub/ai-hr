/**
 * Item 4ca06dea — THE PROCESS BUTTON, AND THE SENTENCE BESIDE IT.
 *
 * ── WHY THIS IS A DOM TEST ──────────────────────────────────────────────────────────────────────────
 * The gate the reporter feels is `onStatusChange({ hasBlockers })` in the Validation step: the wizard's
 * footer computes `canProcess = … && !validation.hasBlockers` (app/payroll/process/wizard.tsx), so the
 * button's enabled-ness IS that flag. And the §8 render check cannot reach the interesting case at all —
 * `pnpm db:seed` creates NO `custom_period` employee (production has none either: pay_mode is monthly
 * 105 / daily 1), so a GET of /payroll/process renders the all-clear branch no matter how many locales
 * it is fetched in. The reachable case is covered HERE, by feeding the advisory directly.
 *
 * The arithmetic — that the two counts in that file agree, and that they agree with the server's exact
 * set — is pinned in test/4ca06dea-process-blocker-parity.test.ts. What this file adds is the part a sum
 * cannot show: that the operator is TOLD, before the press, which employee and which fault.
 *
 * ⚠️ THE SIX CATALOGUES ARE FED DIRECTLY, not through i18n/request.ts, which deep-merges each locale
 * over English — so a key missing from ms.json would render the ENGLISH sentence and look fine.
 */
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMsg from '../messages/vi.json';
import zh from '../messages/zh.json';

type Row = { employmentId: string; name: string; employeeCode: string | null };
type Advisory = Record<string, Row[]>;

const EMPTY: Advisory = {
  missingCompensation: [],
  unpayablePayMode: [],
  zeroBasic: [],
  staleBasicComponent: [],
  missingStatutory: [],
  missingBank: [],
  currencyMismatch: [],
  hrdfSubjectUnregistered: [],
  tp3YearMismatch: [],
};

const CARLA: Row = { employmentId: 'emp-carla', name: 'Custom Carla', employeeCode: 'E-0042' };

/** The advisory the component's own server action would return; set per render. */
let nextAdvisory: Advisory = EMPTY;

vi.mock('../app/payroll/process/actions', () => ({
  validatePayrollSelection: () => Promise.resolve(nextAdvisory),
  checkPayrollCycleReadiness: () => Promise.resolve([]),
  checkUnattachedForSelection: () => Promise.resolve([]),
}));

import { StepValidation } from '../app/payroll/process/steps/step-validation';

const CATALOGUES = { en, ms, ta, th, vi: viMsg, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];

type Cat = { payroll: { process: { validationCheck: Record<string, string> } } };
const checkLabel = (l: Locale, key: string) => (CATALOGUES[l] as unknown as Cat).payroll.process.validationCheck[key];
/** "<label> · <n>" is one span; the label is prose, so it is escaped before becoming a pattern. */
const groupRow = (l: Locale, key: string, n: number) =>
  new RegExp(`${checkLabel(l, key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · ${n}`);

function renderStep(advisory: Advisory, locale: Locale = 'en') {
  nextAdvisory = advisory;
  const seen: { loading: boolean; hasBlockers: boolean }[] = [];
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={CATALOGUES[locale] as never}
      onError={(e) => {
        // MISSING_MESSAGE / FORMATTING_ERROR must fail this test, not degrade to a key on screen.
        throw e;
      }}
    >
      <StepValidation
        companyIds={['co-1']}
        payPeriod="2026-05"
        employmentIds={[CARLA.employmentId]}
        onStatusChange={(s) => seen.push(s)}
      />
    </NextIntlClientProvider>,
  );
  return seen;
}

describe('4ca06dea · a custom_period employee disables Process and is named for it', () => {
  it('(a) reports hasBlockers, names the employee, and labels the row a BLOCKER', async () => {
    const seen = renderStep({ ...EMPTY, unpayablePayMode: [CARLA] });

    // The flag the wizard footer reads. Before this round it settled to `false` for exactly this
    // advisory, and the Process button stayed pressable for a run generatePayslips would refuse.
    await waitFor(() => expect(seen.at(-1)).toEqual({ loading: false, hasBlockers: true }));

    // …and the panel says why, by employee and by fault, BEFORE the press.
    expect(await screen.findByText(groupRow('en', 'unpayablePayMode', 1))).toBeInTheDocument();
    expect(screen.getByText('Custom Carla')).toBeInTheDocument();
    expect(screen.getByText('E-0042')).toBeInTheDocument();
    // The red blocker banner, not the amber warning one.
    expect(screen.getAllByText(en.payroll.process.validationBlockerBadge)).toHaveLength(1);
    expect(screen.queryByText(en.payroll.process.validationWarningBadge)).not.toBeInTheDocument();
  });

  it('(c) an advisory with no such employee is still all-clear and still leaves Process enabled', async () => {
    const seen = renderStep(EMPTY);
    await waitFor(() => expect(seen.at(-1)).toEqual({ loading: false, hasBlockers: false }));
    expect(screen.getByText(en.payroll.process.validationAllClear)).toBeInTheDocument();
    expect(screen.queryByText(groupRow('en', 'unpayablePayMode', 1))).not.toBeInTheDocument();
  });

  it('(d) the three older blockers each still disable Process on their own', async () => {
    for (const k of ['missingCompensation', 'zeroBasic', 'tp3YearMismatch'] as const) {
      const seen = renderStep({ ...EMPTY, [k]: [CARLA] });
      await waitFor(() => expect(seen.at(-1), k).toEqual({ loading: false, hasBlockers: true }));
      expect(await screen.findByText(groupRow('en', k, 1)), k).toBeInTheDocument();
      cleanup(); // dom-setup's afterEach runs per TEST, not per turn of this loop
    }
  });

  it('a WARNING-only advisory keeps Process enabled — nothing was promoted to a blocker', async () => {
    const seen = renderStep({ ...EMPTY, staleBasicComponent: [CARLA], currencyMismatch: [CARLA] });
    await waitFor(() => expect(seen.at(-1)).toEqual({ loading: false, hasBlockers: false }));
    expect(screen.getAllByText(en.payroll.process.validationWarningBadge)).toHaveLength(2);
    expect(screen.queryByText(en.payroll.process.validationBlockerBadge)).not.toBeInTheDocument();
  });
});

describe('4ca06dea · the new row renders in all six locales, and the six differ', () => {
  it('each locale renders its OWN sentence, with no missing-message error', async () => {
    const rendered: string[] = [];
    for (const l of LOCALES) {
      renderStep({ ...EMPTY, unpayablePayMode: [CARLA] }, l);
      const node = await screen.findByText(groupRow(l, 'unpayablePayMode', 1));
      rendered.push(node.textContent ?? '');
      cleanup();
    }
    expect(rendered).toHaveLength(LOCALES.length);
    // Six distinct rendered strings: a locale falling back to English would collide with en's.
    expect(new Set(rendered).size).toBe(LOCALES.length);
  });
});
