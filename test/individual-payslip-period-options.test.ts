/**
 * Feedback 5a29686c — Individual Payslip's Year / Month dropdowns.
 *
 * THE VERDICT ON THAT REQUEST WAS "already works", and it was right about five of its six points: the
 * Company / Year / Month / Cycle selector exists, and `desc(payPeriod)` + `matches[0]` already opens the
 * employee's latest run. Only ONE thing was genuinely broken, and it is what this file pins:
 *
 *   `years = Array.from({ length: 11 }, (_, i) => nowYear + 1 - i)` — the same eleven years offered to
 *   every employee whether or not any of them held a payslip. Choosing 2031, or a year before the person
 *   was hired, produced a blank screen with nothing saying why.
 *
 * BOTH HALVES OF THE CONTRACT ARE HERE, because this defect lives BETWEEN two files and a unit test of
 * either half passes throughout:
 *   • `listPayslipPeriodsFor` (core/payroll-view.ts) must return that employee's OWN distinct periods,
 *     fenced on the caller's companies — a DB case, because the fence and the DISTINCT are SQL.
 *   • `payslipPeriodOptions` (app/payroll/individual-payslip/period-options.ts) must turn those into
 *     options that (a) all lead somewhere, (b) always include the value the control is displaying, and
 *     (c) degrade to the old wide window rather than to nothing — pure cases, no DB.
 *   • and the page must actually call both, rather than keeping a fixed window beside them.
 *
 * WHAT IS DELIBERATELY NOT TESTED HERE: the "Payroll runs in this selection" card. It is NOT a history
 * list, its `matches.length > 1` gate is deliberate disambiguation, and 5a29686c's approved plan says in
 * terms not to restructure it. It gained a subtitle and nothing else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createBatch, generatePayslips } from '../core/payroll';
import { listPayslipPeriodsFor } from '../core/payroll-view';
import { payslipPeriodOptions } from '../app/payroll/individual-payslip/period-options';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ───────────────────────────── Pure: what the dropdowns may offer ─────────────────────────────

describe('5a29686c — Year / Month options come from the employee’s own payslips', () => {
  const PERIODS = ['2026-06', '2026-03', '2025-11', '2025-11', '2024-02'];

  it('offers ONLY the years that employee has a payslip in, newest first, deduped', () => {
    const { years } = payslipPeriodOptions(PERIODS, {}, 2026);
    expect(years).toEqual([2026, 2025, 2024]);
    // The specific complaint: a future year nobody has a payslip for is no longer offered.
    expect(years).not.toContain(2031);
    expect(years).not.toContain(2027);
  });

  it('narrows Month to the chosen year — not all twelve, and not another year’s months', () => {
    expect(payslipPeriodOptions(PERIODS, { year: 2026 }, 2026).months).toEqual(['03', '06']);
    expect(payslipPeriodOptions(PERIODS, { year: 2025 }, 2026).months).toEqual(['11']);
    // No year chosen ⇒ every month this person was ever paid in. Still fewer dead options than twelve.
    expect(payslipPeriodOptions(PERIODS, {}, 2026).months).toEqual(['02', '03', '06', '11']);
  });

  it('offers NO months for a year this employee holds nothing in — not all twelve', () => {
    // The subtler half of the same defect. This employee HAS payslips, so the wide fallback must not
    // fire; 2027 simply holds none of them, and twelve dead options under a different condition is the
    // bug over again. Only "All" is left, which is the honest answer.
    expect(payslipPeriodOptions(PERIODS, { year: 2027 }, 2026).months).toEqual([]);
  });

  it('KEEPS the selected year and month as options even when they hold no payslip', () => {
    // THE TRAP THIS EXISTS FOR. A <select> whose value is absent from its <option>s displays the first
    // option instead. So a URL carrying ?year=2031&month=9 — which the page's own guard accepts, since
    // 2031 is inside its 2000..2100 range — would FILTER on September 2031 while the control read
    // "All". The screen would be telling the reader something different from what it applied.
    const { years, months } = payslipPeriodOptions(PERIODS, { year: 2031, month: 9 }, 2026);
    expect(years[0], 'the displayed year must be an option, and sorts newest-first like the rest').toBe(2031);
    expect(years).toEqual([2031, 2026, 2025, 2024]);
    // 2031 has no payslip at all, so its month list is the selected month alone — not silently all twelve.
    expect(months).toEqual(['09']);
  });

  it('falls back to the old eleven-year window when there are NO periods at all', () => {
    // No employee chosen yet, or one who has never been paid. An EMPTY Year dropdown is worse than a
    // wide one, so the screen degrades to exactly the behaviour it had before this change.
    const { years, months } = payslipPeriodOptions([], {}, 2026);
    expect(years).toEqual([2027, 2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017]);
    expect(months).toEqual(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']);
  });

  it('ignores a malformed period rather than offering a NaN year', () => {
    const { years, months } = payslipPeriodOptions(['2026-06', '2026-13', 'nonsense', ''], { year: 2026 }, 2026);
    expect(years).toEqual([2026]);
    expect(months).toEqual(['06']);
  });
});

// ───────────────────────── Source shape: the page must USE both halves ─────────────────────────

describe('5a29686c — the screen reads the employee’s periods, and keeps the otherRuns card', () => {
  const code = () =>
    read('app/payroll/individual-payslip/page.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('derives the dropdowns from the read + the rule, with no fixed window left on the page', () => {
    const src = code();
    expect(src, 'the period index must be read for the chosen employee').toContain('listPayslipPeriodsFor');
    expect(src, 'and turned into options by the shared rule').toContain('payslipPeriodOptions');
    // The defect itself: an eleven-slot window built on the page. The fallback of the same shape now
    // lives in period-options.ts, where it is a documented degrade rather than the primary behaviour.
    expect(src, 'no fixed year window may survive on this page').not.toMatch(/Array\.from\(\s*\{\s*length:\s*11/);
    expect(src, 'and no hard-coded twelve-month list either').not.toMatch(/'01',\s*'02',\s*'03'/);
  });

  it('still renders the otherRuns card, still gated on more than one match, now with its reason', () => {
    // 5a29686c's plan says in terms NOT to remove or restructure this card: it is the only control that
    // separates two runs sharing company + year + month + cycle. Asserted so a later "simplification"
    // that reads it as a redundant history list has to argue with a test.
    const src = code();
    expect(src, 'the card must survive').toContain("t('otherRuns')");
    expect(src, 'gated on MORE THAN ONE match — that gate is the whole point').toContain('matches.length > 1');
    expect(src, 'and it must now say what it is for').toContain("subtitle={t('otherRunsHint')}");
  });

  it('every locale carries a real subtitle, not the English one copied across', () => {
    const en = (JSON.parse(read('messages/en.json')) as Msgs).payroll.individualPayslip.otherRunsHint;
    expect(en).toBeTruthy();
    for (const loc of ['ms', 'zh', 'ta', 'th', 'vi']) {
      const v = (JSON.parse(read(`messages/${loc}.json`)) as Msgs).payroll.individualPayslip.otherRunsHint;
      expect(v, `${loc} must define the subtitle`).toBeTruthy();
      expect(v, `${loc} must be translated, not the English string`).not.toBe(en);
    }
  });
});

type Msgs = { payroll: { individualPayslip: Record<string, string> } };

// ───────────────────── Behavioural: the period index and its company fence ─────────────────────

let base: Base;
beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

async function hire(name: string, email: string) {
  const a = adminCtx(base);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: email },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary: 4000,
    monthlyAllowance: 0,
    effectiveFrom: '2026-01-01',
  });
  return e;
}

/** One regular run for the whole company in `period` (a company+period holds exactly one process). */
async function pay(period: string) {
  const a = adminCtx(base);
  const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: period });
  await generatePayslips(a, { batchId });
}

describe('5a29686c — listPayslipPeriodsFor', () => {
  it('returns the employee’s own periods newest-first, and nothing they were not paid in', async () => {
    const a = adminCtx(base);
    const me = await hire('Periods Me', 'periods.me@acme.test');
    await pay('2026-01');
    await pay('2026-03');

    const periods = await listPayslipPeriodsFor(a, { companyIds: [base.companyId], employmentId: me.employmentId });
    expect(periods, 'newest first, matching the payslip read beside it').toEqual(['2026-03', '2026-01']);

    // And the whole point of the change: the fixed window offered 2031; the derived one does not.
    expect(payslipPeriodOptions(periods, {}, 2026).years).toEqual([2026]);
  });

  it('does not leak a period from an employee who was hired later', async () => {
    // The dropdowns are per-EMPLOYEE. A colleague paid in a month this person was not must not put that
    // month on this person's Year/Month list, or the dead option is simply back under a new name.
    const a = adminCtx(base);
    const early = await hire('Early Bird', 'early.bird@acme.test');
    await pay('2026-01');
    const late = await hire('Late Joiner', 'late.joiner@acme.test');
    await pay('2026-05');

    const earlyPeriods = await listPayslipPeriodsFor(a, {
      companyIds: [base.companyId],
      employmentId: early.employmentId,
    });
    const latePeriods = await listPayslipPeriodsFor(a, {
      companyIds: [base.companyId],
      employmentId: late.employmentId,
    });
    expect(earlyPeriods).toEqual(['2026-05', '2026-01']);
    expect(latePeriods, 'a run before this person joined is not theirs').toEqual(['2026-05']);
  });

  it('fails CLOSED on an empty scope, and on a company the caller does not hold', async () => {
    const a = adminCtx(base);
    const me = await hire('Fenced Periods', 'fenced.periods@acme.test');
    await pay('2026-02');
    expect(await listPayslipPeriodsFor(a, { companyIds: [], employmentId: me.employmentId })).toEqual([]);
    expect(
      await listPayslipPeriodsFor(a, {
        companyIds: ['00000000-0000-0000-0000-0000000000ff'],
        employmentId: me.employmentId,
      }),
    ).toEqual([]);
  });
});
