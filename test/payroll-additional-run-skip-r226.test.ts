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
 *   2. THE REGULAR RUN IS UNTOUCHED BY *THIS* PREDICATE, which is the single most important limit on the
 *      whole change. A salaried employee has ZERO rows in the transaction tables; their money is the
 *      compensation record. "Skip anyone with no transaction" applied to a regular run would stop paying
 *      almost the company, and the fixtures below still prove it does not.
 *      ⚠️ r369 (item eb949191) ADDED A STRICTLY NARROWER REGULAR-RUN PREDICATE, and the sentence above used
 *      to read "THE REGULAR RUN IS UNTOUCHED" flat. A regular run now skips an employee whose SALARY RECORD
 *      pays nothing AND who has no positive money on any door — the conjunct r226 was right to say is what
 *      makes it safe. Nothing in this file's predicate or its expectations changed; the regular-run cases
 *      (including the negative-net payslip the skip prevents) live in test/r369-zero-basic-skip.test.ts.
 *   3. THE MONEY. A skipped employee's one-off transaction is not attached to the run that skipped them,
 *      is not stamped CONSUMED by it, and is still paid by the run it belongs to. This is the sharp half:
 *      `markIndividualTxnsConsumed` is keyed off `emps`, so a skip implemented anywhere other than by
 *      narrowing `emps` would have marked their money used up by a run that never paid it — the amount
 *      would then vanish with no payslip anywhere and no error.
 *   4. THE COUNTS. `payroll_batch.employee_count`, the returned `payslips` and the run-group's
 *      `totalEmployeesFailed` all move to the number of payslips WRITTEN, so a skip cannot render red.
 *
 * r227 ADDS THE THREE THINGS THAT STOPPED r226 SHIPPING, and each is a way the SHIPPED feature broke
 * rather than a way the change could have:
 *
 *   5. THE RESULT SCREEN SURVIVES ITS OWN FEATURE. The skipped list was carried by value in the result
 *      page's query string, taking it from O(companies) to O(headcount) — it stopped loading at around
 *      seventy skipped employees, after the payroll had committed, on exactly the runs the skip exists
 *      for. The redirect now carries a count and the names come from the durable event.
 *   6. THE REASON IS TRUE OF THE PERSON IT IS PRINTED BESIDE. "No transaction entry for this payroll
 *      cycle" was printed about people the DRAFT screen lists as having money waiting. Pinned here
 *      against `pendingBatchMoney` itself, so the two screens cannot drift apart again.
 *   7. THE FAIL-CLOSED GUARD STILL FIRES. `UnsupportedPayComponentError` is thrown from inside the
 *      per-employee loop, which no longer runs for a skipped employee — and the unsupported shapes are
 *      exactly the shapes that get skipped, so the skip hid it in every case it can occur.
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
  UnsupportedPayComponentError,
  createAdditionalRun,
  createBatch,
  generatePayslips,
  paysOnAdditionalRun,
  type AdditionalRunPayRow,
} from '../core/payroll';
import { encodeRunGroupResult, summarize, type CompanyOutcome } from '../core/payroll-run-group';
import { createIndividualTxnsBulk } from '../core/payroll-individual-txn';
import { listSkippedEmployees, pendingBatchMoney } from '../core/payroll-view';
import { seedPayComponentCatalog, setEmploymentPayComponent, setPayrollBatchComponent } from '../core/pay-components';
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
    // r227 UPDATED THE SHAPE, NOT THE RULE. `employeesSkipped` was a list of forty named employees and
    // is now their COUNT — see the payload-size case below for why. The arithmetic this case exists to
    // pin (skipped comes OUT of failed, so forty correct decisions never render red) is unchanged, and
    // is asserted on exactly the same numbers.
    const per: CompanyOutcome[] = [
      {
        companyId: 'a',
        companyName: 'A',
        status: 'succeeded',
        batchId: 'ba',
        employeesSelected: 45,
        employeesSucceeded: 5,
        employeesSkipped: 40,
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
    // HOUSING because `runCtx` turns payroll.individual_txn_pay_enabled ON, and a NEW payable row keyed
    // under that flag MUST carry a component (assertTxnComponents / ComponentRequiredError). It is also
    // the right pick rather than merely a legal one: HOUSING is EPF+SOCSO ⇒ the normal WAGE bucket, which
    // an additional run zeroes, so the bonus run still has nothing to pay `waiting` and still skips them.
    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });
    const { ids } = await createIndividualTxnsBulk(a, {
      companyId: base.companyId,
      payPeriod: '2026-06',
      employmentIds: [waiting.employmentId],
      rows: [{ kind: 'earning', txnDate: '2026-06-10', amount: 300, componentId: await componentId('HOUSING') }],
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
    // A one-off EARNING on the Y1 wage bucket is forced to 0 by an additional run — so this run pays
    // nothing for `keyed`. It must still be processed: reporting "No transaction entry for this payroll
    // cycle" beside a transaction the operator can see on the screen they keyed it on reads as the system
    // having lost their entry, which is worse than the zero payslip. The bias points at processing.
    //
    // The bucket is reached with HOUSING (EPF+SOCSO ⇒ wage bucket — the same pick, and the same stated
    // reason, as the standing-pay test below), NOT by leaving the row componentless. `runCtx` turns
    // payroll.individual_txn_pay_enabled ON, and under that flag a componentless payable row cannot be
    // created at all: assertTxnComponents throws ComponentRequiredError on every create path. Componentless
    // rows survive on production only as LEGACY rows keyed before the flag, which is a different fixture
    // from the one this test needs. What is under test — a transaction the run will not pay must keep its
    // owner in the run — is unchanged, and is now reached through a shape a tenant can actually key today.
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
      rows: [{ kind: 'earning', txnDate: '2026-07-10', amount: 250, componentId: await componentId('HOUSING') }],
    });
    const gen = await generatePayslips(a, { batchId: bonus.batchId });

    expect(skippedOf(gen).map((r) => r.employmentId)).toEqual([idle.employmentId]);
    expect((await slipsOn(bonus.batchId)).map((s) => s.employmentId)).toEqual([keyed.employmentId]);
  });
});

// ─────────────────────── 4. r227 — the result payload stays O(companies) ───────────────────────

/**
 * THE DEFECT THIS PINS, IN ONE SENTENCE: the result screen broke on exactly the runs the skip was built
 * for, and it broke AFTER the payroll had been committed.
 *
 * `encodeRunGroupResult` JSON-encodes the whole run outcome into the Step-3 page's query string. r226 put
 * the named skipped employees inside it, which took a payload that had always been O(companies) to
 * O(HEADCOUNT). Measured on the r226 shape: 40 skipped = 9,298 bytes, 80 = 18,018, 245 = 54,136 — against
 * the 16,384-byte header budget Node defaults to (deploy/aihr.service:29 runs `next start` with no
 * `--max-http-header-size`), shared with the request line and the session cookies, behind a cloudflared
 * tunnel with a similar cap. A 250-person company running a bonus for five lost the whole result screen.
 *
 * A byte budget alone would be a weak guard — it would pass again the moment somebody put a short field
 * per employee back. So the load-bearing assertion is the SHAPE one: the encoding must not grow with the
 * number of people skipped at all, beyond the digits of the count itself.
 */
describe('r227 — the result payload does not grow with the number of people skipped', () => {
  const company = (skipped: number, i = 0): CompanyOutcome => ({
    companyId: `c${i}`,
    companyName: `Company Number ${i} Sdn Bhd`,
    status: 'succeeded',
    batchId: `b${i}`,
    employeesSelected: 250,
    employeesSucceeded: 250 - skipped,
    employeesSkipped: skipped,
  });
  const encoded = (skipped: number, companies = 1) =>
    encodeRunGroupResult(
      summarize('2026-05', '2026-05-01T00:00:00.000Z', '2026-05-01T00:01:00.000Z',
        Array.from({ length: companies }, (_, i) => company(skipped, i))),
    );

  it('245 skipped encodes to the same size as 40, give or take the digits of the count', () => {
    const at40 = encoded(40);
    const at245 = encoded(245);
    // 245-40 = 205 more people and at most one more digit in two numbers (the per-company count and the
    // run total). Anything larger means somebody has put a per-employee field back on the payload.
    expect(at245.length - at40.length).toBeLessThanOrEqual(2);
    // …and the absolute figure, against the budget that actually broke. The whole encoded string for a
    // NINE-company run — every one of them skipping 245 — has to fit inside a header shared with the
    // request line and the session cookies.
    expect(encoded(245, 9).length).toBeLessThan(4000);
  });

  it('decodes to the same counts it was given, so the stat on the screen is still the run’s own', () => {
    const r = summarize('2026-05', 's', 'e', [company(40), company(5, 1)]);
    expect(r.totalEmployeesSkipped).toBe(45);
    expect(r.totalEmployeesFailed).toBe(500 - 210 - 245 - 45);
    expect(JSON.parse(decodeURIComponent(encodeRunGroupResult(r))).totalEmployeesSkipped).toBe(45);
  });
});

// ─────────────── 5. r227 — the reason printed beside a name has to be true of them ───────────────

describe('r227 — the skip reason cannot contradict the draft screen', () => {
  /**
   * THE FALSE SENTENCE, END TO END. An employee whose only pending money is a standing monthly HOUSING
   * allowance appears on the draft run's "what will this run pay" card BY NAME. An additional run does
   * not pay a standing allowance (it lands in the allowance line the run forces to 0), so the employee
   * is correctly skipped — but r226 then printed "No transaction entry for this payroll cycle" beside
   * them, contradicting the screen the operator had just read on the same run.
   *
   * Both halves are asserted in ONE test on purpose. The defect lives in the CONTRACT BETWEEN the card
   * and the kernel; a test of either half alone passes throughout, which is how it shipped.
   */
  it('names the standing-pay reason, and the draft card lists that same person', async () => {
    const a = await runCtx();
    await seedPayComponentCatalog(a);
    const standing = await hire(a, 'Ada Standing', '900101010031');
    const nothing = await hire(a, 'Nil Nothing', '900101010032');
    const paid = await hire(a, 'Bee Paid', '900101010033');

    // HOUSING is EPF + SOCSO ⇒ the normal WAGE bucket, which an additional run zeroes. It is the exact
    // shape of the reported case: standing money the operator can see, that this run will not pay.
    await setEmploymentPayComponent(a, {
      employmentId: standing.employmentId,
      componentId: await componentId('HOUSING'),
      amount: 400,
      effectiveFrom: '2024-01-01',
    });

    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-08' });
    await generatePayslips(a, { batchId: reg.batchId });

    const bonus = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-08', runType: 'bonus' });
    await setPayrollBatchComponent(a, {
      batchId: bonus.batchId,
      employmentId: paid.employmentId,
      componentId: await componentId('BONUS'),
      amount: 900,
    });

    // HALF ONE — the draft card, read BEFORE the run, names `standing` as having money waiting.
    const card = await pendingBatchMoney(a, { batchId: bonus.batchId });
    const carded = card.lines.filter((l) => l.employmentId === standing.employmentId);
    expect(carded.map((l) => l.door)).toContain('fixedComponent');
    expect(carded.some((l) => Math.abs(l.amount) === 400)).toBe(true);

    // HALF TWO — the run skips them, which is right, and says something TRUE about them, which is the fix.
    const gen = await generatePayslips(a, { batchId: bonus.batchId });
    const byId = new Map(skippedOf(gen).map((r) => [r.employmentId, r]));
    expect([...byId.keys()].sort()).toEqual([standing.employmentId, nothing.employmentId].sort());
    expect(byId.get(standing.employmentId)!.reason).toBe('NO_ADDITIONAL_PAY_THIS_RUN');
    // …and the ORIGINAL reason is still used for the person it is actually true of. The half of the old
    // behaviour that was never wrong stays exercised.
    expect(byId.get(nothing.employmentId)!.reason).toBe('NO_TRANSACTION_FOR_CYCLE');
    expect((await slipsOn(bonus.batchId)).map((s) => s.employmentId)).toEqual([paid.employmentId]);
  });

  it('a standing item that IS additional remuneration keeps its owner in the run, not merely re-labelled', async () => {
    // The reverse direction, and the one that would cost somebody money if the fix had been written as a
    // relabelling of every recurring holder: a recurring BONUS-bucket item (EPF, not SOCSO) is money this
    // run DOES pay, so its owner must be PROCESSED — never skipped under either reason.
    const a = await runCtx();
    await seedPayComponentCatalog(a);
    const bonusStanding = await hire(a, 'Cee Standing', '900101010041');
    const nothing = await hire(a, 'Dee Nothing', '900101010042');

    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-09' });
    await generatePayslips(a, { batchId: reg.batchId });
    await setEmploymentPayComponent(a, {
      employmentId: bonusStanding.employmentId,
      componentId: await componentId('BONUS'),
      amount: 500,
      effectiveFrom: '2024-01-01',
    });

    const extra = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-09', runType: 'bonus' });
    const gen = await generatePayslips(a, { batchId: extra.batchId });
    expect(skippedOf(gen).map((r) => r.employmentId)).toEqual([nothing.employmentId]);
    expect((await slipsOn(extra.batchId)).map((s) => s.employmentId)).toEqual([bonusStanding.employmentId]);
  });
});

// ─────────────── 6. r227 — the fail-closed guard the skip was swallowing ───────────────

describe('r227 — a misconfigured pay item still stops the run', () => {
  /**
   * `UnsupportedPayComponentError` (ADR-0025 §5) refuses to write a payslip for a pay item v1 cannot tax
   * correctly. It is thrown from inside the per-employee component loop — which, after r226, does not run
   * for a skipped employee. And this is not a partial hole: the two unsupported shapes (a PCB-taxable
   * non-payable, and a PCB-only earning that is neither EPF nor SOCSO) are precisely the shapes
   * `paysOnAdditionalRun` answers "pays nothing" for, so the skip hid the error in EVERY case it occurs.
   * A run that used to refuse to process would instead have processed everybody else and quietly left the
   * misconfigured employee out — reported as a routine skip.
   */
  const unsupportedComponentId = async (code: string) => {
    const [row] = await owner.db
      .insert(schema.payComponent)
      .values({
        tenantId: base.tenantId,
        code,
        name: 'Taxable benefit in kind',
        kind: 'non_payable',
        includedInEpf: false,
        includedInSocsoEis: false,
        includedInPcb: true, // PCB-taxable…
        includedInHrdfBase: false,
        isNonPayable: true, // …and non-payable ⇒ v1 cannot compute it. No declared remuneration type.
        prorates: false,
      })
      .returning({ id: schema.payComponent.id });
    return row.id;
  };

  it('throws for an employee the additional run would otherwise have skipped', async () => {
    const a = await runCtx();
    await seedPayComponentCatalog(a);
    const bad = await hire(a, 'Mis Configured', '900101010051');
    const paid = await hire(a, 'Bee Paid', '900101010052');

    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-10' });
    await generatePayslips(a, { batchId: reg.batchId });

    await setEmploymentPayComponent(a, {
      employmentId: bad.employmentId,
      componentId: await unsupportedComponentId('BIK_TAXABLE'),
      amount: 250,
      effectiveFrom: '2024-01-01',
    });

    const bonus = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-10', runType: 'bonus' });
    await setPayrollBatchComponent(a, {
      batchId: bonus.batchId,
      employmentId: paid.employmentId,
      componentId: await componentId('BONUS'),
      amount: 700,
    });

    await expect(generatePayslips(a, { batchId: bonus.batchId })).rejects.toBeInstanceOf(
      UnsupportedPayComponentError,
    );
    // Fail-closed means NOTHING was written, not "written for everybody else".
    expect(await slipsOn(bonus.batchId)).toHaveLength(0);
    expect((await batchRow(bonus.batchId)).status).toBe('draft');
  });
});

// ─────────────── 7. r227 — the names come off the durable record, not the redirect ───────────────

describe('r227 — listSkippedEmployees reads the run’s own event', () => {
  it('names everyone the run skipped, with the reason the kernel chose, after the request that ran it', async () => {
    const a = await runCtx();
    await seedPayComponentCatalog(a);
    const paid = await hire(a, 'Bee Paid', '900101010061');
    const standing = await hire(a, 'Ada Standing', '900101010062');
    const nothing = await hire(a, 'Zed Nothing', '900101010063');
    await setEmploymentPayComponent(a, {
      employmentId: standing.employmentId,
      componentId: await componentId('HOUSING'),
      amount: 300,
      effectiveFrom: '2024-01-01',
    });

    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-11' });
    await generatePayslips(a, { batchId: reg.batchId });
    const bonus = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-11', runType: 'bonus' });
    await setPayrollBatchComponent(a, {
      batchId: bonus.batchId,
      employmentId: paid.employmentId,
      componentId: await componentId('BONUS'),
      amount: 1200,
    });
    await generatePayslips(a, { batchId: bonus.batchId });

    // Read as a LATER request would read it — nothing carried over from the generate call.
    const rows = await listSkippedEmployees(a, [bonus.batchId]);
    expect(rows.map((r) => r.name)).toEqual(['Ada Standing', 'Zed Nothing']);
    expect(rows.map((r) => r.reason)).toEqual(['NO_ADDITIONAL_PAY_THIS_RUN', 'NO_TRANSACTION_FOR_CYCLE']);
    expect(rows.map((r) => r.employmentId).sort()).toEqual(
      [standing.employmentId, nothing.employmentId].sort(),
    );
    expect(rows.every((r) => r.batchId === bonus.batchId)).toBe(true);

    // A run that skipped nobody contributes nothing, and an unknown batch is not an error.
    expect(await listSkippedEmployees(a, [reg.batchId])).toEqual([]);
    expect(await listSkippedEmployees(a, [])).toEqual([]);
  });
});
