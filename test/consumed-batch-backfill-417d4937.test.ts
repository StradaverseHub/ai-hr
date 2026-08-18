/**
 * 417d4937 — THE CONSUMED-MARKER BACKFILL, REHEARSED AGAINST A REAL DATABASE.
 *
 * WHY THIS FILE EXISTS AT ALL. `deploy.sh` runs migrations, not scripts (AGENTS rule 13), so this
 * repair is a thing a human types on the box AFTER the release — and a repair script that has never
 * been run against real rows before it is run against PRODUCTION rows is the shape of failure rule 13
 * was written about. Every case below is a way this script could strand or double-pay money.
 *
 * WHAT IT REPAIRS. `payroll_individual_txn.consumed_batch_id` (migration 0437) is the marker that stops
 * a LATER run paying the same one-off twice. It is stamped at CALCULATION time only, so every row that
 * reached a payslip before 0437 shipped reads NULL — db/schema.ts records that as at 2026-08-13 EVERY
 * production row was in that state, and the SpaceX 2026-08 Director Fee row was re-measured in it on
 * 2026-08-18 while its payslip prints the line.
 *
 * THE HISTORICAL STATE IS RECONSTRUCTED, NOT MOCKED: each case runs the real kernel, then clears the
 * marker the kernel wrote. That is exactly the row shape production is in, and it means the fixture
 * cannot drift from what `generatePayslips` actually produces.
 */
import { randomUUID } from 'node:crypto';
import { eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { createIndividualTxn } from '../core/payroll-individual-txn';
import { runConsumedBackfill } from '../scripts/backfill-consumed-batch-417d4937';
import {
  adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setSetting, type Base,
} from './harness';

const URL = process.env.TEST_MIGRATION_DATABASE_URL!;
const PAY_SETTING = 'payroll.individual_txn_pay_enabled';

let base: Base;
let a: SessionContext;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  a = adminCtx(base);
});
afterAll(async () => {
  await closeAll();
});

/** Turn the one-off FOLD on — the flag both `markIndividualTxnsConsumed` call sites are gated on. */
async function enableFold() {
  await setSetting(base.tenantId, PAY_SETTING, true);
  a = await entitledCtx(base);
}

async function hire(period: string) {
  const e = await hireEmployee(a, {
    person: { fullName: 'Txn Person', primaryEmail: `t${randomUUID()}@acme.test` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
  const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: period });
  return { employmentId: e.employmentId, batchId };
}

const txnRow = async (id: string) => {
  const [r] = await owner.db
    .select()
    .from(schema.payrollIndividualTxn)
    .where(eq(schema.payrollIndividualTxn.id, id));
  return r;
};

/** Put a row back into the pre-0437 state the whole of production is in. */
const clearMarker = (id: string) =>
  owner.db
    .update(schema.payrollIndividualTxn)
    .set({ consumedBatchId: null, consumedAt: null })
    .where(eq(schema.payrollIndividualTxn.id, id));

describe('417d4937 — the consumed-marker backfill', () => {
  it('marks a row that IS on a calculated payslip, and dates it to when that run was calculated', async () => {
    await enableFold();
    const { employmentId, batchId } = await hire('2026-05');
    const { id } = await createIndividualTxn(a, {
      batchId, employmentId, kind: 'overtime', txnDate: '2026-05-10', amount: 250,
    });
    await generatePayslips(a, { batchId });
    await clearMarker(id); // ← the state every production row written before 0437 is in
    expect((await txnRow(id)).consumedBatchId).toBeNull();

    const r = await runConsumedBackfill(URL, { apply: true });
    expect(r.candidates.map((c) => c.id)).toEqual([id]);
    expect(r.marked).toBe(1);
    expect(r.remainingAfter).toBe(0);

    const after = await txnRow(id);
    expect(after.consumedBatchId).toBe(batchId);
    // `consumed_at` is the instant the run that PAID it was calculated — never `now()`, which would
    // date a January payment to whenever somebody happened to run a repair script.
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(after.consumedAt?.toISOString()).toBe(ps.createdAt.toISOString());
  });

  it('REPORT-ONLY BY DEFAULT: it names the row it would mark and writes nothing', async () => {
    await enableFold();
    const { employmentId, batchId } = await hire('2026-05');
    const { id } = await createIndividualTxn(a, {
      batchId, employmentId, kind: 'overtime', txnDate: '2026-05-10', amount: 250,
    });
    await generatePayslips(a, { batchId });
    await clearMarker(id);

    const r = await runConsumedBackfill(URL);
    expect(r.apply).toBe(false);
    expect(r.candidates).toHaveLength(1);
    expect(r.marked).toBe(0);
    expect((await txnRow(id)).consumedBatchId).toBeNull(); // NOTHING was written
  });

  it('SAFE TO RE-RUN: a second pass finds nothing and reports it', async () => {
    await enableFold();
    const { employmentId, batchId } = await hire('2026-05');
    const { id } = await createIndividualTxn(a, {
      batchId, employmentId, kind: 'overtime', txnDate: '2026-05-10', amount: 250,
    });
    await generatePayslips(a, { batchId });
    await clearMarker(id);

    await runConsumedBackfill(URL, { apply: true });
    const second = await runConsumedBackfill(URL, { apply: true });
    expect(second.alreadyCorrect).toBe(true);
    expect(second.candidates).toHaveLength(0);
    expect(second.marked).toBe(0);
    // …and it did not re-date the marker it already wrote.
    expect((await txnRow(id)).consumedBatchId).toBe(batchId);
  });

  it('NEVER marks a row keyed or edited AFTER the run was calculated — that money is still owed', async () => {
    await enableFold();
    const { employmentId, batchId } = await hire('2026-05');
    const { id } = await createIndividualTxn(a, {
      batchId, employmentId, kind: 'overtime', txnDate: '2026-05-10', amount: 250,
    });
    await generatePayslips(a, { batchId });
    await clearMarker(id);
    // The row was touched after the payslip was worked out, so it is NOT in that payslip — the same
    // staleness rule `individualTxnReprocessRequired` applies on the Individual Transaction screen.
    await owner.db
      .update(schema.payrollIndividualTxn)
      .set({ updatedAt: sql`now() + interval '1 hour'` })
      .where(eq(schema.payrollIndividualTxn.id, id));

    const r = await runConsumedBackfill(URL, { apply: true });
    expect(r.candidates).toHaveLength(0);
    expect((await txnRow(id)).consumedBatchId).toBeNull();
  });

  it('NEVER marks a row on a DRAFT run — there is no payslip to have been on', async () => {
    await enableFold();
    const { employmentId, batchId } = await hire('2026-05');
    const { id } = await createIndividualTxn(a, {
      batchId, employmentId, kind: 'overtime', txnDate: '2026-05-10', amount: 250,
    });
    // Deliberately NOT generated: the batch is still draft and has no payslips at all.
    const r = await runConsumedBackfill(URL, { apply: true });
    expect(r.candidates).toHaveLength(0);
    expect((await txnRow(id)).consumedBatchId).toBeNull();
  });

  it('NEVER marks a row for an employee the run produced no payslip for', async () => {
    await enableFold();
    const { employmentId, batchId } = await hire('2026-05');
    const { id } = await createIndividualTxn(a, {
      batchId, employmentId, kind: 'overtime', txnDate: '2026-05-10', amount: 250,
    });
    await generatePayslips(a, { batchId });
    await clearMarker(id);
    // Remove the payslip: the row's only claim to being paid goes with it.
    await owner.db.delete(schema.payslip).where(eq(schema.payslip.batchId, batchId));

    const r = await runConsumedBackfill(URL, { apply: true });
    expect(r.candidates).toHaveLength(0);
    expect((await txnRow(id)).consumedBatchId).toBeNull();
  });

  it('SKIPS a tenant whose one-off fold is OFF, and SAYS how many rows it left alone', async () => {
    // No `enableFold()` — the catalogue default is false, which is what `getSetting` answers for a
    // tenant with no row. With the fold off the ledger is RECORD-ONLY: no row reached a payslip as
    // money, and marking one would strand it permanently the day the flag is turned on.
    const { employmentId, batchId } = await hire('2026-05');
    const { id } = await createIndividualTxn(a, {
      batchId, employmentId, kind: 'overtime', txnDate: '2026-05-10', amount: 250,
    });
    await generatePayslips(a, { batchId });
    // The kernel did not mark it either (both call sites are gated on the same flag) — assert that
    // rather than assume it, because it is the premise of the whole gate.
    expect((await txnRow(id)).consumedBatchId).toBeNull();

    const r = await runConsumedBackfill(URL, { apply: true });
    expect(r.eligibleTenantIds).not.toContain(base.tenantId);
    expect(r.candidates).toHaveLength(0);
    expect((await txnRow(id)).consumedBatchId).toBeNull();
    // The gate is REPORTED, not silent: a gate that looks wrong has to be visible on the output.
    const skipped = r.skippedTenants.find((s) => s.tenantId === base.tenantId);
    expect(skipped, 'the skipped tenant must appear in the report').toBeDefined();
    expect(skipped!.unmarkedRows).toBe(1);
  });

  it('leaves an ALREADY-MARKED row exactly as it is — it never overwrites a marker', async () => {
    await enableFold();
    const { employmentId, batchId } = await hire('2026-05');
    const { id } = await createIndividualTxn(a, {
      batchId, employmentId, kind: 'overtime', txnDate: '2026-05-10', amount: 250,
    });
    await generatePayslips(a, { batchId }); // the kernel marks it here, with its own instant
    const before = await txnRow(id);
    expect(before.consumedBatchId).toBe(batchId);

    await runConsumedBackfill(URL, { apply: true });
    const after = await txnRow(id);
    expect(after.consumedBatchId).toBe(before.consumedBatchId);
    expect(after.consumedAt?.toISOString()).toBe(before.consumedAt?.toISOString());
  });

  it('touches nothing but the two marker columns — no amount, no status, no payslip', async () => {
    await enableFold();
    const { employmentId, batchId } = await hire('2026-05');
    const { id } = await createIndividualTxn(a, {
      batchId, employmentId, kind: 'overtime', txnDate: '2026-05-10', amount: 250, notes: 'rest-day OT',
    });
    await generatePayslips(a, { batchId });
    await clearMarker(id);
    const [slipBefore] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    const rowBefore = await txnRow(id);

    await runConsumedBackfill(URL, { apply: true });

    const rowAfter = await txnRow(id);
    for (const k of ['amount', 'kind', 'txnDate', 'notes', 'batchId', 'employmentId', 'source'] as const) {
      expect(rowAfter[k], k).toEqual(rowBefore[k]);
    }
    const [slipAfter] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(slipAfter.grossPay).toBe(slipBefore.grossPay);
    expect(slipAfter.netPay).toBe(slipBefore.netPay);
    expect(slipAfter.version).toBe(slipBefore.version);
    const [b] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(b.status).toBe('processed');
    // And nothing anywhere else is left unmarked-but-eligible.
    const stragglers = await owner.db
      .select({ id: schema.payrollIndividualTxn.id })
      .from(schema.payrollIndividualTxn)
      .where(isNull(schema.payrollIndividualTxn.consumedBatchId));
    expect(stragglers).toHaveLength(0);
  });
});
