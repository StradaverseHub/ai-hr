/**
 * c11e81aa — INDIVIDUAL TRANSACTION: CHOOSE ANY CONFIGURED PAY CYCLE, AND BE PAID ON IT.
 *
 * The reported fault was that the entry form's "Pay cycle" field listed the payroll RUNS that already
 * existed for the month rather than the Pay Cycles configured under Payroll → Settings → Payroll Cycles,
 * so an entry keyed for a future month could name no cycle at all. It was saved period-keyed and stamped
 * onto the month's REGULAR run whatever the operator intended.
 *
 * THE HALF THAT MATTERS MOST IS THE ONE THAT IS NOT ON SCREEN. Offering the cycles without remembering the
 * choice would pay a "Bonus" entry on the regular run, silently. So the choice is stored
 * (`payroll_individual_txn.intended_cycle_id`, migration 0441) and `generatePayslips` reads it. This file
 * pins BOTH directions of that rule, plus the guard rails on the write:
 *
 *   1. the choice round-trips and is validated (unknown / archived / another company's / disagreeing with
 *      the run the row is already on are all REFUSALS, never silent fallbacks);
 *   2. a NULL intent — every row on production today — still belongs to the regular run and to nobody
 *      else, which is the double-collection guard the old "regular run only" rule bought outright;
 *   3. a named non-regular cycle is collected by THAT CYCLE'S OWN run — identified by
 *      `payroll_batch.payroll_cycle_id`, never by run type, because three default cycles share run_type
 *      'off_cycle' and a type match would let an Advance Salary run pay a Mid-Month row — and NOT by the
 *      regular one;
 *   4. `pendingBatchMoney` (the "what will this run pay" card) reports exactly what the run will collect,
 *      in both directions — its contract is that it cannot disagree with generatePayslips.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createAdditionalRun, createBatch, generatePayslips } from '../core/payroll';
import { setPayrollCycleActive, upsertPayrollCycle } from '../core/payroll-cycle';
import {
  createIndividualTxnsBulk,
  getIndividualTxn,
  updateIndividualTxn,
  InvalidTxnCycleError,
} from '../core/payroll-individual-txn';
import { pendingBatchMoney } from '../core/payroll-view';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

describe('c11e81aa — the Pay Cycle chosen on an Individual Transaction', () => {
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

  /** Hire one payable employee. No batch — every case here is about entry BEFORE a run exists. */
  async function hire(name = 'Cycle Pick') {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: `cyc${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    return { a, employmentId: e.employmentId };
  }

  /**
   * The company's configured catalogue. It mirrors the shape of the DEFAULT one (core/payroll-cycle.ts):
   * a regular cycle, a bonus cycle, and TWO cycles that both map to run_type 'off_cycle' — which is the
   * case that makes run-type matching unsafe and is pinned below.
   */
  async function seedCycles(companyId = base.companyId) {
    const a = adminCtx(base);
    const regular = await upsertPayrollCycle(a, { companyId, name: 'Monthly Salary', runType: 'regular', sortOrder: 1 });
    const bonus = await upsertPayrollCycle(a, { companyId, name: 'Bonus Run', runType: 'bonus', sortOrder: 2 });
    const advance = await upsertPayrollCycle(a, { companyId, name: 'Advance Salary', runType: 'off_cycle', sortOrder: 3 });
    const midMonth = await upsertPayrollCycle(a, { companyId, name: 'Mid-Month', runType: 'off_cycle', sortOrder: 4 });
    return { regular: regular.id, bonus: bonus.id, advance: advance.id, midMonth: midMonth.id };
  }

  /** The stored row, straight from the table — the column is the whole point, so it is read directly. */
  async function storedRow(id: string) {
    const [row] = await owner.db
      .select()
      .from(schema.payrollIndividualTxn)
      .where(eq(schema.payrollIndividualTxn.id, id));
    return row;
  }

  // ───────────────────── the choice is stored, and read back ─────────────────────

  it('a period-keyed save remembers the chosen cycle, and getIndividualTxn reads it back for Edit', async () => {
    const { a, employmentId } = await hire();
    const { bonus } = await seedCycles();

    const { ids } = await createIndividualTxnsBulk(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      employmentIds: [employmentId],
      rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 500 }],
      intendedCycleId: bonus,
    });

    const row = await storedRow(ids[0]);
    expect(row.batchId).toBeNull(); // no run exists yet — the point of entering early
    expect(row.intendedCycleId).toBe(bonus);

    // The Edit form prefills from this read; without the field it would silently re-default to regular.
    const detail = await getIndividualTxn(a, { id: ids[0] });
    expect(detail?.intendedCycleId).toBe(bonus);

    // The choice is on the audit record too — a reference id, no cleartext amount (ADR-0030 Layer 0).
    expect(await eventTypesFor(base.tenantId, ids[0])).toContain('payroll.individual-txn.created');
  });

  it('omitting the cycle stores NULL — byte-identical to every row keyed before this feature existed', async () => {
    const { a, employmentId } = await hire();
    await seedCycles();
    const { ids } = await createIndividualTxnsBulk(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      employmentIds: [employmentId],
      rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 100 }],
    });
    expect((await storedRow(ids[0])).intendedCycleId).toBeNull();
  });

  // ───────────────────── the write is validated, never quietly downgraded ─────────────────────

  it('an unknown, archived or cross-company cycle is REFUSED — the row is not written without it', async () => {
    const { a, employmentId } = await hire();
    const { bonus } = await seedCycles();

    const save = (intendedCycleId: string) =>
      createIndividualTxnsBulk(a, {
        companyId: base.companyId,
        payPeriod: '2026-05',
        employmentIds: [employmentId],
        rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 100 }],
        intendedCycleId,
      });

    // Unknown id.
    await expect(save('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(InvalidTxnCycleError);

    // Another company's catalogue. Cycle ids are per company; accepting one here would route this
    // company's money by another company's configuration.
    const [other] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Other Sdn Bhd' })
      .returning({ id: schema.company.id });
    const foreign = await upsertPayrollCycle(a, { companyId: other.id, name: 'Their Bonus', runType: 'bonus' });
    await expect(save(foreign.id)).rejects.toBeInstanceOf(InvalidTxnCycleError);

    // Archived: no run of it will ever be opened, so naming it would strand the money.
    await setPayrollCycleActive(a, { id: bonus, active: false });
    await expect(save(bonus)).rejects.toBeInstanceOf(InvalidTxnCycleError);

    // Nothing landed for any of the three.
    const rows = await owner.db
      .select()
      .from(schema.payrollIndividualTxn)
      .where(eq(schema.payrollIndividualTxn.employmentId, employmentId));
    expect(rows).toHaveLength(0);
  });

  it('a cycle that disagrees with the run the row targets is refused (run_mismatch), on create and on edit', async () => {
    const { a, employmentId } = await hire();
    const { regular, bonus } = await seedCycles();
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' }); // regular

    // Naming "Bonus" while targeting the REGULAR run is a contradiction, not a preference.
    await expect(
      createIndividualTxnsBulk(a, {
        batchId,
        employmentIds: [employmentId],
        rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 100 }],
        intendedCycleId: bonus,
      }),
    ).rejects.toBeInstanceOf(InvalidTxnCycleError);

    // The matching cycle is accepted on the same target.
    const { ids } = await createIndividualTxnsBulk(a, {
      batchId,
      employmentIds: [employmentId],
      rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 100 }],
      intendedCycleId: regular,
    });
    expect((await storedRow(ids[0])).intendedCycleId).toBe(regular);

    // And an EDIT cannot move an attached row onto another cycle either — that is a run move, which this
    // ledger has never done (it cannot even move a row between months).
    await expect(updateIndividualTxn(a, { id: ids[0], intendedCycleId: bonus })).rejects.toBeInstanceOf(
      InvalidTxnCycleError,
    );
  });

  it('an edit changes the cycle of a period-keyed row, and OMITTING the field leaves the stored one alone', async () => {
    const { a, employmentId } = await hire();
    const { regular, bonus } = await seedCycles();
    const { ids } = await createIndividualTxnsBulk(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      employmentIds: [employmentId],
      rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 100 }],
      intendedCycleId: bonus,
    });

    // An edit that says nothing about the cycle must not clear it — the screen omits the field entirely
    // when the company has no catalogue to offer, and that must not be read as "no cycle".
    await updateIndividualTxn(a, { id: ids[0], amount: 120 });
    expect((await storedRow(ids[0])).intendedCycleId).toBe(bonus);

    await updateIndividualTxn(a, { id: ids[0], intendedCycleId: regular });
    expect((await storedRow(ids[0])).intendedCycleId).toBe(regular);

    // Explicit null clears it: the row falls back to "the regular run may collect me".
    await updateIndividualTxn(a, { id: ids[0], intendedCycleId: null });
    expect((await storedRow(ids[0])).intendedCycleId).toBeNull();
  });

  // ───────────────────── attach-on-generate honours the choice ─────────────────────

  it('the BONUS run collects the row that named a bonus cycle, and the regular run never touches it', async () => {
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const { a, employmentId } = await hire();
    const { regular: regularCycle, bonus: bonusCycle } = await seedCycles();

    // Two rows for the same month: one marked Bonus, one marked (regular). Neither run exists yet.
    const marked = await createIndividualTxnsBulk(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      employmentIds: [employmentId],
      rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 900 }],
      intendedCycleId: bonusCycle,
    });
    const ordinary = await createIndividualTxnsBulk(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      employmentIds: [employmentId],
      rows: [{ kind: 'earning', txnDate: '2026-05-11', amount: 50 }],
      intendedCycleId: regularCycle,
    });

    // The REGULAR run is generated first — the exact order in which the old behaviour would have paid the
    // bonus entry on the wrong run.
    const { batchId: regularBatch } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: regularBatch });
    expect((await storedRow(marked.ids[0])).batchId).toBeNull(); // NOT swept up
    expect((await storedRow(ordinary.ids[0])).batchId).toBe(regularBatch);

    // Then the bonus run is opened and calculated: THAT is the run the marked row belongs to.
    const multi = await entitledCtx(base);
    const bonusRun = await createAdditionalRun(multi, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      runType: 'bonus',
      // The run NAMES the cycle it was opened under, exactly as the Payroll Process wizard now does.
      // Without it the run has no identity and collects nothing — see the last case in this file.
      payrollCycleId: bonusCycle,
    });
    await generatePayslips(multi, { batchId: bonusRun.batchId });
    expect((await storedRow(marked.ids[0])).batchId).toBe(bonusRun.batchId);
    expect(await eventTypesFor(base.tenantId, marked.ids[0])).toContain('payroll.individual-txn.attached');

    // Collected exactly once: the regular run's row did not move, and the bonus run took only its own.
    expect((await storedRow(ordinary.ids[0])).batchId).toBe(regularBatch);
  });

  it('a row that named no cycle is still the regular run’s, even when a bonus run generates first', async () => {
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const { a, employmentId } = await hire();
    const { bonus: bonusCycle } = await seedCycles(); // the catalogue exists — the row named nothing
    const { ids } = await createIndividualTxnsBulk(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      employmentIds: [employmentId],
      rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 75 }],
    });

    const { batchId: regularBatch } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const multi = await entitledCtx(base);
    const bonusRun = await createAdditionalRun(multi, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      runType: 'bonus',
      // The run NAMES the cycle it was opened under, exactly as the Payroll Process wizard now does.
      // Without it the run has no identity and collects nothing — see the last case in this file.
      payrollCycleId: bonusCycle,
    });
    await generatePayslips(multi, { batchId: bonusRun.batchId });
    expect((await storedRow(ids[0])).batchId).toBeNull(); // the bonus run leaves it alone

    await generatePayslips(a, { batchId: regularBatch });
    expect((await storedRow(ids[0])).batchId).toBe(regularBatch);
  });

  it('an archived cycle still routes the money it was chosen for — retiring a cycle must not strand a row', async () => {
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const { a, employmentId } = await hire();
    const { bonus: bonusCycle } = await seedCycles();
    const { ids } = await createIndividualTxnsBulk(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      employmentIds: [employmentId],
      rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 300 }],
      intendedCycleId: bonusCycle,
    });
    // The cycle is retired AFTER the entry was keyed. The catalogue no longer offers it; the money is
    // still owed on a bonus run.
    await setPayrollCycleActive(a, { id: bonusCycle, active: false });

    await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const multi = await entitledCtx(base);
    const bonusRun = await createAdditionalRun(multi, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      runType: 'bonus',
      // The run NAMES the cycle it was opened under, exactly as the Payroll Process wizard now does.
      // Without it the run has no identity and collects nothing — see the last case in this file.
      payrollCycleId: bonusCycle,
    });
    await generatePayslips(multi, { batchId: bonusRun.batchId });
    expect((await storedRow(ids[0])).batchId).toBe(bonusRun.batchId);
  });

  it('keying straight ONTO the Advance Salary run while naming Mid-Month is refused, not stored', async () => {
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const { a, employmentId } = await hire();
    const { advance, midMonth } = await seedCycles();
    await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const multi = await entitledCtx(base);
    const advanceRun = await createAdditionalRun(multi, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      runType: 'off_cycle',
      remarks: 'Advance Salary',
      payrollCycleId: advance,
    });

    // The ATTACHED path is the one attach-on-generate never revisits: a row written straight onto a run
    // is paid by that run, so this is the only moment the contradiction can be caught. Both cycles are
    // run_type 'off_cycle', so a type check would have let it through.
    await expect(
      createIndividualTxnsBulk(multi, {
        batchId: advanceRun.batchId,
        employmentIds: [employmentId],
        rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 100 }],
        intendedCycleId: midMonth,
      }),
    ).rejects.toBeInstanceOf(InvalidTxnCycleError);

    // The run's OWN cycle is accepted on the same target.
    const { ids } = await createIndividualTxnsBulk(multi, {
      batchId: advanceRun.batchId,
      employmentIds: [employmentId],
      rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 100 }],
      intendedCycleId: advance,
    });
    expect((await storedRow(ids[0])).intendedCycleId).toBe(advance);
  });

  // ───────────────────── run TYPE is not an identity: the three-off_cycle collision ─────────────────────

  /**
   * THE CASE THAT KILLED RUN-TYPE MATCHING. The default catalogue every company is seeded with maps THREE
   * cycles onto run_type 'off_cycle' — 'Off-cycle', 'Advance Salary' and 'Mid-Month'. Only 'regular' is
   * protected from ambiguity (one active regular cycle per company AND one regular batch per period);
   * bonus / off_cycle / adjustment have no such rule. So a run that claimed every row of its own RUN TYPE
   * would collect and pay a row the operator deliberately saved for a different cycle — silently, and
   * indistinguishably on screen from working correctly. Matching is on the CYCLE ID, and this pins it.
   */
  it('an Advance Salary run does NOT collect a row marked Mid-Month — both are run_type off_cycle', async () => {
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const { a, employmentId } = await hire();
    const { advance, midMonth } = await seedCycles();

    const mid = await createIndividualTxnsBulk(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      employmentIds: [employmentId],
      rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 400 }],
      intendedCycleId: midMonth,
    });

    await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const multi = await entitledCtx(base);
    const advanceRun = await createAdditionalRun(multi, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      runType: 'off_cycle',
      remarks: 'Advance Salary',
      payrollCycleId: advance,
    });
    await generatePayslips(multi, { batchId: advanceRun.batchId });
    // The Advance Salary run pays advances. It does not pay the mid-month entry, however alike the two
    // runs look to `run_type`.
    expect((await storedRow(mid.ids[0])).batchId).toBeNull();
    const onAdvance = await pendingBatchMoney(multi, { batchId: advanceRun.batchId });
    expect(onAdvance.lines.filter((l) => l.door === 'individualTxn')).toEqual([]);

    // The Mid-Month run, when it is opened, takes it.
    const midRun = await createAdditionalRun(multi, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      runType: 'off_cycle',
      remarks: 'Mid-Month',
      payrollCycleId: midMonth,
    });
    await generatePayslips(multi, { batchId: midRun.batchId });
    expect((await storedRow(mid.ids[0])).batchId).toBe(midRun.batchId);
  });

  it('a non-regular run that names NO cycle collects nothing — today’s behaviour, kept exactly', async () => {
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const { a, employmentId } = await hire();
    const { bonus: bonusCycle } = await seedCycles();
    const marked = await createIndividualTxnsBulk(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      employmentIds: [employmentId],
      rows: [{ kind: 'earning', txnDate: '2026-05-10', amount: 250 }],
      intendedCycleId: bonusCycle,
    });
    const unmarked = await createIndividualTxnsBulk(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      employmentIds: [employmentId],
      rows: [{ kind: 'earning', txnDate: '2026-05-11', amount: 25 }],
    });

    await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const multi = await entitledCtx(base);
    // A run opened by a caller that names no cycle — every legacy batch, and every test/script path.
    const anonymous = await createAdditionalRun(multi, { companyId: base.companyId, payPeriod: '2026-05', runType: 'bonus' });
    await generatePayslips(multi, { batchId: anonymous.batchId });
    expect((await storedRow(marked.ids[0])).batchId).toBeNull();
    expect((await storedRow(unmarked.ids[0])).batchId).toBeNull();
  });

  // ───────────────────── the pre-run card cannot disagree with the run ─────────────────────

  it('pendingBatchMoney reports the marked row against the BONUS run and not against the regular one', async () => {
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const { a, employmentId } = await hire();
    const { bonus: bonusCycle } = await seedCycles();
    await createIndividualTxnsBulk(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      employmentIds: [employmentId],
      // 'overtime' folds regardless of the payable-fold setting, so this case is about the ROUTING rule
      // and not about which entitlement flags happen to be on in this harness.
      rows: [{ kind: 'overtime', txnDate: '2026-05-10', amount: 900 }],
      intendedCycleId: bonusCycle,
    });

    const { batchId: regularBatch } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const multi = await entitledCtx(base);
    const bonusRun = await createAdditionalRun(multi, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      runType: 'bonus',
      // The run NAMES the cycle it was opened under, exactly as the Payroll Process wizard now does.
      // Without it the run has no identity and collects nothing — see the last case in this file.
      payrollCycleId: bonusCycle,
    });

    // Telling the operator the regular run will pay it would be the on-screen half of the same lie the
    // storage change exists to remove.
    const onRegular = await pendingBatchMoney(multi, { batchId: regularBatch });
    expect(onRegular.lines.filter((l) => l.door === 'individualTxn')).toEqual([]);

    const onBonus = await pendingBatchMoney(multi, { batchId: bonusRun.batchId });
    const bonusLines = onBonus.lines.filter((l) => l.door === 'individualTxn');
    expect(bonusLines).toHaveLength(1);
    expect(bonusLines[0]).toMatchObject({ amount: 900, note: 'unattached' });
  });
});
