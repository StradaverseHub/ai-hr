/**
 * 49e7e0a2 — editing a one-off transaction AFTER the payroll run has been processed.
 *
 * WHY THE OLD RULE HAD TO GO, AND WHY THIS IS NOT SIMPLY AN UNLOCK. Writes to `payroll_individual_txn`
 * used to require a DRAFT run. Measured on production 2026-08-05, all 21 payroll runs sit at `processed`
 * and there is not one draft and not one closed run — so the draft-only window is never open, and the
 * only route to a correction was resetting the whole run.
 *
 * But by the time a run is processed the payslips exist, EPF/SOCSO/EIS/PCB/HRDF have moved, loan balances
 * have advanced, claims are marked paid, and the bank file and statutory returns are exportable — and
 * one-off transactions feed all of it. So the window is only safe because every write onto a processed run
 * MARKS it: `payroll_batch.needs_recalc_at` plus the exact employments to recalculate, and `closeBatch`
 * refuses while the mark is set. That is what these tests pin — not "the edit is allowed", which on its
 * own would be the bug.
 *
 * WHAT THESE TESTS DELIBERATELY DO NOT ASSERT. Nothing here claims an edit RECALCULATES anything by
 * itself. It does not: the recalculation is the existing selective reprocess (generatePayslips with
 * `reprocessSubset`), run by an operator, versioned and reason-carrying. The mark is what makes skipping
 * it impossible to do silently, and the clear-on-reprocess test below is where the two meet.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  BatchNeedsRecalculationError,
  closeBatch,
  createBatch,
  generatePayslips,
  resetProcessedBatch,
} from '../core/payroll';
import {
  createIndividualTxn,
  createIndividualTxnsBulk,
  deleteIndividualTxn,
  getIndividualTxn,
  updateIndividualTxn,
} from '../core/payroll-individual-txn';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, setSetting, type Base } from './harness';

describe('49e7e0a2 — one-off transactions are editable after processing, and say so', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    // Kernel consumption stays OFF, matching the sibling ledger suite's baseline. It is irrelevant to
    // every assertion here: the mark is written by the LEDGER on a processed run, whatever the kernel
    // does with the row afterwards. Written out rather than assumed, because seedBase writes a platform
    // row of TRUE on any box whose env carries INDIVIDUAL_TXN_PAY_ENABLED.
    await setSetting(base.tenantId, 'payroll.individual_txn_pay_enabled', false);
  });
  afterAll(async () => {
    await closeAll();
  });

  /** One employee with comp + statutory profile, and a draft run for the period. */
  async function hireWithBatch(period = '2026-05') {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Edit After', primaryEmail: `edit${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: period });
    return { a, personId: e.personId, employmentId: e.employmentId, batchId };
  }

  /** The batch row as stored — read as OWNER so the assertion cannot be shaped by an RLS accident. */
  async function batchRow(batchId: string) {
    const [row] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    return row;
  }

  // ───────────────────── the window is open, and it leaves a mark ─────────────────────

  it('an UPDATE on a processed run succeeds, stamps updated_at, and marks the run for that employee', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const { id } = await createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 50 });
    await generatePayslips(a, { batchId });
    expect((await batchRow(batchId)).status).toBe('processed');
    // Nothing has changed yet, so the run must NOT be claiming staleness.
    expect((await batchRow(batchId)).needsRecalcAt).toBeNull();

    await expect(updateIndividualTxn(a, { id, amount: 60 })).resolves.toMatchObject({ id });

    const [txn] = await owner.db
      .select()
      .from(schema.payrollIndividualTxn)
      .where(eq(schema.payrollIndividualTxn.id, id));
    expect(Number(txn.amount)).toBe(60);
    // The one detector that existed (arrivedAfterProcessing) is max(created_at) > processedAt and is
    // blind to exactly this: a row keyed BEFORE processing and changed after it. updated_at is what
    // makes the change visible at all.
    expect(txn.updatedAt).not.toBeNull();

    const marked = await batchRow(batchId);
    expect(marked.needsRecalcAt).not.toBeNull();
    expect(marked.recalcEmploymentIds).toEqual([employmentId]);
  });

  it('a CREATE on a processed run succeeds and marks it; a DELETE does too', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    await generatePayslips(a, { batchId });

    const { id } = await createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-11', amount: 25 });
    expect((await batchRow(batchId)).recalcEmploymentIds).toEqual([employmentId]);

    // Clear it by hand so the delete's own mark is proven rather than inherited from the create above.
    await owner.db
      .update(schema.payrollBatch)
      .set({ needsRecalcAt: null, recalcEmploymentIds: null })
      .where(eq(schema.payrollBatch.id, batchId));

    await expect(deleteIndividualTxn(a, { id })).resolves.toMatchObject({ id });
    const marked = await batchRow(batchId);
    expect(marked.needsRecalcAt).not.toBeNull();
    expect(marked.recalcEmploymentIds).toEqual([employmentId]);
  });

  it('a BULK save onto a processed run marks it ONCE, naming every payee it touched', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    await generatePayslips(a, { batchId });

    await createIndividualTxnsBulk(a, {
      batchId,
      employmentIds: [employmentId],
      rows: [
        { kind: 'earning', txnDate: '2026-05-10', amount: 10 },
        { kind: 'earning', txnDate: '2026-05-11', amount: 20 },
      ],
    });

    expect((await batchRow(batchId)).recalcEmploymentIds).toEqual([employmentId]);
    // Two rows, ONE statement about the run — the mark describes the run, not each write.
    const events = await owner.db
      .select({ t: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'payroll-batch.recalc-required'));
    expect(events).toHaveLength(1);
  });

  it('a DRAFT run is never marked — it has no payslips, so nothing on it can be stale', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const { id } = await createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 50 });
    await updateIndividualTxn(a, { id, amount: 51 });
    await deleteIndividualTxn(a, { id });
    const row = await batchRow(batchId);
    expect(row.needsRecalcAt).toBeNull();
    expect(row.recalcEmploymentIds).toBeNull();
  });

  // ───────────────────── Close is what makes the window safe ─────────────────────

  it('closeBatch REFUSES while the run owes a recalculation, and names who is waiting', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const { id } = await createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 50 });
    await generatePayslips(a, { batchId });
    await updateIndividualTxn(a, { id, amount: 999 });

    await expect(closeBatch(a, { batchId })).rejects.toBeInstanceOf(BatchNeedsRecalculationError);
    await expect(closeBatch(a, { batchId })).rejects.toMatchObject({ employmentIds: [employmentId] });
    // Refused BEFORE any write: the run is still processed, unreleased and still marked.
    const row = await batchRow(batchId);
    expect(row.status).toBe('processed');
    expect(row.releasedAt).toBeNull();
    expect(row.needsRecalcAt).not.toBeNull();
  });

  it('a selective reprocess clears the mark for the employees it covered, and Close then succeeds', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const { id } = await createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 50 });
    await generatePayslips(a, { batchId });
    await updateIndividualTxn(a, { id, amount: 75 });
    expect((await batchRow(batchId)).needsRecalcAt).not.toBeNull();

    await generatePayslips(a, {
      batchId,
      reprocessSubset: { employmentIds: [employmentId], reason: 'corrected the keyed amount' },
    });

    const cleared = await batchRow(batchId);
    expect(cleared.needsRecalcAt).toBeNull();
    expect(cleared.recalcEmploymentIds).toBeNull();
    await expect(closeBatch(a, { batchId })).resolves.toBeUndefined();
    expect((await batchRow(batchId)).status).toBe('closed');
  });

  it('a reprocess covering only SOME of the waiting employees leaves the rest marked, and Close stays refused', async () => {
    const a = adminCtx(base);
    // `icNumber` is UNIQUE per tenant (employee_statutory_my_ic_uq), so two employees need two ICs —
    // reusing one makes the fixture fail on a constraint that has nothing to do with what is under test,
    // which is exactly how a "rejects" assertion ends up passing for the wrong reason.
    const mk = async (name: string, icNumber: string) => {
      const e = await hireEmployee(a, {
        person: { fullName: name, primaryEmail: `${name.replace(/\W/g, '')}${randomUUID()}@acme.test` },
        companyId: base.companyId,
        departmentId: base.deptA,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      });
      await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
      await setStatutoryProfileMY(a, { personId: e.personId, icNumber });
      return e.employmentId;
    };
    const one = await mk('Partial One', '900101011234');
    const two = await mk('Partial Two', '900101011235');
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const t1 = await createIndividualTxn(a, { batchId, employmentId: one, kind: 'earning', txnDate: '2026-05-10', amount: 30 });
    const t2 = await createIndividualTxn(a, { batchId, employmentId: two, kind: 'earning', txnDate: '2026-05-10', amount: 40 });
    await generatePayslips(a, { batchId });

    await updateIndividualTxn(a, { id: t1.id, amount: 31 });
    await updateIndividualTxn(a, { id: t2.id, amount: 41 });
    expect(((await batchRow(batchId)).recalcEmploymentIds ?? []).sort()).toEqual([one, two].sort());

    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [one], reason: 'first only' } });

    const partial = await batchRow(batchId);
    expect(partial.needsRecalcAt).not.toBeNull();
    expect(partial.recalcEmploymentIds).toEqual([two]);
    await expect(closeBatch(a, { batchId })).rejects.toBeInstanceOf(BatchNeedsRecalculationError);
  });

  it('a reset back to draft clears the mark — its payslips are gone, so nothing is left to be stale', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const { id } = await createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 50 });
    await generatePayslips(a, { batchId });
    await updateIndividualTxn(a, { id, amount: 60 });
    expect((await batchRow(batchId)).needsRecalcAt).not.toBeNull();

    await setSetting(base.tenantId, 'payroll.reset_enabled', true);
    await resetProcessedBatch(adminCtx(base), { batchId, reason: 'start again' });

    const row = await batchRow(batchId);
    expect(row.status).toBe('draft');
    expect(row.needsRecalcAt).toBeNull();
    expect(row.recalcEmploymentIds).toBeNull();
  });

  // ───────────────────── closed is still frozen ─────────────────────

  it('a CLOSED run still refuses every write, and the read projection says so', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const { id } = await createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 50 });
    await generatePayslips(a, { batchId });

    // While processed the row reports itself editable, and flags what editing it will cost.
    const beforeClose = await getIndividualTxn(a, { id });
    expect(beforeClose).toMatchObject({ editable: true, recalcOnEdit: true });

    await closeBatch(a, { batchId });
    expect((await batchRow(batchId)).status).toBe('closed');

    // BatchNotDraftError is deliberately still the thrown type — the same "this run is not in a state
    // this write is allowed on" refusal, narrowed to the one state where it is now true.
    await expect(updateIndividualTxn(a, { id, amount: 60 })).rejects.toMatchObject({ name: 'BatchNotDraftError' });
    await expect(deleteIndividualTxn(a, { id })).rejects.toMatchObject({ name: 'BatchNotDraftError' });
    await expect(
      createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-12', amount: 5 }),
    ).rejects.toMatchObject({ name: 'BatchNotDraftError' });

    const afterClose = await getIndividualTxn(a, { id });
    expect(afterClose).toMatchObject({ editable: false, recalcOnEdit: false });
    // The refused writes changed nothing.
    const [txn] = await owner.db
      .select()
      .from(schema.payrollIndividualTxn)
      .where(eq(schema.payrollIndividualTxn.id, id));
    expect(Number(txn.amount)).toBe(50);
  });

  it('an UNATTACHED row is unaffected: no batch, no mark, still freely editable', async () => {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Unattached', primaryEmail: `un${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    const { id } = await createIndividualTxn(a, {
      companyId: base.companyId,
      payPeriod: '2026-07',
      employmentId: e.employmentId,
      kind: 'earning',
      txnDate: '2026-07-10',
      amount: 100,
    });
    const detail = await getIndividualTxn(a, { id });
    expect(detail).toMatchObject({ batchId: null, editable: true, recalcOnEdit: false });
    await expect(updateIndividualTxn(a, { id, amount: 120 })).resolves.toMatchObject({ id });
  });
});
