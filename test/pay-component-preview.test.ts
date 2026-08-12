/**
 * e318eaec — "Check against an employee": the dropdown that read "null null", the working it now shows,
 * and the two new operands, asserted where they turn into money.
 *
 * A. THE REPORTED BUG. `listPayRulePreviewCandidates` built its option label from `person.first_name` and
 *    `person.last_name`. On the reporter's tenant — measured read-only on production 2026-08-12 — those are
 *    NULL on 40 of 40 people and `full_name` is populated on 40 of 40, so `${null} ${null}` produced the
 *    literal "null null" for EVERY option, which `.trim()` cannot remove. The fixture below reproduces that
 *    exact data shape (hireEmployee captures one full name and no first/last name, which is what every
 *    screen in this product does), and the first assertion is that first_name really is NULL — otherwise
 *    this file would be testing something the reporter does not have.
 *
 * B. SHOW THE WORKING. The steps come out of the fold that produced the figure, so this asserts the LAST
 *    running total IS the amount rather than merely that a list of steps came back.
 *
 * C. calendar_days AND prorated_basic, ON A GENERATED PAYSLIP. Row-shape assertions are what let a
 *    double-pay bug ship here before, so both new operands are asserted as ringgit on a real payslip for a
 *    MID-MONTH JOINER — the only shape in which `calendar_days` and `days`, and `prorated_basic` and
 *    `basic`, are different numbers at all.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import {
  backfillEmploymentComponentsFromCompensation,
  listPayComponents,
  listPayRulePreviewCandidates,
  previewPayRule,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  upsertPayComponent,
} from '../core/pay-components';
import type { PayRule } from '../core/pay-rule';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

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

const baseItem = {
  name: 'Test item',
  kind: 'allowance' as const,
  includedInEpf: true,
  includedInSocsoEis: true,
  includedInPcb: true,
  includedInHrdfBase: false,
  isNonPayable: false,
  prorates: false,
};

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// A. THE "null null" DROPDOWN
// ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('e318eaec A — the employee picker reads a NAME and an ID, not "null null"', () => {
  async function hire(fullName: string, employeeCode: string) {
    const a = await entitledCtx(base);
    const e = await hireEmployee(a, {
      // ONE name field, exactly as every screen in this product captures it — and exactly the shape that
      // made the old label read "null null" for all 40 people on the reporter's tenant.
      person: { fullName, primaryEmail: `${employeeCode.toLowerCase()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
      employeeCode,
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    return { a, ...e };
  }

  it('THE FIXTURE MATCHES PRODUCTION: first_name and last_name are NULL, full_name carries the name', async () => {
    const e = await hire('Irwin Law', 'X000001');
    const [p] = await owner.db.select().from(schema.person).where(eq(schema.person.id, e.personId));
    expect(p.firstName).toBeNull();
    expect(p.lastName).toBeNull();
    expect(p.fullName).toBe('Irwin Law');
  });

  it('the candidate carries the full name and the employee ID — the old code produced "null null" here', async () => {
    const { a } = await hire('Irwin Law', 'X000001');
    const rows = await listPayRulePreviewCandidates(a);
    const irwin = rows.find((r) => r.employeeCode === 'X000001');
    expect(irwin, 'the employee is missing from the picker entirely').toBeDefined();
    expect(irwin!.name).toBe('Irwin Law');
    // The label the screen composes. `${firstName} ${lastName}` produced exactly the string on the right.
    expect(`${irwin!.name} (${irwin!.employeeCode})`).toBe('Irwin Law (X000001)');
    expect(`${irwin!.name} (${irwin!.employeeCode})`).not.toContain('null');
  });

  it('EVERY candidate is named — not merely the first, and not merely most of them', async () => {
    await hire('Irwin Law', 'X000001');
    await hire('TEST0013', 'A0013');
    await hire('NURUL ALIAH BINTI ACHIN', 'X000815');
    const a = await entitledCtx(base);
    const rows = await listPayRulePreviewCandidates(a);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) {
      expect(r.name, 'an unnamed candidate is the reported bug').toBeTruthy();
      expect(r.name).not.toContain('null');
    }
  });

  it('searches by NAME and by EMPLOYEE ID — the list used to be the fifty most recently hired, unsearchable', async () => {
    await hire('Irwin Law', 'X000001');
    await hire('TEST0013', 'A0013');
    const a = await entitledCtx(base);

    const byName = await listPayRulePreviewCandidates(a, { query: 'irwin' }); // case-insensitive
    expect(byName.map((r) => r.employeeCode)).toEqual(['X000001']);

    const byCode = await listPayRulePreviewCandidates(a, { query: 'A0013' });
    expect(byCode.map((r) => r.name)).toEqual(['TEST0013']);

    // A PARTIAL match, not a prefix and not a whole-word one — "00" appears inside both employee IDs.
    const partial = await listPayRulePreviewCandidates(a, { query: '00' });
    expect(partial.map((r) => r.employeeCode).sort()).toEqual(expect.arrayContaining(['A0013', 'X000001']));

    expect(await listPayRulePreviewCandidates(a, { query: 'zzzz-nobody' })).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// B. SHOW THE WORKING
// ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('e318eaec B — the preview shows how the figure was reached, from the fold that reached it', () => {
  /** Irwin Law's real shape: basic 5,000, one fixed allowance of 400, and 15 hours of attendance. */
  async function setupIrwin() {
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    const a = await entitledCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Irwin Law', primaryEmail: 'irwin@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
      employeeCode: 'X000001',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await seedPayComponentCatalog(a);
    await backfillEmploymentComponentsFromCompensation(a);

    // A0080 TRAVEL ALLOWANCE 400.00 — a FIXED allowance, so it is what `fixed_allowances` totals.
    await upsertPayComponent(a, { code: 'A0080', ...baseItem, name: 'Travel allowance', prorates: false });
    const items = await listPayComponents(a);
    await setEmploymentPayComponent(a, {
      employmentId: e.employmentId,
      componentId: items.find((x) => x.code === 'A0080')!.id,
      amount: 400,
      effectiveFrom: '2026-01-01',
    });

    // 15 hours of attendance in August 2026 (one 8h day + one 7h day).
    await owner.db.insert(schema.attendance).values([
      { tenantId: base.tenantId, employmentId: e.employmentId, attendanceDate: '2026-08-03', status: 'present', dayType: 'workday', workedMinutes: 480 },
      { tenantId: base.tenantId, employmentId: e.employmentId, attendanceDate: '2026-08-04', status: 'present', dayType: 'workday', workedMinutes: 420 },
    ]);
    return { a, employmentId: e.employmentId };
  }

  /** The reporter's live OT1_5 rule, verbatim from production `pay_component.rule`. */
  const OT1_5: PayRule = {
    kind: 'formula',
    start: { ref: 'basic' },
    terms: [
      { op: '+', operand: { ref: 'fixed_allowances' } },
      { op: '/', operand: { ref: 'number', value: 26, label: 'Working days' } },
      { op: '/', operand: { ref: 'number', value: 8, label: 'Working hours' } },
      { op: '*', operand: { ref: 'number', value: 1.5, label: 'Rate 1.5' } },
      { op: '*', operand: { ref: 'hours' } },
    ],
  };

  it("reproduces the reporter's own RM584.13, and every step of how it got there", async () => {
    const { a, employmentId } = await setupIrwin();
    const res = await previewPayRule(a, {
      code: 'OT1_5',
      rule: OT1_5,
      kind: 'allowance',
      prorates: false,
      employmentId,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // (5000 + 400) / 26 / 8 × 1.5 × 15 — the figure on his August payslip.
    expect(res.amount).toBeCloseTo(584.134615, 5);

    // The seed plus one row per step, in the order they were applied.
    expect(res.steps.map((s) => s.op)).toEqual([null, '+', '/', '/', '*', '*']);
    expect(res.steps.map((s) => s.operand.ref)).toEqual(['basic', 'fixed_allowances', 'number', 'number', 'number', 'hours']);
    // The running total after each step: this is the working the panel prints.
    expect(res.steps.map((s) => Number(s.running.toFixed(4)))).toEqual([5000, 5400, 207.6923, 25.9615, 38.9423, 584.1346]);
    // THE LAST RUNNING TOTAL IS THE ANSWER — if it ever is not, the panel is describing a route to the
    // figure that the evaluator did not take.
    expect(res.steps.at(-1)!.running).toBeCloseTo(res.amount, 10);
    // And each step reports the operand's own value, which is what makes "5,000.00 + 400.00" printable.
    expect(res.steps[1].value).toBeCloseTo(400, 6);
    expect(res.steps.at(-1)!.value).toBeCloseTo(15, 6);
  });

  it('naming the numbers did not change the figure — the labels never reach the evaluator', async () => {
    const { a, employmentId } = await setupIrwin();
    // The SAME rule with every `label` removed — i.e. exactly what is stored on production today.
    const stripped: PayRule = {
      kind: 'formula',
      start: { ref: 'basic' },
      terms: [
        { op: '+', operand: { ref: 'fixed_allowances' } },
        { op: '/', operand: { ref: 'number', value: 26 } },
        { op: '/', operand: { ref: 'number', value: 8 } },
        { op: '*', operand: { ref: 'number', value: 1.5 } },
        { op: '*', operand: { ref: 'hours' } },
      ],
    };
    const named = await previewPayRule(a, { code: 'OT1_5', rule: OT1_5, kind: 'allowance', prorates: false, employmentId, periodStart: '2026-08-01', periodEnd: '2026-08-31' });
    const plain = await previewPayRule(a, { code: 'OT1_5', rule: stripped, kind: 'allowance', prorates: false, employmentId, periodStart: '2026-08-01', periodEnd: '2026-08-31' });
    expect(named.ok && plain.ok).toBe(true);
    if (named.ok && plain.ok) expect(named.amount).toBe(plain.amount);
  });

  it('a non-formula rule has no working to show, and says so with an empty list rather than a fake one', async () => {
    const { a, employmentId } = await setupIrwin();
    const res = await previewPayRule(a, {
      code: 'FLAT',
      rule: { kind: 'percent_of', base: 'basic', pct: 10 },
      kind: 'allowance',
      prorates: false,
      employmentId,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.amount).toBeCloseTo(500, 2);
      expect(res.steps).toEqual([]);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// C. THE TWO NEW OPERANDS, AS MONEY ON A GENERATED PAYSLIP
// ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('e318eaec C — calendar_days and prorated_basic pay the right figure for a MID-MONTH JOINER', () => {
  /** Joined 16 May 2026: the EA-1955 tenure factor is < 1, which is the only condition under which
   *  calendar_days ≠ days and prorated_basic ≠ basic. A full-month employee would prove nothing. */
  async function setupJoiner() {
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    const a = await entitledCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Mid Month Mahesh', primaryEmail: 'mid@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-05-16',
      employeeCode: 'X000777',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-05-16' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await seedPayComponentCatalog(a);
    await backfillEmploymentComponentsFromCompensation(a);

    // Three items, each reading exactly ONE operand, so the payslip line IS the operand's value. All three
    // have prorates=false so the kernel's own factor is not applied on top — the figure on the payslip is
    // the figure the formula resolved to, and nothing else.
    const specs: [string, PayRule][] = [
      ['CALDAYS', { kind: 'formula', start: { ref: 'calendar_days' }, terms: [] }],
      ['DAYSW', { kind: 'formula', start: { ref: 'days' }, terms: [] }],
      ['PBASIC', { kind: 'formula', start: { ref: 'prorated_basic' }, terms: [] }],
    ];
    for (const [code, rule] of specs) {
      await upsertPayComponent(a, { code, ...baseItem, name: code, rule });
    }
    const items = await listPayComponents(a);
    for (const [code] of specs) {
      await setEmploymentPayComponent(a, {
        employmentId: e.employmentId,
        componentId: items.find((x) => x.code === code)!.id,
        // Deliberately WRONG stored amounts: the rule, not the stored amount, must drive the figure.
        amount: 1,
        effectiveFrom: '2026-05-01',
      });
    }
    return { a, employmentId: e.employmentId };
  }

  /** What each item ACTUALLY PAID on the generated payslip, by pay code — read from the payslip's own
   *  per-component provenance (`statutory.componentLines`), which is the itemisation the payslip prints. */
  async function payslipLines(batchId: string) {
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    const lines = (ps.statutory as { componentLines?: { code: string; amount: number }[] }).componentLines ?? [];
    return new Map(lines.map((l) => [l.code, Number(l.amount)]));
  }

  it('calendar_days pays the length of the MONTH, days pays the PRORATED count — they are not the same number', async () => {
    const { a } = await setupJoiner();
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const lines = await payslipLines(batchId);

    // May 2026 has 31 days, for everybody, joiner or not.
    expect(lines.get('CALDAYS')).toBeCloseTo(31, 2);
    // The tenure-prorated count is smaller — this employee was not there for the first half of the month.
    expect(lines.get('DAYSW')!).toBeGreaterThan(0);
    expect(lines.get('DAYSW')!).toBeLessThan(31);
    // THE ASSERTION THAT STOPS SOMEONE QUIETLY ALIASING ONE TO THE OTHER.
    expect(lines.get('CALDAYS')).not.toBeCloseTo(lines.get('DAYSW')!, 2);
  });

  it('prorated_basic pays the payslip\'s OWN basic salary — the proration payroll already applied', async () => {
    const { a } = await setupJoiner();
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const lines = await payslipLines(batchId);
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));

    // Not 5,000: this employee joined mid-month and payroll paid them less.
    expect(Number(ps.basicSalary)).toBeLessThan(5000);
    expect(Number(ps.basicSalary)).toBeGreaterThan(0);
    // The operand IS that figure — a formula using it can never disagree with the payslip's basic line,
    // which is the entire reason it exists rather than being rebuilt out of days and divisors.
    expect(lines.get('PBASIC')).toBeCloseTo(Number(ps.basicSalary), 2);
  });

  it('for a FULL-period employee prorated_basic is simply the basic — nothing changed for the ordinary case', async () => {
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    const a = await entitledCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Whole Month Wong', primaryEmail: 'whole@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
      employeeCode: 'X000778',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await seedPayComponentCatalog(a);
    await backfillEmploymentComponentsFromCompensation(a);
    await upsertPayComponent(a, {
      code: 'PBASIC',
      ...baseItem,
      name: 'PBASIC',
      rule: { kind: 'formula', start: { ref: 'prorated_basic' }, terms: [] },
    });
    const items = await listPayComponents(a);
    await setEmploymentPayComponent(a, {
      employmentId: e.employmentId,
      componentId: items.find((x) => x.code === 'PBASIC')!.id,
      amount: 1,
      effectiveFrom: '2026-01-01',
    });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const lines = await payslipLines(batchId);
    expect(lines.get('PBASIC')).toBeCloseTo(5000, 2);
  });
});
