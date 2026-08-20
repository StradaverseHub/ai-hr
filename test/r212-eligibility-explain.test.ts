/**
 * r212 (8ebf77ae) — "NO ELIGIBILITY RULE REACHES YOU", WITH THE RULES NAMED.
 *
 * The reporter's ticket was never "which rule won"; it was the opposite one. A leave type resolves to
 * nothing and the screen says so in one word — WHICH rules exist, which are in force, and what about ME
 * did not match? Until `explainEntitlementEligibility` that answer existed nowhere: `winnerFor` returns
 * `null`, and null carries no reasons.
 *
 * ⚠️ WHAT THESE TESTS ARE REALLY PINNING IS THAT THERE IS NO SECOND MATCHER. core/entitlement-template.ts's
 * header is explicit that a third engine for "who does this apply to" would be the defect wearing the fix's
 * clothes. So every case below asserts the explanation against the SAME resolver that decides:
 *   - `matched` is asserted to agree with `resolveEntitlementForEmployment`'s own answer, case by case;
 *   - `soleTableApplies` is asserted to be the engine's `viaSoleTemplate`, not a re-derivation of r193's
 *     fault-3 gate;
 *   - the failing AXIS is found by asking `resolveOrgCriteriaTargets` a narrower question, so a case that
 *     names an axis is also a case where the resolver excluded the employee on exactly that subset.
 *
 * THE FIVE SHAPES, each one a state the reporter's own tenant is in or has been in:
 *   1. tables and NO rules at all           — Annual Leave: 16 tables, 0 rules, nobody resolves.
 *   2. a rule in force that EXCLUDES        — Medical / "CONTRACT - GRADE H - 18", narrowed to contract.
 *   3. a rule whose valid_to has PASSED     — Medical / PERMANENT, ended 2026-08-13, and six days of silence.
 *   4. ONE table and no rule                — Hospitalization Leave, which works, and must NOT read as a
 *                                             missing rule (r193 fault 3).
 *   5. an employee who DOES match           — the winning rule named, so a correct answer is explainable too.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hireEmployee } from '../core/org';
import { createLeaveType } from '../core/admin';
import {
  createEligibilityRule,
  createEntitlementTemplate,
  eligibilityNoticeFrom,
  explainEntitlementEligibility,
  resolveEntitlementForEmployment,
  retireEligibilityRule,
  updateEligibilityRule,
} from '../core/entitlement-template';
import type { ServiceBand } from '../core/leave-compute';
import { leaveEntitlementBreakdown } from '../core/read';
import { withTenant } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

let b: Base;
const uniqEmail = () => `elig_${randomUUID().slice(0, 8)}@t.local`;
const flat = (days: number): ServiceBand[] => [{ fromYears: 0, toYears: null, days }];
const ASOF = '2026-08-20';

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

const hire = (employmentType: 'full_time' | 'contract') =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Ada Lovelace', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType,
    hiredOn: '2020-01-01',
    gradeId: null,
    grantLeaveTypes: [],
  });

const explain = (employmentId: string, leaveTypeId = b.annualLeaveTypeId, asOf = ASOF) =>
  withTenant(adminCtx(b), (tx) => explainEntitlementEligibility(tx, { employmentId, leaveTypeId, asOf }));

const resolve = (employmentId: string, leaveTypeId = b.annualLeaveTypeId, asOf = ASOF) =>
  withTenant(adminCtx(b), (tx) => resolveEntitlementForEmployment(tx, { employmentId, leaveTypeId, asOf }));

describe('r212 — explaining why an employee resolves to no entitlement table', () => {
  it('CASE 1 — tables and no rules at all: no rule is named, and none is invented', async () => {
    const ctx = adminCtx(b);
    // TWO tables, deliberately: with one, the r193 fault-3 gate would apply it and this would be case 4.
    // Annual Leave on the reporter's account has sixteen.
    await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Grade 12-15 Permanent',
      serviceBands: flat(14),
      validFrom: '2026-01-01',
    });
    await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Grade 16-19 Permanent',
      serviceBands: flat(18),
      validFrom: '2026-01-01',
    });
    const emp = await hire('full_time');

    const x = await explain(emp.employmentId);
    expect(x.rules).toEqual([]);
    expect(x.winner).toBeNull();
    expect(x.soleTableApplies).toBe(false);
    // The employee is a candidate — the silence is the configuration's, not theirs. Blaming the employee
    // here is exactly the wrong answer, because the remedy is to write a rule.
    expect(x.activeAtDate).toBe(true);
    // AND IT AGREES WITH THE ENGINE, which is the property the whole file is about.
    expect(await resolve(emp.employmentId)).toBeNull();
  });

  it('CASE 2 — a rule in force that excludes on employment type names the AXIS and the employee\'s own value', async () => {
    const ctx = adminCtx(b);
    const contractTable = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Contract',
      serviceBands: flat(12),
      validFrom: '2026-01-01',
    });
    await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Permanent',
      serviceBands: flat(18),
      validFrom: '2026-01-01',
    });
    await createEligibilityRule(ctx, {
      name: 'CONTRACT - GRADE H - 18',
      templateLineageId: contractTable.lineageId,
      criteria: { employmentTypes: ['contract'] },
      validFrom: '2026-01-01',
    });

    const permanent = await hire('full_time');
    const x = await explain(permanent.employmentId);

    expect(x.rules).toHaveLength(1);
    const [rule] = x.rules;
    expect(rule.ruleName).toBe('CONTRACT - GRADE H - 18');
    expect(rule.inForce).toBe(true);
    expect(rule.pointsAtTableInForce).toBe(true);
    expect(rule.matched).toBe(false);
    // THE AXIS — a field name of the shared criteria vocabulary, so a screen labels it from the same
    // pickers the rule was typed in rather than from a second list of names.
    expect(rule.firstFailure?.axis).toBe('employmentTypes');
    // …AND THE EMPLOYEE'S OWN VALUE, which is the difference between a message HR can act on and one they
    // have to go and look up. Read from the assignment in force on `asOf`.
    expect(rule.firstFailure?.employeeValue).toBe('full_time');
    expect(rule.failsOnCombination).toBe(false);
    expect(x.winner).toBeNull();
    expect(await resolve(permanent.employmentId)).toBeNull();

    // The same rule, from the other side: a contract employee matches it, and the explanation says so.
    const contractor = await hire('contract');
    const y = await explain(contractor.employmentId);
    expect(y.rules[0].matched).toBe(true);
    expect(y.rules[0].firstFailure).toBeNull();
    expect(y.winner?.ruleName).toBe('CONTRACT - GRADE H - 18');
  });

  it('CASE 3 — a rule whose valid_to has passed is reported as ENDED, never as "you are not in it"', async () => {
    const ctx = adminCtx(b);
    const tpl = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'PERMANENT',
      serviceBands: flat(14),
      validFrom: '2026-01-01',
    });
    await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'CONTRACT',
      serviceBands: flat(10),
      validFrom: '2026-01-01',
    });
    const rule = await createEligibilityRule(ctx, {
      name: 'PERMANENT',
      templateLineageId: tpl.lineageId,
      // NO criteria: it would have matched everybody, right up until the day it stopped. That is the
      // production shape — the rule was correct and its END DATE was the whole fault.
      criteria: {},
      validFrom: '2026-01-01',
    });
    await retireEligibilityRule(ctx, { lineageId: rule.lineageId, validTo: '2026-08-13' });

    const emp = await hire('full_time');
    const x = await explain(emp.employmentId);

    expect(x.rules).toHaveLength(1);
    expect(x.rules[0].inForce).toBe(false);
    expect(x.rules[0].validTo).toBe('2026-08-13');
    // NOT TESTED, so nothing about this employee is blamed. An axis named here would send an administrator
    // to edit criteria on a rule that matches nobody whatever they type.
    expect(x.rules[0].matched).toBe(false);
    expect(x.rules[0].firstFailure).toBeNull();
    expect(x.rules[0].failsOnCombination).toBe(false);
    expect(x.winner).toBeNull();

    // …and the state a screen renders is `expired`, which is its own sentence.
    const notice = eligibilityNoticeFrom(x);
    expect(notice.verdict).toBe('no_match');
    expect(notice.rules[0].state).toBe('expired');
    expect(notice.rules[0].tested).toBe(false);
    expect(notice.rules[0].failingAxis).toBeNull();
  });

  it('CASE 4 — ONE table and no rule: the table applies, and that is not a missing rule', async () => {
    const ctx = adminCtx(b);
    const hosp = await createLeaveType(ctx, { code: 'HOSP', name: 'Hospitalization Leave' });
    const tpl = await createEntitlementTemplate(ctx, {
      leaveTypeId: hosp.id,
      name: 'Hospitalization',
      serviceBands: flat(60),
      validFrom: '2026-01-01',
    });
    const emp = await hire('full_time');

    const x = await explain(emp.employmentId, hosp.id);
    // THE ENGINE'S OWN ANSWER, not a second derivation of the r193 fault-3 gate.
    expect(x.soleTableApplies).toBe(true);
    expect(x.winner?.viaSoleTemplate).toBe(true);
    expect(x.winner?.templateName).toBe(tpl.name);
    expect(x.winner?.ruleName).toBeNull();
    expect(x.rules).toEqual([]);
    expect((await resolve(emp.employmentId, hosp.id))?.viaSoleTemplate).toBe(true);
  });

  it('CASE 5 — an employee who matches: the explanation names the rule that won', async () => {
    const ctx = adminCtx(b);
    const tpl = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Executive',
      serviceBands: flat(22),
      validFrom: '2026-01-01',
    });
    await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Contract',
      serviceBands: flat(10),
      validFrom: '2026-01-01',
    });
    await createEligibilityRule(ctx, {
      name: 'Everyone',
      templateLineageId: tpl.lineageId,
      criteria: {},
      validFrom: '2026-01-01',
    });
    const emp = await hire('full_time');

    const x = await explain(emp.employmentId);
    expect(x.winner?.ruleName).toBe('Everyone');
    expect(x.rules[0].matched).toBe(true);
    expect(x.soleTableApplies).toBe(false);

    const notice = eligibilityNoticeFrom(x);
    expect(notice.verdict).toBe('resolved');
    expect(notice.rules[0].state).toBe('matched');
    expect(notice.winningRuleName).toBe('Everyone');
    expect(notice.winningTableName).toBe('Executive');
  });

  /**
   * ⚠️ THE COMBINATION NO CASE ABOVE COVERED, AND THE ONE THE TWO SCREENS DISAGREED ABOUT.
   *
   * `activeAtDate: false` AND `soleTableApplies: true` at the same time, which is not a contrived pairing:
   * the r193 fault-3 shortcut (one table in force, no rule in force ⇒ the table applies) deliberately does
   * not consult the employment window, so ANY leaver read at today's date, or anyone read at a date before
   * their hire, lands here on the reporter's own Hospitalization shape.
   *
   * The admin panel tested `!activeAtDate` first and printed "no rule can reach them"; the employee's panel
   * tested `soleTableApplies` first and printed "that table applies to everyone" — from the IDENTICAL
   * object. `eligibilityNoticeFrom` now decides the verdict once, and this pins WHICH way it decides: a
   * winner outranks the window, because "no rule can reach them" is false about an outcome the same engine
   * produced from the very table it claims nothing reached. The window survives as its own flag.
   */
  it('a SOLE TABLE that resolves for somebody outside their employment window has ONE verdict, not two', async () => {
    const ctx = adminCtx(b);
    const hosp = await createLeaveType(ctx, { code: 'HOSP2', name: 'Hospitalization Leave' });
    await createEntitlementTemplate(ctx, {
      leaveTypeId: hosp.id,
      name: 'Hospitalization',
      serviceBands: flat(60),
      validFrom: '2026-01-01',
    });
    const emp = await hireEmployee(ctx, {
      person: { fullName: 'Late Joiner', primaryEmail: uniqEmail() },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-06-01',
      gradeId: null,
      grantLeaveTypes: [],
    });

    const x = await explain(emp.employmentId, hosp.id, '2026-01-01');
    // Measured, not assumed: all three of these hold together.
    expect(x.activeAtDate).toBe(false);
    expect(x.soleTableApplies).toBe(true);
    expect(x.winner?.templateName).toBe('Hospitalization');

    const notice = eligibilityNoticeFrom(x);
    // ONE answer, and it is the one the engine's own figure was produced from.
    expect(notice.verdict).toBe('sole_table');
    // …and the window is not lost — it rides alongside so both screens can caveat it.
    expect(notice.activeAtDate).toBe(false);
  });

  it('an EMPLOYMENT that did not exist on the date is said so, instead of being blamed on an axis', async () => {
    const ctx = adminCtx(b);
    const tpl = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Permanent',
      serviceBands: flat(14),
      validFrom: '2020-01-01',
    });
    await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Contract',
      serviceBands: flat(10),
      validFrom: '2020-01-01',
    });
    await createEligibilityRule(ctx, {
      name: 'Permanent staff',
      templateLineageId: tpl.lineageId,
      criteria: { employmentTypes: ['full_time'] },
      validFrom: '2020-01-01',
    });
    const emp = await hire('full_time');

    // Asked as at a date BEFORE the hire. `resolveOrgCriteriaTargets` excludes anybody not yet hired before
    // it considers a single criterion, so every rule would fail — and blaming Employment Type for that
    // would be a true statement about the query and a false one about the configuration.
    const x = await explain(emp.employmentId, b.annualLeaveTypeId, '2019-01-01');
    expect(x.activeAtDate).toBe(false);
    expect(x.rules[0].matched).toBe(false);
    expect(x.rules[0].firstFailure).toBeNull();
    expect(x.rules[0].failsOnCombination).toBe(false);

    // NOTHING RESOLVED here, so the window IS the verdict.
    const notice = eligibilityNoticeFrom(x);
    expect(notice.verdict).toBe('not_active');

    // ⚠️ AND THE CASE THAT READ AS A BLANK CELL. Asked at a date where the rule IS in force but the
    // employee is not yet hired, the rule's STATE is legitimately `in_force` — it is the EMPLOYEE who is
    // out of scope. `tested` is what separates the two, and without it the screen showed "In force" beside
    // an empty reason column, inviting an administrator to hunt for a criterion never consulted.
    const later = await hireEmployee(ctx, {
      person: { fullName: 'Not Yet Hired', primaryEmail: uniqEmail() },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-06-01',
      gradeId: null,
      grantLeaveTypes: [],
    });
    const y = eligibilityNoticeFrom(await explain(later.employmentId, b.annualLeaveTypeId, '2026-01-01'));
    expect(y.verdict).toBe('not_active');
    expect(y.rules[0].state).toBe('in_force');
    expect(y.rules[0].tested).toBe(false);
    expect(y.rules[0].failingAxis).toBeNull();
  });

  it('a rule edited to take effect LATER is still reported as IN FORCE today, and still tested', async () => {
    // ⚠️ THE VERSIONING TRAP. An edit CLOSES the running version at its `validFrom` and inserts a successor
    // from that date, so an edit dated next month leaves the lineage with a FUTURE head sitting over a
    // version that is in force today. An explanation that judged the lineage on its latest row would report
    // "starts next month" for a rule the engine is matching people with right now — and would never test its
    // criteria, so it could contradict `winner` in the same answer.
    const ctx = adminCtx(b);
    const tpl = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Contract',
      serviceBands: flat(12),
      validFrom: '2026-01-01',
    });
    await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Permanent',
      serviceBands: flat(18),
      validFrom: '2026-01-01',
    });
    const rule = await createEligibilityRule(ctx, {
      name: 'Contract staff',
      templateLineageId: tpl.lineageId,
      criteria: { employmentTypes: ['contract'] },
      validFrom: '2026-01-01',
    });
    // …and the successor starts AFTER `ASOF`, which is the whole point of the case.
    await updateEligibilityRule(ctx, {
      lineageId: rule.lineageId,
      criteria: { employmentTypes: ['full_time'] },
      validFrom: '2026-12-01',
    });

    const contractor = await hire('contract');
    const x = await explain(contractor.employmentId);
    expect(x.rules).toHaveLength(1);
    expect(x.rules[0].validFrom).toBe('2026-01-01');
    expect(x.rules[0].inForce).toBe(true);
    // The version IN FORCE narrows to contract, so the contractor matches — and the engine agrees, which is
    // the assertion that makes this more than a display preference.
    expect(x.rules[0].matched).toBe(true);
    expect(x.winner?.ruleName).toBe('Contract staff');
    expect((await resolve(contractor.employmentId))?.ruleName).toBe('Contract staff');
  });

  it('an UNDATED axis is captioned, because it is read at today\'s value however far back asOf reaches', async () => {
    const ctx = adminCtx(b);
    const tpl = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Female staff',
      serviceBands: flat(16),
      validFrom: '2026-01-01',
    });
    await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Everyone else',
      serviceBands: flat(14),
      validFrom: '2026-01-01',
    });
    await createEligibilityRule(ctx, {
      name: 'Female staff',
      templateLineageId: tpl.lineageId,
      // `genders` is one of UNDATED_ELIGIBILITY_AXES — `person.gender` carries no effective dating anywhere
      // in this schema, so a past-date answer is still today's value. Said, not implied away.
      criteria: { genders: ['female'] },
      validFrom: '2026-01-01',
    });
    const emp = await hire('full_time');

    const x = await explain(emp.employmentId);
    expect(x.usesUndatedAxis).toBe(true);
    expect(x.rules[0].usesUndatedAxis).toBe(true);
  });
});

/**
 * r212 — AND THE HALF THE APPROVED PLAN LED WITH: THE EMPLOYEE'S OWN SCREEN.
 *
 * The explanation is worth nothing while it is reachable only from the configuration screen. The plan's
 * fourth bullet is the EMPLOYEE's: "when an employee's leave shows 'No eligibility rule reaches you', name
 * the rules that exist, say which are in force, and for each one in force say the first thing about that
 * employee which does not match."
 *
 * It reaches them by riding INSIDE `leaveEntitlementBreakdown`, which every screen that shows the side-sheet
 * already loads (/leave, the employee balances screen, /admin/personnel/[id]) — so no host page had to be
 * edited and none of them can forget. These cases pin that wiring at the READ, because a prop with no
 * caller type-checks, passes every static guard and renders nowhere: that is exactly what shipped first.
 */
describe('r212 — the explanation reaches the employee\'s own breakdown', () => {
  it('a no-eligibility-match pair carries the notice, with the rule NAMED and the failing axis on it', async () => {
    const ctx = adminCtx(b);
    const tpl = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'CONTRACT - GRADE H - 18',
      serviceBands: flat(18),
      validFrom: '2026-01-01',
    });
    await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'PERMANENT',
      serviceBands: flat(14),
      validFrom: '2026-01-01',
    });
    await createEligibilityRule(ctx, {
      name: 'CONTRACT - GRADE H - 18',
      templateLineageId: tpl.lineageId,
      criteria: { employmentTypes: ['contract'] },
      validFrom: '2026-01-01',
    });
    const emp = await hire('full_time');

    const breakdown = await leaveEntitlementBreakdown(ctx, emp.employmentId, b.annualLeaveTypeId, ASOF);
    expect(breakdown, 'the employee has no breakdown for this type').not.toBeNull();
    expect(breakdown!.entitlementStatus).toBe('no_eligibility_match');
    const notice = breakdown!.eligibility;
    expect(notice, 'the breakdown carries no eligibility notice — the panel prop has no caller again').toBeDefined();
    expect(notice!.verdict).toBe('no_match');
    expect(notice!.rules).toHaveLength(1);
    expect(notice!.rules[0].name).toBe('CONTRACT - GRADE H - 18');
    expect(notice!.rules[0].state).toBe('in_force');
    expect(notice!.rules[0].tested).toBe(true);
    // The criteria FIELD NAME, not a label: `core/read.ts` has no translator, so the panel names it.
    expect(notice!.rules[0].failingAxis).toBe('employmentTypes');
    // The lineage id, because a list keyed on the name collapses two identically-named rules into one row.
    expect(notice!.rules[0].id).toBeTruthy();
    // No href: an employee's own side-sheet has nowhere to send anybody.
    expect(notice!.rules[0].href).toBeNull();
  });

  it('a pair that RESOLVES pays for no explanation at all', async () => {
    // The gate is a cost decision as much as an editorial one: this read runs once PER LEAVE TYPE per
    // screen, and the explanation costs a handful of queries plus one per rule tested.
    const ctx = adminCtx(b);
    const tpl = await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Everyone',
      serviceBands: flat(14),
      validFrom: '2026-01-01',
    });
    await createEntitlementTemplate(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Contract',
      serviceBands: flat(10),
      validFrom: '2026-01-01',
    });
    await createEligibilityRule(ctx, {
      name: 'Everyone',
      templateLineageId: tpl.lineageId,
      criteria: {},
      validFrom: '2026-01-01',
    });
    const emp = await hire('full_time');

    const breakdown = await leaveEntitlementBreakdown(ctx, emp.employmentId, b.annualLeaveTypeId, ASOF);
    expect(breakdown, 'the employee has no breakdown for this type').not.toBeNull();
    expect(breakdown!.entitlementStatus).not.toBe('no_eligibility_match');
    expect(breakdown!.eligibility).toBeUndefined();
  });
});
