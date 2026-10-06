/**
 * r392 — item 685d2380 STEP 1, the draft's Employment tab: WHICH END DATE A NEW EMPLOYEE IS CREATED WITH.
 *
 * The plan moves the end-date box off the tab for Full-Time and Part-Time. For Full-Time the probation end
 * is worked out from the Probation Period (Group Join Date + period); Part-Time carries none; Contract and
 * Intern keep the box. The danger is that the date SHOWN on the draft and the date WRITTEN at Activate are
 * two computations that drift — so both call ONE function, `draftProvisionalEndOn` (lib/employee-draft-schema.ts),
 * which calls ONE piece of arithmetic, `addEmploymentPeriod` (lib/employment-period.ts).
 *
 *   §1  the arithmetic — months clamp to month end (the rule `computeProvisionalEndOn` always had),
 *       weeks are 7 days, days are 1, and anything it cannot honestly compute is null, not a guess.
 *   §2  the per-type rule, pure.
 *   §3  the rule AT ACTIVATE — `completeEmployeeDraft` against Postgres, reading
 *       `employment.provisional_end_on` back as the owner. This is the half a pure test cannot see.
 *   §4  the outstanding-list rule follows the same per-type decision.
 *
 * DATES: §3 derives every hire date from `todayInKualaLumpur()` and every expected date from the helper
 * under test's own inputs, never a hand-typed future day. §1's fixed dates are all in the PAST, used only
 * as arithmetic operands (a month-end clamp needs a known month end), so they cannot expire.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { addEmploymentPeriod } from '../lib/employment-period';
import {
  draftProvisionalEndOn,
  draftShowsEndDateBox,
  missingByTab,
  type EmployeeDraftData,
  type EmployeeDraftEmployment,
} from '../lib/employee-draft-schema';
import { completeEmployeeDraft, saveEmployeeDraft } from '../core/employee-draft';
import { computeProvisionalEndOn } from '../core/org';
import { deriveEmploymentStatus } from '../core/employment-status';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

// ── §1 the arithmetic ─────────────────────────────────────────────────────────────────────────────
describe('§1 addEmploymentPeriod — Group Join Date plus a period', () => {
  it('6 months, with the month-end clamp', () => {
    expect(addEmploymentPeriod('2025-01-15', '6', 'month'), 'a plain six months').toBe('2025-07-15');
    expect(addEmploymentPeriod('2025-08-31', '6', 'month'), '31 Aug + 6 months clamps to 28 Feb').toBe('2026-02-28');
    expect(addEmploymentPeriod('2023-08-31', '6', 'month'), 'and to 29 Feb in a leap year').toBe('2024-02-29');
    expect(addEmploymentPeriod('2024-11-30', 3, 'month'), 'a number works as well as a string').toBe('2025-02-28');
  });

  it('weeks are seven days, days are one, and both cross month and year ends', () => {
    expect(addEmploymentPeriod('2025-12-29', '2', 'week'), '2 weeks').toBe('2026-01-12');
    expect(addEmploymentPeriod('2025-02-20', '10', 'day'), '10 days across February').toBe('2025-03-02');
    expect(addEmploymentPeriod('2024-02-20', '10', 'day'), 'and across a leap February').toBe('2024-03-01');
  });

  it('a blank unit reads as month — what the period control DISPLAYS when none is stored', () => {
    expect(addEmploymentPeriod('2025-01-15', '3', undefined)).toBe('2025-04-15');
    expect(addEmploymentPeriod('2025-01-15', '3', '')).toBe('2025-04-15');
  });

  it('nothing it cannot honestly compute — and a blank is NOT zero (Number("") is 0)', () => {
    expect(addEmploymentPeriod('2025-01-15', '', 'month'), 'blank value').toBeNull();
    expect(addEmploymentPeriod('2025-01-15', '   ', 'month'), 'whitespace value').toBeNull();
    expect(addEmploymentPeriod('2025-01-15', undefined, 'month'), 'absent value').toBeNull();
    expect(addEmploymentPeriod('2025-01-15', '1.5', 'month'), 'not a whole number').toBeNull();
    expect(addEmploymentPeriod('2025-01-15', '-1', 'month'), 'negative').toBeNull();
    expect(addEmploymentPeriod('2025-01-15', '3', 'year'), 'a unit the writer does not know').toBeNull();
    expect(addEmploymentPeriod('15/01/2025', '3', 'month'), 'a start that is not ISO').toBeNull();
    expect(addEmploymentPeriod(undefined, '3', 'month'), 'no start').toBeNull();
  });

  it('the single-hire default is the SAME arithmetic (computeProvisionalEndOn now calls it)', () => {
    const today = todayInKualaLumpur();
    for (const months of [1, 3, 6, 12]) {
      expect(computeProvisionalEndOn(today, 'full_time', months), `${months} months`).toBe(
        addEmploymentPeriod(today, months, 'month'),
      );
    }
  });
});

// ── §2 the per-type rule ──────────────────────────────────────────────────────────────────────────
describe('§2 draftProvisionalEndOn — which end date each Employment Type carries', () => {
  const hiredOn = todayInKualaLumpur();
  const sixMonths = addEmploymentPeriod(hiredOn, '6', 'month')!;
  const legacy = '2026-01-31'; // a STORED value only — it is never computed against, so it cannot expire

  it('full_time with a Probation Period → Group Join Date + the period', () => {
    const e: EmployeeDraftEmployment = { employmentType: 'full_time', hiredOn, probationValue: '6', probationUnit: 'month' };
    expect(draftProvisionalEndOn(e), 'full_time derived').toEqual({ date: sixMonths, source: 'period' });
  });

  it('full_time: the period WINS over a stored date (a value left from another type does not land)', () => {
    const e: EmployeeDraftEmployment = {
      employmentType: 'full_time', hiredOn, probationValue: '2', probationUnit: 'week', provisionalEndOn: legacy,
    };
    expect(draftProvisionalEndOn(e).date, 'full_time period beats stored').toBe(addEmploymentPeriod(hiredOn, '2', 'week'));
  });

  it('a LEGACY full_time draft — stored date, no period — keeps its stored date', () => {
    const e: EmployeeDraftEmployment = { employmentType: 'full_time', hiredOn, provisionalEndOn: ` ${legacy} ` };
    expect(draftProvisionalEndOn(e), 'legacy full_time keeps stored').toEqual({ date: legacy, source: 'stored' });
  });

  it('full_time with neither → null: no probation end, Active from the start', () => {
    expect(draftProvisionalEndOn({ employmentType: 'full_time', hiredOn, probationValue: '' })).toEqual({
      date: null,
      source: null,
    });
  });

  it('part_time → null WHATEVER is stored', () => {
    const e: EmployeeDraftEmployment = { employmentType: 'part_time', hiredOn, provisionalEndOn: legacy, probationValue: '3' };
    expect(draftProvisionalEndOn(e), 'part_time stored date lands null').toEqual({ date: null, source: null });
  });

  it('contract and intern keep the stored value, and ignore any probation period', () => {
    for (const employmentType of ['contract', 'intern']) {
      const e: EmployeeDraftEmployment = { employmentType, hiredOn, provisionalEndOn: legacy, probationValue: '3', probationUnit: 'month' };
      expect(draftProvisionalEndOn(e), `${employmentType} keeps stored`).toEqual({ date: legacy, source: 'stored' });
    }
  });

  it('the box is shown for contract and intern only', () => {
    expect(['full_time', 'part_time', 'contract', 'intern', undefined].map((t) => draftShowsEndDateBox(t))).toEqual([
      false, false, true, true, false,
    ]);
  });
});

// ── §4 the outstanding list ───────────────────────────────────────────────────────────────────────
describe('§4 a malformed end date is named only when it would actually land', () => {
  it('contract / intern / legacy full_time: named; part_time and full_time-with-period: not', () => {
    const job = (e: EmployeeDraftEmployment) => missingByTab({ employment: e }).job;
    expect(job({ employmentType: 'contract', provisionalEndOn: 'nope' })).toContain('provisionalEndOn');
    expect(job({ employmentType: 'intern', provisionalEndOn: 'nope' })).toContain('provisionalEndOn');
    expect(job({ employmentType: 'full_time', provisionalEndOn: 'nope' }), 'legacy full_time').toContain('provisionalEndOn');
    expect(job({ employmentType: 'part_time', provisionalEndOn: 'nope' }), 'part_time: goes nowhere').not.toContain(
      'provisionalEndOn',
    );
    expect(
      job({ employmentType: 'full_time', hiredOn: todayInKualaLumpur(), probationValue: '3', provisionalEndOn: 'nope' }),
      'full_time with a period: superseded',
    ).not.toContain('provisionalEndOn');
  });
});

// ── §3 at Activate ────────────────────────────────────────────────────────────────────────────────
let b: Base;
beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('§3 completeEmployeeDraft writes the SAME end date the tab shows', () => {
  const draft = (employment: EmployeeDraftEmployment): EmployeeDraftData => ({
    profile: {
      fullName: 'Probation Case',
      employeeCode: `R392${randomUUID().slice(0, 6).toUpperCase()}`,
      employeeIdMode: 'manual',
      primaryEmail: `r392.${randomUUID().slice(0, 8)}@employment-tab.test`,
    },
    employment: { companyId: b.companyId, departmentId: b.deptA, hiredOn: todayInKualaLumpur(), ...employment },
    payroll: { basicSalary: '3000' },
  });
  const activate = async (employment: EmployeeDraftEmployment) => {
    const ctx = adminCtx(b);
    const data = draft(employment);
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 2 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    const [emp] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, employmentId));
    return { emp, shown: draftProvisionalEndOn(data.employment) };
  };

  it('full_time + 6 months → employment.provisional_end_on is Group Join Date + 6 months, and status is Probation', async () => {
    const hiredOn = todayInKualaLumpur();
    const { emp, shown } = await activate({ employmentType: 'full_time', probationValue: '6', probationUnit: 'month' });
    const expected = addEmploymentPeriod(hiredOn, '6', 'month');
    expect(emp.provisionalEndOn, 'full_time employment.provisional_end_on derived').toBe(expected);
    expect(emp.provisionalEndOn, 'the date the tab showed').toBe(shown.date);
    expect(emp.joinDate, 'Join Date starts the same day as the Group Join Date').toBe(emp.hiredOn);
    expect(deriveEmploymentStatus({ provisionalEndOn: emp.provisionalEndOn }, emp.hiredOn), 'new hire on probation').toBe(
      'probation',
    );
  });

  it('full_time + 2 weeks → two weeks on', async () => {
    const { emp } = await activate({ employmentType: 'full_time', probationValue: '2', probationUnit: 'week' });
    expect(emp.provisionalEndOn, 'full_time weeks').toBe(addEmploymentPeriod(todayInKualaLumpur(), '2', 'week'));
  });

  it('a LEGACY full_time draft — stored date, no period — keeps the stored date', async () => {
    const stored = computeProvisionalEndOn(todayInKualaLumpur(), 'full_time', 3)!; // what the old seed wrote
    const { emp } = await activate({ employmentType: 'full_time', provisionalEndOn: stored });
    expect(emp.provisionalEndOn, 'legacy full_time keeps stored employment.provisional_end_on').toBe(stored);
  });

  it('part_time with a stored date → NULL', async () => {
    const stored = addEmploymentPeriod(todayInKualaLumpur(), '1', 'month')!;
    const { emp } = await activate({ employmentType: 'part_time', provisionalEndOn: stored, probationValue: '3', probationUnit: 'month' });
    expect(emp.provisionalEndOn, 'part_time employment.provisional_end_on').toBeNull();
  });

  it('contract keeps the stored Contract End Date (and hireEmployee mirrors it into contract_end_date)', async () => {
    const stored = addEmploymentPeriod(todayInKualaLumpur(), '12', 'month')!;
    const { emp } = await activate({ employmentType: 'contract', provisionalEndOn: stored, probationValue: '3', probationUnit: 'month' });
    expect(emp.provisionalEndOn, 'contract employment.provisional_end_on').toBe(stored);
    expect(emp.contractEndDate, 'contract employment.contract_end_date').toBe(stored);
  });

  it('intern keeps the stored Internship End Date', async () => {
    const stored = addEmploymentPeriod(todayInKualaLumpur(), '6', 'month')!;
    const { emp } = await activate({ employmentType: 'intern', provisionalEndOn: stored });
    expect(emp.provisionalEndOn, 'intern employment.provisional_end_on').toBe(stored);
  });
});
