/**
 * r226 — AN ADDITIONAL RUN PROCESSES ONLY THE PEOPLE IT HAS SOMETHING TO DO FOR.
 *
 * THE REPORTED FAULT. A Bonus / Off-cycle / Adjustment run processed EVERY employee of the company, so a
 * run where five people had a bonus wrote forty-five payslips, forty of them entirely zero — noise around
 * the five results that mattered, and forty payroll records that say nothing.
 *
 * WHAT THIS FILE PINS, and every one of the four is a way the change could have gone wrong:
 *
 *   1. THE SKIP. An additional run leaves out an employee it has nothing to pay in that cycle, names every
 *      one of them, and reports skipped as its OWN outcome — never as a failure.
 *   2. THE REGULAR RUN IS UNTOUCHED, which is the single most important limit on the whole change. A
 *      salaried employee has ZERO rows in the transaction tables; their money is the compensation record.
 *      "Skip anyone with no transaction" applied to a regular run would stop paying almost the company.
 *   3. THE MONEY. A skipped employee's one-off transaction is not attached to the run that skipped them,
 *      is not stamped CONSUMED by it, and is still paid by the run it belongs to. This is the sharp half:
 *      `markIndividualTxnsConsumed` is keyed off `emps`, so a skip implemented anywhere other than by
 *      narrowing `emps` would have marked their money used up by a run that never paid it — the amount
 *      would then vanish with no payslip anywhere and no error.
 *   4. THE COUNTS. `payroll_batch.employee_count`, the returned `payslips` and the run-group's
 *      `totalEmployeesFailed` all move to the number of payslips WRITTEN, so a skip cannot render red.
 *
 * The `entitledCtx` discipline is the one every multi-cycle test in this suite follows: the module grants
 * are written BEFORE the context is built (a snapshot is point-in-time) and the context is `entitledCtx`,
 * not `adminCtx`, whose snapshot is synthesised from the env and would read every grant off.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  createAdditionalRun,
  createBatch,
  generatePayslips,
  paysOnAdditionalRun,
  type AdditionalRunPayRow,
} from '../core/payroll';
import { summarize, type CompanyOutcome } from '../core/payroll-run-group';
import { createIndividualTxnsBulk } from '../core/payroll-individual-txn';
import { seedPayComponentCatalog, setPayrollBatchComponent } from '../core/pay-components';
import {
  closeAll,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  setSetting,
  type Base,
} from './harness';

let base: Base;

/** Every gate this feature lives behind, granted BEFORE the snapshot is taken. */
const runCtx = async () => {
  await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
  await setModule(base.tenantId, 'typed_pay_components', 'active');
  await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', true);
  return entitledCtx(base);
};

const hire = async (a: Awaited<ReturnType<typeof entitledCtx>>, name: string, ic: string) => {
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@skip.test` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
  return e;
};

/** The full draft→processed generation's own guards, copied from `runMultiCompanyPayroll` — the return
 *  type is a union with the subset-reprocess shape, which carries neither key. */
const skippedOf = (g: Awaited<ReturnType<typeof generatePayslips>>) =>
  'skipped' in g && Array.isArray(g.skipped) ? g.skipped : [];
const payslipsOf = (g: Awaited<ReturnType<typeof generatePayslips>>) =>
  'payslips' in g && typeof g.payslips === 'number' ? g.payslips : -1;

const slipsOn = (batchId: string) =>
  owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));

const batchRow = async (batchId: string) => {
  const [row] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
  return row;
};

const txnRow = async (id: string) => {
  const [row] = await owner.db
    .select()
    .from(schema.payrollIndividualTxn)
    .where(eq(schema.payrollIndividualTxn.id, id));
  return row;
};

const componentId = async (code: string) => {
  const [row] = await owner.db
    .select({ id: schema.payComponent.id })
    .from(schema.payComponent)
    .where(eq(schema.payComponent.code, code))
    .limit(1);
  if (!row) throw new Error(`pay component ${code} not seeded`);
  return row.id;
};

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

// ─────────────────────── 1. the routing rule, on its own ───────────────────────

describe('r226 — paysOnAdditionalRun: does one pay item reach the bucket an additional run pays?', () => {
  const row = (over: Partial<AdditionalRunPayRow> = {}): AdditionalRunPayRow => ({
    code: 'X',
    kind: 'allowance',
    amount: 100,
    nonPayable: false,
    epf: true,
    socso: false, // epf && !socso ⇒ the legacy flag inference routes it to the bonus bucket
    epfBonus2012: false,
    pcbRemunerationType: null,
    rule: null,
    ...over,
  });

  it('the bonus bucket: declared additional, epfBonus2012, or the epf-and-not-socso inference', () => {
    expect(paysOnAdditionalRun(row())).toBe(true); // inference
    expect(paysOnAdditionalRun(row({ pcbRemunerationType: 'additional', epf: false, socso: true }))).toBe(true);
    expect(paysOnAdditionalRun(row({ epfBonus2012: true, socso: true }))).toBe(true);
  });

  it('everything an additional run zeroes is NOT the bonus bucket', () => {
    // The Y1 wage box — `slipAllowance` is forced to 0 on an additional run.
    expect(paysOnAdditionalRun(row({ pcbRemunerationType: 'normal' }))).toBe(false);
    expect(paysOnAdditionalRun(row({ socso: true }))).toBe(false); // epf && socso ⇒ wage
    // The OT box (not epf, yes socso) — `slipOvertime` is forced to 0.
    expect(paysOnAdditionalRun(row({ epf: false, socso: true }))).toBe(false);
    // Paid-but-untaxed reimbursement rides the allowance line, also zeroed.
    expect(paysOnAdditionalRun(row({ epf: false, socso: false }))).toBe(false);
    // A deduction never reaches gross, and `rawManual` is 0 on an additional run.
    expect(paysOnAdditionalRun(row({ kind: 'deduction' }))).toBe(false);
    // An optional deduction feeds LP₁, which an additional run drops.
    expect(paysOnAdditionalRun(row({ pcbRemunerationType: 'optional_deduction' }))).toBe(false);
    // BASIC is inert in the engine; a BIK is a record line and never cash.
    expect(paysOnAdditionalRun(row({ code: 'BASIC' }))).toBe(false);
    expect(paysOnAdditionalRun(row({ nonPayable: true }))).toBe(false);
    // A zero amount is not a transaction.
    expect(paysOnAdditionalRun(row({ amount: 0 }))).toBe(false);
  });

  it('THE BIAS IS ONE-WAY: an item whose amount comes from a RULE counts as paying', () => {
    // The rule is resolved later, against a scope this predicate does not build. A false "pays" costs one
    // zero payslip; a false "pays nothing" costs somebody their money, so the doubt resolves to paying.
    expect(paysOnAdditionalRun(row({ amount: 0, rule: { kind: 'per_day', rate: 50 } }))).toBe(true);
  });
});

// ─────────────────────── 2. skipped is counted apart from failed ───────────────────────

describe('r226 — summarize: skipped is its own outcome, never a failure', () => {
  it('subtracts the skipped out of totalEmployeesFailed', () => {
    const per: CompanyOutcome[] = [
      {
        companyId: 'a',
        companyName: 'A',
        status: 'succeeded',
        batchId: 'ba',
        employeesSelected: 45,
        employeesSucceeded: 5,
        employeesSkipped: Array.from({ length: 40 }, (_, i) => ({
          employmentId: `e${i}`,
          name: `E${i}`,
          employeeCode: null,
          reason: 'NO_TRANSACTION_FOR_CYCLE' as const,
        })),
      },
    ];
    const r = summarize('2026-05', 's', 'e', per);
    expect(r.totalEmployeesSelected).toBe(45);
    expect(r.totalEmployeesSucceeded).toBe(5);
    expect(r.totalEmployeesSkipped).toBe(40);
    // THE POINT: without the subtraction this reads 40 and the result page renders forty correct
    // decisions as forty failures.
    expect(r.totalEmployeesFailed).toBe(0);
    expect(r.overallStatus).toBe('succeeded');
  });

  it('a run that skipped nobody is arithmetically unchanged', () => {
    const r = summarize('2026-05', 's', 'e', [
      { companyId: 'a', companyName: 'A', status: 'succeeded', batchId: 'ba', employeesSelected: 3, employeesSucceeded: 2 },
      { companyId: 'b', companyName: 'B', status: 'failed', employeesSelected: 4, employeesSucceeded: 0, reason: 'PERIOD_ALREADY_PROCESSED' },
    ]);
    expect(r.totalEmployeesSkipped).toBe(0);
    expect(r.totalEmployeesFailed).toBe(5);
  });
});

// ─────────────────────── 3. the kernel ───────────────────────

describe('r226 — the additional run itself', () => {
  it('processes only the employee with a bonus, and NAMES the two it left out', async () => {
    const a = await runCtx();
    await seedPayComponentCatalog(a);
    const paid = await hire(a, 'Bee Paid', '900101010001');
    const idleA = await hire(a, 'Ada Idle', '900101010002');
    const idleB = await hire(a, 'Zed Idle', '900101010003');

    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const regGen = await generatePayslips(a, { batchId: reg.batchId });
    // THE LIMIT THAT MATTERS MOST: on the regular run nobody has a transaction of any kind, and all three
    // are paid. A predicate that reached this run would have paid one employee out of three.
    expect(await slipsOn(reg.batchId)).toHaveLength(3);
    expect(skippedOf(regGen)).toEqual([]);
    expect((await batchRow(reg.batchId)).employeeCount).toBe(3);

    const bonus = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-05', runType: 'bonus' });
    await setPayrollBatchComponent(a, {
      batchId: bonus.batchId,
      employmentId: paid.employmentId,
      componentId: await componentId('BONUS'),
      amount: 1000,
    });
    const gen = await generatePayslips(a, { batchId: bonus.batchId });

    const slips = await slipsOn(bonus.batchId);
    expect(slips).toHaveLength(1);
    expect(slips[0].employmentId).toBe(paid.employmentId);
    expect(Number(slips[0].bonus)).toBeCloseTo(1000, 2);

    // Named, in name order, with the reason the result screen prints.
    const skipped = skippedOf(gen);
    expect(skipped.map((s) => s.name)).toEqual(['Ada Idle', 'Zed Idle']);
    expect(skipped.map((s) => s.employmentId).sort()).toEqual([idleA.employmentId, idleB.employmentId].sort());
    for (const s of skipped) expect(s.reason).toBe('NO_TRANSACTION_FOR_CYCLE');

    // The counts are the PAYSLIP count, not the selected count — on the returned value and on the row the
    // dashboard and the timeline read.
    expect(payslipsOf(gen)).toBe(1);
    expect((await batchRow(bonus.batchId)).employeeCount).toBe(1);
  });

  it('MONEY-SAFETY: a skipped employee’s one-off is neither attached nor consumed, and the regular run still pays it', async () => {
    const a = await runCtx();
    await seedPayComponentCatalog(a);
    const paid = await hire(a, 'Bee Bonus', '900101010011');
    const waiting = await hire(a, 'Wai Ting', '900101010012');

    // `waiting` has RM300 keyed for the month with NO cycle named — every row on production today. It
    // belongs to the month's REGULAR run and to nobody else. `paid` has a bonus on the bonus run.
    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });
    const { ids } = await createIndividualTxnsBulk(a, {
      companyId: base.companyId,
      payPeriod: '2026-06',
      employmentIds: [waiting.employmentId],
      rows: [{ kind: 'earning', txnDate: '2026-06-10', amount: 300 }],
    });
    expect((await txnRow(ids[0])).batchId).toBeNull();

    const bonus = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-06', runType: 'bonus' });
    await setPayrollBatchComponent(a, {
      batchId: bonus.batchId,
      employmentId: paid.employmentId,
      componentId: await componentId('BONUS'),
      amount: 800,
    });
    const gen = await generatePayslips(a, { batchId: bonus.batchId });

    // Skipped — and the RM300 is exactly where it was. THIS is the assertion the whole change turns on:
    // stamping `consumed_batch_id` here would take the money out of every future run's fold, with no
    // payslip anywhere carrying it and nothing on any screen saying so.
    expect(skippedOf(gen).map((r) => r.employmentId)).toEqual([waiting.employmentId]);
    const afterBonus = await txnRow(ids[0]);
    expect(afterBonus.batchId).toBeNull();
    expect(afterBonus.consumedBatchId).toBeNull();
    expect(
      (await slipsOn(bonus.batchId)).map((s) => s.employmentId),
      'the skipped employee has no payslip on the run that skipped them',
    ).toEqual([paid.employmentId]);

    // …and the run it belongs to pays it: attached to the regular run and consumed BY that run.
    await generatePayslips(a, { batchId: reg.batchId });
    const afterRegular = await txnRow(ids[0]);
    expect(afterRegular.batchId).toBe(reg.batchId);
    expect(afterRegular.consumedBatchId).toBe(reg.batchId);
  });

  it('a keyed transaction the run will NOT pay still keeps its owner in the run — the reason must be true', async () => {
    // An uncomponented one-off EARNING is routed to the Y1 wage bucket, which an additional run forces to
    // 0 — so this run pays nothing for `keyed`. It must still be processed: reporting "No transaction
    // entry for this payroll cycle" beside a transaction the operator can see on the screen they keyed it
    // on reads as the system having lost their entry, which is worse than the zero payslip. The bias
    // points at processing.
    const a = await runCtx();
    await seedPayComponentCatalog(a);
    const keyed = await hire(a, 'Kay Keyed', '900101010021');
    const idle = await hire(a, 'Ivy Idle', '900101010022');

    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-07' });
    await generatePayslips(a, { batchId: reg.batchId });

    const bonus = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-07', runType: 'bonus' });
    await createIndividualTxnsBulk(a, {
      batchId: bonus.batchId,
      employmentIds: [keyed.employmentId],
      rows: [{ kind: 'earning', txnDate: '2026-07-10', amount: 250 }],
    });
    const gen = await generatePayslips(a, { batchId: bonus.batchId });

    expect(skippedOf(gen).map((r) => r.employmentId)).toEqual([idle.employmentId]);
    expect((await slipsOn(bonus.batchId)).map((s) => s.employmentId)).toEqual([keyed.employmentId]);
  });
});
