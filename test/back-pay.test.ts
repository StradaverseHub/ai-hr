/**
 * 2ef69d1e — Back Pay (Arrears), pass 1.
 *
 * THE ASSERTION THIS WHOLE FILE EXISTS FOR is `the closed payslip is byte-identical afterwards`. Every
 * other test here checks that the arithmetic is right; that one checks that the feature has not quietly
 * become "reopen the month and run it again", which is the thing it was built to replace.
 *
 * The second-most important property is SIGN. Production carries a 6000 → 5500 backdated revision, so a
 * suite that only ever tests a rise would pass while the negative path posted a negative amount into a
 * ledger that rejects non-positive figures. Both directions are exercised end to end, including the
 * posting.
 *
 * The fixtures deliberately create arrears the way production does: run the payroll FIRST, then key the
 * backdated salary change. `compensation.recorded_at` then really is later than `payslip.created_at`,
 * which is the detector's whole basis — no clock is mocked and no timestamp is written by hand.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createBatch, generatePayslips, setPayrollInput } from '../core/payroll';
import {
  BACK_PAY_DEDUCTION_CODE,
  BACK_PAY_EARNING_CODE,
  BackPayNothingToCalculateError,
  BackPayTargetRunNotDraftError,
  approveAndPostBackPay,
  backPayRunDetail,
  calculateBackPay,
  cancelBackPayRun,
  detectArrears,
  listBackPayRuns,
  periodBounds,
  ruleReadsHours,
  verifyBackPayRun,
  weightedMonthlyBasic,
} from '../core/back-pay';
import { seedPayComponentCatalog, upsertPayComponent } from '../core/pay-components';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  setSetting,
  type Base,
} from './harness';

describe('2ef69d1e — Back Pay (Arrears)', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    // Posting rides the one-off ledger, which requires a named pay item once kernel consumption is on.
    // Both gates are written out rather than assumed: `payroll.individual_txn_pay_enabled` is a SETTING
    // whose platform row may be true on a box whose env carries the legacy flag, and
    // `typed_pay_components` is a MODULE where a missing row is disabled.
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', false);
    await setModule(base.tenantId, 'typed_pay_components', null);
  });
  afterAll(async () => {
    await closeAll();
  });

  // employee_statutory_my carries a UNIQUE index on the IC, so a fixture that hires twice needs two.
  let icSeq = 0;

  /** Hire one employee on a monthly basic, effective from the start of 2026. */
  async function hire(basic: number, name = 'Arrears Ann') {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: `bp${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    icSeq += 1;
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: `9001010${String(icSeq).padStart(5, '0')}` });
    return { a, employmentId: e.employmentId, personId: e.personId };
  }

  /** Run and CLOSE a month's payroll — the state a back pay run must never disturb. */
  async function runAndClose(period: string) {
    const a = adminCtx(base);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: period });
    await generatePayslips(a, { batchId });
    await closeBatch(a, { batchId });
    return batchId;
  }

  const payslipRow = (employmentId: string, batchId: string) =>
    owner.db
      .select()
      .from(schema.payslip)
      .where(and(eq(schema.payslip.employmentId, employmentId), eq(schema.payslip.batchId, batchId)))
      .then((r) => r[0]);

  // ───────────────────────── the pure helpers ─────────────────────────

  it('weightedMonthlyBasic day-weights a mid-month rise, and divides by the days COVERED, not days-in-month', () => {
    // March has 31 days. A rise on the 15th means 14 days on the old figure and 17 on the new.
    const rows = [
      { basic: 5000, validFrom: '2026-01-01', validTo: '2026-03-15', recordedAt: new Date(), payMode: 'monthly' },
      { basic: 6000, validFrom: '2026-03-15', validTo: null, recordedAt: new Date(), payMode: 'monthly' },
    ];
    expect(weightedMonthlyBasic(rows, '2026-03')).toBeCloseTo((5000 * 14 + 6000 * 17) / 31, 6);

    // A MID-MONTH HIRE covers only part of the month, and the average must still be the salary in
    // force — not a prorated figure. Dividing by days-in-month here would prorate a second time, on top
    // of the `factor` the engine multiplies this by.
    const hired = [{ basic: 5000, validFrom: '2026-03-10', validTo: null, recordedAt: new Date(), payMode: 'monthly' }];
    expect(weightedMonthlyBasic(hired, '2026-03')).toBeCloseTo(5000, 6);

    // A record that ended before the period, and one that starts after it, contribute nothing.
    expect(
      weightedMonthlyBasic([{ basic: 9000, validFrom: '2025-01-01', validTo: '2026-03-01', recordedAt: new Date(), payMode: 'monthly' }], '2026-03'),
    ).toBeNull();
    expect(
      weightedMonthlyBasic([{ basic: 9000, validFrom: '2026-04-01', validTo: null, recordedAt: new Date(), payMode: 'monthly' }], '2026-03'),
    ).toBeNull();
  });

  it('periodBounds handles a non-leap February', () => {
    expect(periodBounds('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28', dim: 28 });
  });

  it('ruleReadsHours follows the dependency chain, not just the rule in hand', () => {
    const byCode = new Map<string, schema.PayRule | null>([
      ['HOURLYBASE', { kind: 'per_hour', rate: 10 }],
      ['DERIVED', { kind: 'percent_of', base: 'component', componentCode: 'HOURLYBASE', pct: 50 }],
      ['PLAIN', { kind: 'percent_of', base: 'basic', pct: 10 }],
    ]);
    expect(ruleReadsHours('HOURLYBASE', byCode)).toBe(true);
    expect(ruleReadsHours('DERIVED', byCode)).toBe(true); // transitively
    expect(ruleReadsHours('PLAIN', byCode)).toBe(false);
  });

  // ───────────────────────── detection ─────────────────────────

  it('detects a salary revision KEYED AFTER the payroll — and NOT one keyed before it', async () => {
    const { a, employmentId } = await hire(5000);
    // Employee B's salary is set before any payroll runs; they are the control. The naive query
    // ("valid_from before the last payslip") would return them, which is why it is wrong.
    const b = await hire(4000, 'Control Carl');

    await runAndClose('2026-03');

    // Now the backdated rise, keyed AFTER March was paid and closed.
    await setCompensation(a, { employmentId, basicSalary: 6000, effectiveFrom: '2026-03-01' });

    const found = await detectArrears(a, { companyId: base.companyId });
    expect(found.map((f) => f.employmentId)).toEqual([employmentId]);
    expect(found.map((f) => f.employmentId)).not.toContain(b.employmentId);
    expect(found[0].affectedPeriods).toEqual(['2026-03']);
    expect(found[0].newBasic).toBeCloseTo(6000, 2);
  });

  it('detects the same revision across EVERY already-paid month it should have affected', async () => {
    const { a, employmentId } = await hire(5000);
    await runAndClose('2026-02');
    await runAndClose('2026-03');
    await setCompensation(a, { employmentId, basicSalary: 6000, effectiveFrom: '2026-02-01' });

    const found = await detectArrears(a, { companyId: base.companyId });
    expect(found).toHaveLength(1);
    expect(found[0].affectedPeriods).toEqual(['2026-02', '2026-03']);
  });

  // ───────────────────────── the difference, both directions ─────────────────────────

  it('a backdated RISE produces a positive basic line, and the closed payslip is byte-identical afterwards', async () => {
    const { a, employmentId } = await hire(5000);
    const marchBatch = await runAndClose('2026-03');
    const before = await payslipRow(employmentId, marchBatch);

    await setCompensation(a, { employmentId, basicSalary: 6000, effectiveFrom: '2026-03-01' });
    const { runId, total } = await calculateBackPay(a, { companyId: base.companyId, targetPayPeriod: '2026-04' });
    expect(total).toBeCloseTo(1000, 2);

    const detail = await backPayRunDetail(a, runId);
    const basic = detail!.rows.find((r) => r.payCode === 'BASIC')!;
    expect(basic.byPeriod['2026-03']).toMatchObject({ old: 5000, new: 6000, diff: 1000 });
    expect(detail!.periods).toEqual(['2026-03']);

    // ⚠️ THE ASSERTION THE WHOLE FEATURE RESTS ON.
    const after = await payslipRow(employmentId, marchBatch);
    expect(after).toEqual(before);
  });

  it('a backdated REDUCTION produces a NEGATIVE line and posts as a deduction (production has a 6000 → 5500)', async () => {
    const { a, employmentId } = await hire(6000, 'Reduction Rita');
    await runAndClose('2026-03');
    await setCompensation(a, { employmentId, basicSalary: 5500, effectiveFrom: '2026-03-01' });

    const { runId, total } = await calculateBackPay(a, { companyId: base.companyId, targetPayPeriod: '2026-04' });
    expect(total).toBeCloseTo(-500, 2);
    const detail = await backPayRunDetail(a, runId);
    expect(detail!.rows[0].byPeriod['2026-03'].diff).toBeCloseTo(-500, 2);
    expect(detail!.perEmployee[0].total).toBeCloseTo(-500, 2);

    await approveAndPostBackPay(a, { runId });
    const txns = await owner.db
      .select()
      .from(schema.payrollIndividualTxn)
      .where(eq(schema.payrollIndividualTxn.employmentId, employmentId));
    expect(txns).toHaveLength(1);
    // MAGNITUDE + KIND, never a negative amount: the ledger refuses a non-positive figure.
    expect(txns[0].kind).toBe('deduction');
    expect(Number(txns[0].amount)).toBeCloseTo(500, 2);
    expect(txns[0].payPeriod).toBe('2026-04');
    const [comp] = await owner.db
      .select()
      .from(schema.payComponent)
      .where(and(eq(schema.payComponent.tenantId, base.tenantId), eq(schema.payComponent.code, BACK_PAY_DEDUCTION_CODE)));
    expect(txns[0].componentId).toBe(comp.id);
  });

  it('a mid-month effective date pays only the days from it — the arrears are day-weighted', async () => {
    const { a, employmentId } = await hire(5000);
    await runAndClose('2026-03'); // 31 days
    await setCompensation(a, { employmentId, basicSalary: 6200, effectiveFrom: '2026-03-15' });

    const { runId } = await calculateBackPay(a, { companyId: base.companyId, targetPayPeriod: '2026-04' });
    const detail = await backPayRunDetail(a, runId);
    // 14 days at 5000, 17 at 6200 ⇒ the difference is 17/31 of 1200.
    expect(detail!.total).toBeCloseTo(Math.round(((6200 - 5000) * 17) / 31 * 100) / 100, 1);
  });

  it('multi-month arrears produce one column per affected month and a correct grand total', async () => {
    const { a, employmentId } = await hire(5000);
    await runAndClose('2026-02');
    await runAndClose('2026-03');
    await setCompensation(a, { employmentId, basicSalary: 5500, effectiveFrom: '2026-02-01' });

    const { runId } = await calculateBackPay(a, { companyId: base.companyId, targetPayPeriod: '2026-04' });
    const detail = await backPayRunDetail(a, runId);
    expect(detail!.periods).toEqual(['2026-02', '2026-03']);
    expect(detail!.total).toBeCloseTo(1000, 2); // 500 × 2 months
  });

  // ───────────────────────── pay items that follow basic ─────────────────────────

  it('a pay item configured as a percentage of basic follows the revised figure with no extra setup', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    await upsertPayComponent(a, {
      code: 'SKILLALW',
      name: 'Skill Allowance',
      kind: 'allowance',
      includedInEpf: false,
      includedInSocsoEis: false,
      includedInPcb: true,
      includedInHrdfBase: false,
      isNonPayable: false,
      prorates: true,
      rule: { kind: 'percent_of', base: 'basic', pct: 10 },
    });
    const [comp] = await owner.db
      .select()
      .from(schema.payComponent)
      .where(and(eq(schema.payComponent.tenantId, base.tenantId), eq(schema.payComponent.code, 'SKILLALW')));

    const { employmentId } = await hire(5000, 'Percent Pam');
    await owner.db.insert(schema.employmentPayComponent).values({
      tenantId: base.tenantId,
      employmentId,
      componentId: comp.id,
      amount: '0',
      validFrom: '2026-01-01',
    });

    await runAndClose('2026-03');
    await setCompensation(a, { employmentId, basicSalary: 6000, effectiveFrom: '2026-03-01' });

    const { runId } = await calculateBackPay(a, { companyId: base.companyId, targetPayPeriod: '2026-04' });
    const detail = await backPayRunDetail(a, runId);
    const skill = detail!.rows.find((r) => r.payCode === 'SKILLALW');
    expect(skill, 'the 10%-of-basic item must appear on its own line').toBeTruthy();
    // 10% of 5000 → 10% of 6000, so 100 more for the month.
    expect(skill!.byPeriod['2026-03'].diff).toBeCloseTo(100, 2);
    expect(detail!.total).toBeCloseTo(1100, 2);
  });

  // ───────────────────────── what it refuses to guess ─────────────────────────

  it('manually keyed overtime is flagged for review, never re-priced and never posted', async () => {
    const { a, employmentId } = await hire(5000, 'Overtime Otto');
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-03' });
    // setPayrollInput is the manual keying path — it stamps ot_source = 'manual'.
    await setPayrollInput(a, { batchId, employmentId, overtimeAmount: 300 });
    await generatePayslips(a, { batchId });
    await closeBatch(a, { batchId });

    await setCompensation(a, { employmentId, basicSalary: 6000, effectiveFrom: '2026-03-01' });
    const { runId } = await calculateBackPay(a, { companyId: base.companyId, targetPayPeriod: '2026-04' });
    const detail = await backPayRunDetail(a, runId);

    const ot = detail!.rows.find((r) => r.payCode === 'OVERTIME');
    expect(ot, 'manual overtime must be SURFACED, not silently zeroed').toBeTruthy();
    expect(ot!.needsReview).toBe(true);
    expect(ot!.reviewReason).toBe('manualOvertime');
    // Excluded from the total, and from what posts: the basic difference only.
    expect(detail!.total).toBeCloseTo(1000, 2);

    await approveAndPostBackPay(a, { runId });
    const txns = await owner.db
      .select()
      .from(schema.payrollIndividualTxn)
      .where(eq(schema.payrollIndividualTxn.employmentId, employmentId));
    expect(txns).toHaveLength(1);
    expect(Number(txns[0].amount)).toBeCloseTo(1000, 2);
  });

  it('a month with unpaid leave is REFUSED whole, not overpaid', async () => {
    // WHY THIS IS A REFUSAL AND NOT AN ADJUSTMENT: the kernel deducts unpaid leave as
    // `basicRaw / unpaidDivisor x unpaidDays`, a SEPARATE figure that is not netted into
    // payslip.basic_salary. A backdated rise therefore raises that deduction too, so arrears that
    // reworked only the basic would pay MORE than is owed. Under-paying with a stated reason is the
    // right failure; silently overpaying is not.
    const a = adminCtx(base);
    const { employmentId } = await hire(5000, 'Unpaid Uma');

    // An UNPAID leave type + an approved request starting in the affected month, inserted directly:
    // the fixture only needs the two columns unpaidDaysByEmployment reads (leave_type.paid = false,
    // leave_request.status = 'approved'), and core/leave*.ts is out of this build's lane.
    const [lt] = await owner.db
      .insert(schema.leaveType)
      // leave_type_code_shape (migration 0031) is ^[A-Z][A-Z0-9_]{1,31}$. A uuid slice can contain a
      // hyphen, which would make this test flaky roughly one run in five — a fixed code cannot.
      .values({ tenantId: base.tenantId, code: 'UNPAID_ARREARS', name: 'Unpaid Leave', paid: false })
      .returning({ id: schema.leaveType.id });
    await owner.db.insert(schema.leaveRequest).values({
      tenantId: base.tenantId,
      employmentId,
      leaveTypeId: lt.id,
      startDate: '2026-03-10',
      endDate: '2026-03-10',
      days: '1',
      status: 'approved',
    });

    await runAndClose('2026-03');
    await setCompensation(a, { employmentId, basicSalary: 6000, effectiveFrom: '2026-03-01' });

    const { runId } = await calculateBackPay(a, { companyId: base.companyId, targetPayPeriod: '2026-04' });
    const detail = await backPayRunDetail(a, runId);
    const rows = detail!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].payCode).toBe('UNPAID');
    expect(rows[0].needsReview).toBe(true);
    expect(rows[0].reviewReason).toBe('unpaidLeaveInPeriod');
    // Nothing payable was computed for that month, so nothing posts for it.
    expect(detail!.total).toBe(0);
    expect(detail!.perEmployee).toHaveLength(0);
  });

  // ───────────────────────── the duplicate guard ─────────────────────────

  it('refuses to calculate the same salary revision twice until the earlier run is cancelled', async () => {
    const { a, employmentId } = await hire(5000);
    await runAndClose('2026-03');
    await setCompensation(a, { employmentId, basicSalary: 6000, effectiveFrom: '2026-03-01' });

    const { runId } = await calculateBackPay(a, { companyId: base.companyId, targetPayPeriod: '2026-04' });

    // Covered by a live run ⇒ invisible to detection, and a second calculate has nothing to do.
    expect(await detectArrears(a, { companyId: base.companyId })).toHaveLength(0);
    await expect(calculateBackPay(a, { companyId: base.companyId, targetPayPeriod: '2026-04' })).rejects.toBeInstanceOf(
      BackPayNothingToCalculateError,
    );

    // Cancelling RELEASES it — which is the plan's "unless the earlier back pay has been cancelled first".
    await cancelBackPayRun(a, { runId });
    const again = await detectArrears(a, { companyId: base.companyId });
    expect(again).toHaveLength(1);
    expect(again[0].employmentId).toBe(employmentId);
  });

  // ───────────────────────── posting and cancelling ─────────────────────────

  it('approve and post writes one-off transactions on the TARGET period and leaves history untouched', async () => {
    const { a, employmentId } = await hire(5000);
    const marchBatch = await runAndClose('2026-03');
    const before = await payslipRow(employmentId, marchBatch);

    await setCompensation(a, { employmentId, basicSalary: 6000, effectiveFrom: '2026-03-01' });
    const { runId } = await calculateBackPay(a, { companyId: base.companyId, targetPayPeriod: '2026-04' });
    await verifyBackPayRun(a, { runId });

    const { postedCount } = await approveAndPostBackPay(a, { runId });
    expect(postedCount).toBe(1);

    const txns = await owner.db
      .select()
      .from(schema.payrollIndividualTxn)
      .where(eq(schema.payrollIndividualTxn.employmentId, employmentId));
    expect(txns).toHaveLength(1);
    expect(txns[0].kind).toBe('earning');
    expect(txns[0].payPeriod).toBe('2026-04');
    expect(txns[0].txnDate).toBe('2026-04-01');
    expect(Number(txns[0].amount)).toBeCloseTo(1000, 2);
    // The posting names a real master item, seeded on first use.
    const [comp] = await owner.db
      .select()
      .from(schema.payComponent)
      .where(and(eq(schema.payComponent.tenantId, base.tenantId), eq(schema.payComponent.code, BACK_PAY_EARNING_CODE)));
    expect(txns[0].componentId).toBe(comp.id);

    // History untouched, and the March batch is still closed.
    expect(await payslipRow(employmentId, marchBatch)).toEqual(before);
    const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, marchBatch));
    expect(batch.status).toBe('closed');

    const events = await eventTypesFor(base.tenantId, runId);
    expect(events).toContain('back-pay.calculated');
    expect(events).toContain('back-pay.verified');
    expect(events).toContain('back-pay.posted');

    const runs = await listBackPayRuns(a, { companyIds: [base.companyId] });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('posted');
    expect(runs[0].total).toBeCloseTo(1000, 2);
  });

  it('cancel removes the postings while the target run is a draft, and is REFUSED once it is processed', async () => {
    const { a, employmentId } = await hire(5000);
    await runAndClose('2026-03');
    await setCompensation(a, { employmentId, basicSalary: 6000, effectiveFrom: '2026-03-01' });
    const { runId } = await calculateBackPay(a, { companyId: base.companyId, targetPayPeriod: '2026-04' });
    await approveAndPostBackPay(a, { runId });

    // Still a draft (in fact, no April run exists yet) ⇒ cancel pulls the postings back out.
    const { removed } = await cancelBackPayRun(a, { runId });
    expect(removed).toBe(1);
    expect(
      await owner.db.select().from(schema.payrollIndividualTxn).where(eq(schema.payrollIndividualTxn.employmentId, employmentId)),
    ).toHaveLength(0);

    // Now do it again and let April actually process. Cancel must refuse: the money is in a payslip.
    const second = await calculateBackPay(a, { companyId: base.companyId, targetPayPeriod: '2026-04' });
    await approveAndPostBackPay(a, { runId: second.runId });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-04' });
    await generatePayslips(a, { batchId });
    await expect(cancelBackPayRun(a, { runId: second.runId })).rejects.toBeInstanceOf(BackPayTargetRunNotDraftError);
  });

  it('posting into an already-processed target run is refused, not silently marked for recalculation', async () => {
    const { a, employmentId } = await hire(5000);
    await runAndClose('2026-03');
    await setCompensation(a, { employmentId, basicSalary: 6000, effectiveFrom: '2026-03-01' });
    const { runId } = await calculateBackPay(a, { companyId: base.companyId, targetPayPeriod: '2026-04' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-04' });
    await generatePayslips(a, { batchId });
    await expect(approveAndPostBackPay(a, { runId })).rejects.toBeInstanceOf(BackPayTargetRunNotDraftError);
    expect(
      await owner.db.select().from(schema.payrollIndividualTxn).where(eq(schema.payrollIndividualTxn.employmentId, employmentId)),
    ).toHaveLength(0);
  });

  it('the seeded Back Pay items are ordinary WAGE items — EPF, SOCSO/EIS and PCB, no PCB stream declared', async () => {
    // THE POINT OF THIS TEST: declaring pcbRemunerationType 'additional' routes the amount into the
    // kernel's BONUS bucket, which is EXCLUDED from SOCSO/EIS. Arrears of wages are not. The approved
    // plan promises the arrears "attract EPF, SOCSO and PCB in the month they are actually paid", and
    // that promise is only kept while these flags say wage. If a later change declares a stream here,
    // this test is the thing that has to be argued with.
    const { a, employmentId } = await hire(5000, 'Seeded Sam');
    await runAndClose('2026-03');
    await setCompensation(a, { employmentId, basicSalary: 6000, effectiveFrom: '2026-03-01' });
    const { runId } = await calculateBackPay(a, { companyId: base.companyId, targetPayPeriod: '2026-04' });
    await approveAndPostBackPay(a, { runId });

    for (const [code, kind] of [
      [BACK_PAY_EARNING_CODE, 'allowance'],
      [BACK_PAY_DEDUCTION_CODE, 'deduction'],
    ] as const) {
      const [c] = await owner.db
        .select()
        .from(schema.payComponent)
        .where(and(eq(schema.payComponent.tenantId, base.tenantId), eq(schema.payComponent.code, code)));
      expect(c, `${code} must be seeded on first use`).toBeTruthy();
      expect(c.kind).toBe(kind);
      expect(c.includedInEpf).toBe(true);
      expect(c.includedInSocsoEis).toBe(true);
      expect(c.includedInPcb).toBe(true);
      expect(c.pcbRemunerationType, 'a declared stream would drop SOCSO/EIS').toBeNull();
      // Arrears are a settled figure for months already worked; prorating would re-scale a sized debt.
      expect(c.prorates).toBe(false);
      expect(c.isNonPayable).toBe(false);
    }
  });

  // ───────────────────────── i18n ─────────────────────────

  it('every review reason and status resolves in all six locales', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '..');
    const reasons = [
      'manualOvertime',
      'overtimeDeferred',
      'hoursNotStored',
      'blendedOriginal',
      'nonMonthlyPayMode',
      'nonPayableItem',
      'noBaselineSalary',
      'unpaidLeaveInPeriod',
    ];
    for (const loc of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const msgs = JSON.parse(fs.readFileSync(path.join(root, 'messages', `${loc}.json`), 'utf8'));
      const bp = msgs.payroll?.backPay;
      expect(bp, `payroll.backPay missing from ${loc}.json`).toBeTruthy();
      for (const r of reasons) expect(bp.review?.[r], `review.${r} missing from ${loc}`).toBeTruthy();
      for (const s of ['draft', 'verified', 'posted', 'cancelled']) {
        expect(bp.status?.[s], `status.${s} missing from ${loc}`).toBeTruthy();
      }
      for (const e of ['nothingToCalculate', 'targetRunNotDraft', 'wrongStatus', 'notFound', 'unknown']) {
        expect(bp.errors?.[e], `errors.${e} missing from ${loc}`).toBeTruthy();
      }
      expect(msgs.nav?.payrollBackPay, `nav.payrollBackPay missing from ${loc}`).toBeTruthy();
    }
  });
});
