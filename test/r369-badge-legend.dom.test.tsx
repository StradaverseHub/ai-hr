/**
 * r369 (item eb949191) — THE THIRD BADGE STATE NEEDS A LEGEND, AND THE LEGEND HAS TO BE ON SCREEN.
 *
 * ── WHY THIS IS A DOM TEST ──────────────────────────────────────────────────────────────────────────
 * The payroll RUN screen is a server component and its legend is covered by the §8 dev-server render.
 * The wizard's Validation step is not reachable that way: it is a CLIENT component rendered only after
 * the operator has walked steps 1 and 2, so a GET of /payroll/process returns step 1 and proves nothing
 * about it. And the interesting case cannot be seeded either — `pnpm db:seed` creates no employee with a
 * zero basic salary. So the component is mounted here and fed the advisory directly, which is the same
 * reasoning (and the same fixture shape) as test/4ca06dea-process-blocker-parity.dom.test.tsx.
 *
 * ── WHAT IT PINS, AND WHY EACH ONE MATTERS ──────────────────────────────────────────────────────────
 *   1. The legend appears whenever ANY badge is on screen — including the case the wizard makes special:
 *      an otherwise ALL-CLEAR run that is nonetheless about to leave somebody out. That run renders the
 *      green "all payroll data is ready" panel AND a notice chip, so a legend gated on
 *      `blockers + warnings` alone would be absent in exactly the state this round introduced.
 *   2. It does NOT appear when no badge does. A legend for badges that are not there is noise, and it
 *      would teach the reader that the line means nothing.
 *   3. The notice does not disable Process. `onStatusChange({ hasBlockers })` is the flag the wizard
 *      footer turns into `canProcess`; a deliberate skip must never touch it.
 *   4. Six locales, fed unmerged, with `onError` throwing — see the ⚠️ below.
 *
 * ⚠️ THE SIX CATALOGUES ARE FED DIRECTLY, not through i18n/request.ts, which deep-merges each locale over
 * English — so a key missing from ms.json would render the ENGLISH sentence and look fine on screen.
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
type NoticeRow = Row & { remarks: string | null };
type Advisory = Record<string, Row[] | NoticeRow[]>;

const EMPTY: Advisory = {
  missingCompensation: [],
  unpayablePayMode: [],
  zeroBasic: [],
  nothingPayable: [],
  staleBasicComponent: [],
  missingStatutory: [],
  missingBank: [],
  currencyMismatch: [],
  hrdfSubjectUnregistered: [],
  tp3YearMismatch: [],
};

const DINA: NoticeRow = {
  employmentId: 'emp-dina',
  name: 'Director Dina',
  employeeCode: 'D0001',
  remarks: 'Director — paid by quarterly director fees, no monthly basic',
};
const CARLA: Row = { employmentId: 'emp-carla', name: 'Custom Carla', employeeCode: 'E-0042' };

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
const p = (l: Locale) => (CATALOGUES[l] as unknown as { payroll: { process: Record<string, string> } }).payroll.process;

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
        employmentIds={[DINA.employmentId]}
        onStatusChange={(s) => seen.push(s)}
      />
    </NextIntlClientProvider>,
  );
  return seen;
}

describe('r369 · the badge legend on the wizard’s Validation step', () => {
  it('(1) renders beside the notice on an otherwise ALL-CLEAR run, and does not block Process', async () => {
    const seen = renderStep({ ...EMPTY, nothingPayable: [DINA] });

    // The flag the wizard footer turns into `canProcess`. A deliberate skip must never touch it.
    await waitFor(() => expect(seen.at(-1)).toEqual({ loading: false, hasBlockers: false }));

    // The green all-clear panel AND the notice: this is the state the legend exists for, and the state a
    // legend gated on `blockers + warnings` alone would have missed.
    expect(screen.getByText(en.payroll.process.validationAllClear)).toBeInTheDocument();
    expect(await screen.findByText(en.payroll.process.validationBadgeLegend)).toBeInTheDocument();
    expect(screen.getByText(en.payroll.process.validationNoticeBadge)).toBeInTheDocument();
    expect(screen.getByText('Director Dina')).toBeInTheDocument();
    expect(screen.getByText('D0001')).toBeInTheDocument();
  });

  it('(2) renders on a BLOCKED run too — one screen with badges, one legend', async () => {
    const seen = renderStep({ ...EMPTY, unpayablePayMode: [CARLA] });
    await waitFor(() => expect(seen.at(-1)).toEqual({ loading: false, hasBlockers: true }));
    expect(await screen.findByText(en.payroll.process.validationBadgeLegend)).toBeInTheDocument();
    expect(screen.getAllByText(en.payroll.process.validationBlockerBadge)).toHaveLength(1);
  });

  it('(3) is ABSENT when no badge is on screen — a legend for nothing is noise', async () => {
    const seen = renderStep(EMPTY);
    await waitFor(() => expect(seen.at(-1)).toEqual({ loading: false, hasBlockers: false }));
    expect(screen.getByText(en.payroll.process.validationAllClear)).toBeInTheDocument();
    expect(screen.queryByText(en.payroll.process.validationBadgeLegend)).not.toBeInTheDocument();
  });

  it('(4) renders in all six locales, and NAMES that locale’s own three badges', async () => {
    for (const l of LOCALES) {
      // Every badge state at once, so the one legend on screen has to be true of all three.
      renderStep({ ...EMPTY, nothingPayable: [DINA], unpayablePayMode: [CARLA], missingBank: [CARLA] }, l);
      const legend = await screen.findByText(p(l).validationBadgeLegend);
      expect(legend, l).toBeInTheDocument();
      // The legend quotes the labels verbatim, so what is on screen names what is on screen. `ta` and `th`
      // spell the blocker badge differently in payroll.batch and payroll.process, which is why this reads
      // the process catalogue rather than a shared one.
      for (const key of ['validationBlockerBadge', 'validationWarningBadge', 'validationNoticeBadge'] as const) {
        expect(legend.textContent ?? '', `${l} legend omits ${key}`).toContain(p(l)[key]);
        expect(screen.getAllByText(p(l)[key]).length, `${l} ${key} not rendered`).toBeGreaterThan(0);
      }
      cleanup(); // dom-setup's afterEach runs per TEST, not per turn of this loop
    }
  });
});
