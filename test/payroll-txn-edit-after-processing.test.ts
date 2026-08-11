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
import { exportIndividualTxnsCsv, listIndividualTxnsAcross } from '../core/payroll-view';
import { buildTxnPanel } from '../app/payroll/transactions/individual/existing-context';
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

  // ───────────────────── 510f4bd1 — and now the LISTING says so ─────────────────────
  //
  // The mark, the Close refusal and the Reprocess pre-tick above all existed before this round. What did
  // not was the screen: every row on a processed run read `Processed`, whether or not it was in the payslip
  // that run last produced. These pin the DERIVED status end to end — through the real query, on real
  // rows — because the derivation reads two timestamps that only a database can produce.

  it('a row keyed AFTER the run was processed is listed Pending reprocessing — the updated_at IS NULL row', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const before = await createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 50 });
    await generatePayslips(a, { batchId });
    // Added afterwards and never edited: `payroll_individual_txn.updated_at` stays NULL, which is exactly
    // why the rule coalesces to created_at. Comparing updated_at alone would call this row fresh.
    const after = await createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-12', amount: 500 });
    const [addedRow] = await owner.db
      .select()
      .from(schema.payrollIndividualTxn)
      .where(eq(schema.payrollIndividualTxn.id, after.id));
    expect(addedRow.updatedAt, 'the coalesce exists for exactly this row').toBeNull();

    const rows = await listIndividualTxnsAcross(a, { companyIds: [base.companyId], employmentId });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(before.id)?.reprocessRequired, 'the untouched row is genuinely in the payslip').toBe(false);
    expect(byId.get(after.id)?.reprocessRequired, 'the added row has never been calculated').toBe(true);

    // The workspace panel derives the SAME verdict from the SAME read — one rule, not two.
    const panel = buildTxnPanel(rows);
    expect(new Map(panel.rows.map((r) => [r.id, r.status]))).toEqual(
      new Map([
        [before.id, 'processed'],
        [after.id, 'reprocessRequired'],
      ]),
    );
    expect(panel.totals.reprocessCount).toBe(1);
    expect(panel.totals.reprocessTotal).toBe('500.00');
    expect(panel.totals.processedCount).toBe(1);
  });

  it('an EDIT after processing flips its row to Pending reprocessing and back after a selective reprocess', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const { id } = await createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 500 });
    await generatePayslips(a, { batchId });
    const listed = async () => (await listIndividualTxnsAcross(a, { companyIds: [base.companyId], employmentId }))[0];

    expect((await listed()).reprocessRequired, 'nothing has changed yet').toBe(false);
    expect((await listed()).batchNeedsRecalcForEmployment).toBe(false);

    await updateIndividualTxn(a, { id, amount: 800 });
    const stale = await listed();
    expect(stale.reprocessRequired, 'edited after the payslip was worked out').toBe(true);
    expect(stale.batchNeedsRecalcForEmployment, 'and the run itself agrees at the employee level').toBe(true);

    // Request case 6: after a successful reprocess everything settles back BY ITSELF. Selective reprocess
    // DELETEs and re-INSERTs the payslip, so its created_at moves past the row's change instant — nothing
    // is set by hand and no status column is written, because there is none.
    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [employmentId], reason: 'catch up' } });
    const settled = await listed();
    expect(settled.reprocessRequired).toBe(false);
    expect(settled.batchNeedsRecalcForEmployment).toBe(false);
    expect(buildTxnPanel([settled]).rows[0].status).toBe('processed');
  });

  it('the History filter and the CSV report the same verdict as the screen', async () => {
    const { a, employmentId, batchId } = await hireWithBatch();
    const fresh = await createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 50 });
    await generatePayslips(a, { batchId });
    const added = await createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-12', amount: 500 });

    // ?txnStatus=reprocess returns the stale row and ONLY the stale row. The failure this guards is the
    // opposite one: cleanBatchStatus drops an unrecognised value, so a filter that does not know
    // 'reprocess' silently returns EVERYTHING rather than erroring.
    const filtered = await listIndividualTxnsAcross(a, {
      companyIds: [base.companyId],
      employmentId,
      batchStatus: 'reprocess',
    });
    expect(filtered.map((r) => r.id)).toEqual([added.id]);

    // …and the FILTER MUST SELECT WHAT THE COLUMN SHOWS. Once the stale row is labelled Pending
    // reprocessing, ?txnStatus=processed must stop returning it — a screen that lists a row under
    // Processed while the badge beside it says otherwise is the contradiction this item is about.
    const asProcessed = await listIndividualTxnsAcross(a, {
      companyIds: [base.companyId],
      employmentId,
      batchStatus: 'processed',
    });
    expect(asProcessed.map((r) => r.id)).toEqual([fresh.id]);

    // …and a value the read does not know still fails OPEN, which is why the screen's whitelist has to be
    // imported rather than restated. Stated here so the behaviour is measured, not assumed.
    const bogus = await listIndividualTxnsAcross(a, {
      companyIds: [base.companyId],
      employmentId,
      batchStatus: 'not_a_status',
    });
    expect(bogus.map((r) => r.id).sort()).toEqual([fresh.id, added.id].sort());

    const csv = await exportIndividualTxnsCsv(a, { companyIds: [base.companyId], employmentId });
    const lines = csv.content.trim().split('\n');
    const statusCol = lines[0].split(',').indexOf('Transaction Status');
    expect(statusCol).toBeGreaterThan(-1);
    const statuses = lines.slice(1).map((l) => l.split(',')[statusCol]);
    expect(statuses.sort(), 'the download must not call a stale line processed').toEqual(
      ['processed', 'reprocess'].sort(),
    );
  });

  it('an attendance-style mark leaves the employee flagged while every row stays Processed', async () => {
    // The DELIBERATE disagreement, measured rather than argued: a mark that came from something other than
    // a transaction (an attendance recompute, or a DELETE that left no row behind) is an EMPLOYEE-level
    // fact. Here it is produced by deleting the second row, which marks the run without touching the first.
    const { a, employmentId, batchId } = await hireWithBatch();
    const keep = await createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-10', amount: 50 });
    const drop = await createIndividualTxn(a, { batchId, employmentId, kind: 'earning', txnDate: '2026-05-11', amount: 90 });
    await generatePayslips(a, { batchId });
    await deleteIndividualTxn(a, { id: drop.id });

    const rows = await listIndividualTxnsAcross(a, { companyIds: [base.companyId], employmentId });
    expect(rows.map((r) => r.id)).toEqual([keep.id]);
    expect(rows[0].reprocessRequired, 'the surviving row IS in the payslip — do not mark it').toBe(false);
    expect(rows[0].batchNeedsRecalcForEmployment, 'but the employee is waiting to be recalculated').toBe(true);
    expect(buildTxnPanel(rows).rows[0].status).toBe('processed');
    // The employee-level fact is the batch's, and it is the only one that survives the delete.
    expect((await batchRow(batchId)).recalcEmploymentIds).toEqual([employmentId]);
    await expect(closeBatch(a, { batchId })).rejects.toBeInstanceOf(BatchNeedsRecalculationError);
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
