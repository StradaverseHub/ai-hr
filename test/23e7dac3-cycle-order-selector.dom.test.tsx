/**
 * Item 23e7dac3 — THE CYCLE SELECTOR OPENS, AND IT OPENS ONLY WHERE THE REFUSAL IS LIVE.
 *
 * The gate the reporter sees is one expression in `step-period.tsx`: a non-regular cycle was disabled
 * until a regular run existed, so a BONUS, an Off Cycle or an advance salary could never be the month's
 * first run even when that is the order the money was actually paid in.
 *
 * ── WHY THIS IS A DOM TEST ──────────────────────────────────────────────────────────────────────────
 * The disabling is client state computed from the runs already in the period; a GET of
 * /payroll/process cannot reach the interesting case, because at that moment no company is selected and
 * no period has been typed. So the §8 render check covers this screen's static markup and this file
 * covers the option's own `disabled` attribute.
 *
 * ── AND WHY THE SERVER GUARD IS ASSERTED FROM HERE ──────────────────────────────────────────────────
 * Opening the selector is only safe because a run that would restate a FILED month is refused
 * (ADR-0085 step 4). That refusal lives in the kernel and is proven against a real database in
 * `test/23e7dac3-filed-refusal.test.ts`. What THIS file adds is the tie between the two: the last block
 * reads `core/payroll.ts` and fails if the relaxation outlives the refusal. Without it, deleting the
 * guard leaves a green suite and an open selector — the exact shape ADR-0085's build order forbids.
 *
 * ⚠️ THE SIX CATALOGUES ARE FED DIRECTLY, not through i18n/request.ts, which deep-merges each locale
 * over English — so a key missing from ms.json would render the ENGLISH sentence and look fine.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';
import { StepPeriod, type CycleOption, type ExistingRun } from '../app/payroll/process/steps/step-period';

const COMPANY = { id: 'co-1', name: 'Acme Sdn Bhd', sharedSystemLabels: true };
const PERIOD = '2026-05';

const CYCLES: CycleOption[] = [
  { id: 'cy-monthly', name: 'Monthly', runType: 'regular', remarks: null, description: null },
  { id: 'cy-bonus', name: 'Bonus', runType: 'bonus', remarks: null, description: null },
  { id: 'cy-advance', name: 'Advance Salary', runType: 'off_cycle', remarks: 'Advance Salary', description: null },
];
/** A company whose catalog holds ONLY the monthly cycle — arm (g). */
const REGULAR_ONLY: CycleOption[] = [CYCLES[0]];

const regularRun: ExistingRun = {
  id: 'b-1', companyId: COMPANY.id, payPeriod: PERIOD, runType: 'regular', status: 'processed', company: COMPANY.name,
};

function renderStep(p: { runs?: ExistingRun[]; cycles?: CycleOption[]; multiCycle?: boolean; messages?: typeof en } = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={(p.messages ?? en) as never} onError={(e) => { throw e; }}>
      <StepPeriod
        companies={[COMPANY]}
        companyIds={[COMPANY.id]}
        onCompanyIds={() => {}}
        selectAll={false}
        onSelectAll={() => {}}
        payPeriod={PERIOD}
        onPayPeriod={() => {}}
        cycleId={p.cycles?.[0].id ?? CYCLES[0].id}
        onCycleId={() => {}}
        cycleOptions={p.cycles ?? CYCLES}
        paymentDate=""
        onPaymentDate={() => {}}
        defaultPaymentDate={`${PERIOD}-28`}
        multiCycle={p.multiCycle ?? true}
        existingRuns={p.runs ?? []}
      />
    </NextIntlClientProvider>,
  );
}

const option = (label: string) => screen.getByRole('option', { name: new RegExp(`^${label}`) }) as HTMLOptionElement;

describe('23e7dac3 · the cycle selector, both directions', () => {
  it('(f) with NO regular run for the period, a Bonus and an Advance Salary cycle are SELECTABLE', () => {
    renderStep({ runs: [] });
    // The defect, from the reporter's own words: these two were disabled until Monthly had been run.
    expect(option('Bonus').disabled).toBe(false);
    expect(option('Advance Salary').disabled).toBe(false);
    // …and the monthly run is of course still available as the first run.
    expect(option('Monthly').disabled).toBe(false);
  });

  it('(f) the OTHER direction: a regular-mapped cycle is still disabled once a regular run exists', () => {
    renderStep({ runs: [regularRun] });
    // Unchanged, and deliberately so — there is exactly one monthly run per month.
    expect(option('Monthly').disabled).toBe(true);
    // …while the non-regular cycles stay open, which is what they always were in this state.
    expect(option('Bonus').disabled).toBe(false);
    expect(option('Advance Salary').disabled).toBe(false);
  });

  it('the note explaining the new order appears only where there is a choice to make', () => {
    renderStep({ runs: [] });
    expect(screen.getByText(en.payroll.process.anyCycleOrderNote)).toBeTruthy();
    // Once the monthly run exists the order question is settled for this month, so the note goes away.
    renderStep({ runs: [regularRun] });
    expect(screen.queryAllByText(en.payroll.process.anyCycleOrderNote)).toHaveLength(1);
  });

  it('(g) a company with NO non-regular cycle configured sees nothing new at all', () => {
    renderStep({ runs: [], cycles: REGULAR_ONLY });
    expect(option('Monthly').disabled).toBe(false);
    expect(screen.queryByText(en.payroll.process.anyCycleOrderNote)).toBeNull();
    expect(screen.queryByRole('option', { name: /Bonus/ })).toBeNull();
  });

  it('(g) multi-cycle OFF is untouched: the off-note shows and the order note does not', () => {
    renderStep({ runs: [], cycles: REGULAR_ONLY, multiCycle: false });
    expect(screen.getByText(en.payroll.process.multiCycleOffNote)).toBeTruthy();
    expect(screen.queryByText(en.payroll.process.anyCycleOrderNote)).toBeNull();
  });
});

describe('23e7dac3 · the new sentence exists in all six catalogues, and the six are distinct', () => {
  const CATALOGUES = { en, ms, ta, th, vi, zh } as const;

  it.each(Object.entries(CATALOGUES))('%s renders its OWN sentence, not the English one', (locale, messages) => {
    renderStep({ runs: [], messages: messages as typeof en });
    const own = (messages as typeof en).payroll.process.anyCycleOrderNote;
    expect(own, `${locale} has no payroll.process.anyCycleOrderNote`).toBeTruthy();
    expect(screen.getByText(own)).toBeTruthy();
    // i18n/request.ts deep-merges each locale over English, so a MISSING key renders the English
    // sentence and looks perfectly fine on screen. Comparing against English is what catches that.
    if (locale !== 'en') expect(own).not.toBe(en.payroll.process.anyCycleOrderNote);
  });

  it('all six are distinct from one another (no catalogue was filled by copying its neighbour)', () => {
    const all = Object.values(CATALOGUES).map((m) => (m as typeof en).payroll.process.anyCycleOrderNote);
    expect(new Set(all).size).toBe(6);
  });
});

describe('23e7dac3 · the selector is open only while the refusal is live', () => {
  /**
   * ADR-0085's build order says the filed-month refusal must exist BEFORE the order is relaxed, and that
   * step 5 must not ship without step 4. A test suite cannot enforce an ordering of commits, but it can
   * enforce the end state: this relaxation and that refusal stand or fall together. The strings below
   * are the call sites, not merely the identifier, so re-pointing the guard at a weaker predicate fails
   * here too.
   */
  const payrollSrc = readFileSync(join(process.cwd(), 'core/payroll.ts'), 'utf8');

  it('core/payroll.ts still refuses a restating run on a filed month, at every door the wizard reaches', () => {
    // The predicate is the OWNED one (core/statutory-filed.ts, resolving against STATUTORY_FILED_STATUSES),
    // never a second hand-rolled list.
    expect(payrollSrc).toContain("from './statutory-filed'");
    expect(payrollSrc).toContain('periodFiledTx');
    // Door 1 — creating a non-regular run (what the now-open selector leads to).
    expect(payrollSrc).toContain("what: 'Adding another payroll run'");
    // Door 2 — creating the monthly run into a month that already has runs (the reversed order).
    expect(payrollSrc).toContain("what: 'Adding the monthly payroll run to a month that already has runs'");
    // Door 3 — generating payslips for any run that is not the month's first. This is the one that
    // actually stands between a filing and a moved figure.
    expect(payrollSrc).toMatch(/if \(batch\.runSeq > 1\) \{\s*await refuseIfPeriodFiled\(/);
  });

  it('the selector it protects really is open (the two statements are read from one file)', () => {
    const stepSrc = readFileSync(join(process.cwd(), 'app/payroll/process/steps/step-period.tsx'), 'utf8');
    // The reporter's line 85, as it now reads: regular still gated on regularExists, non-regular not.
    expect(stepSrc).toContain("disabled: c.runType === 'regular' ? regularExists : false,");
    expect(stepSrc).not.toContain('!regularExists,');
  });
});
