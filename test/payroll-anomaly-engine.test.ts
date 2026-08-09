/**
 * ADR-0076 §7 — the anomaly ENGINE against a real database. The detectors' own logic is unit-tested
 * without a database in test/payroll-anomaly-detectors.test.ts; this file owns everything that only a
 * database can prove: verdict rows, coverage recording, idempotent re-runs, events, RLS, and the one
 * change this layer makes to existing payroll code (the closeBatch guard).
 *
 * PAYSLIPS ARE INSERTED DIRECTLY RATHER THAN GENERATED, deliberately. The evaluator's contract is "read
 * whatever the kernel produced and classify it", so what matters here is that a payslip carrying a given
 * set of figures produces a given verdict. Driving the kernel to emit a NEGATIVE NET on demand would mean
 * constructing an elaborate deduction scenario, and the test would then be measuring the kernel — which
 * has its own golden byte-identical tests — instead of the classifier. Direct rows give exact control
 * over the inputs each detector reads.
 *
 * THE MOST IMPORTANT TEST IN THIS FILE is 'a batch with no verdict rows closes exactly as it does today'.
 * The guard in closeBatch is the only touch to the money path in the whole slice, and that assertion is
 * what says it is additive.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import {
  evaluateBatchAnomalies,
  openBlockingVerdicts,
  resolveAnomalyVerdict,
  UNTUNED_DEFAULT_PARAMS,
} from '../core/payroll-anomaly';
import { BatchHasBlockingAnomaliesError, closeBatch } from '../core/payroll';
import { closeAll, entitledCtx, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const PERIOD = '2026-05';

let b: Base;
let a: SessionContext;

async function makeEmp(name: string, over: Partial<typeof schema.employment.$inferInsert> = {}) {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: name, primaryEmail: `${name}_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({
      tenantId: b.tenantId,
      personId: p.id,
      companyId: b.companyId,
      hiredOn: '2020-01-01',
      paymentMethod: 'bank_transfer',
      ...over,
    })
    .returning({ id: schema.employment.id });
  return { employmentId: e.id, personId: p.id };
}

/** A complete, unremarkable statutory profile: bank details present, so the row is also a tax profile. */
async function giveProfile(personId: string, over: Record<string, unknown> = {}) {
  await owner.db.insert(schema.employeeStatutoryMy).values({
    tenantId: b.tenantId,
    personId,
    bankName: 'Maybank',
    bankAccountNo: '1234567890',
    ...over,
  });
}

async function makeBatch(period = PERIOD) {
  const [pp] = await owner.db
    .insert(schema.payPeriod)
    .values({ tenantId: b.tenantId, companyId: b.companyId, period, status: 'open' })
    .returning({ id: schema.payPeriod.id });
  const [batch] = await owner.db
    .insert(schema.payrollBatch)
    .values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      payPeriodId: pp.id,
      payPeriod: period,
      batchDate: `${period}-28`,
      status: 'processed',
    })
    .returning({ id: schema.payrollBatch.id });
  return batch.id;
}

/**
 * An ordinary, clean payslip — AND a day of attendance to go with it.
 *
 * The attendance is not incidental. `pay-without-attendance` fires on a paid employee with zero attendance
 * AND zero approved leave, which is exactly what a bare fixture looks like, so a payslip inserted on its
 * own is legitimately an anomaly and every "clean" test would have measured the wrong thing. Pass
 * `noAttendance` to build the ghost-employee case on purpose.
 */
async function addPayslip(
  batchId: string,
  employmentId: string,
  over: Partial<typeof schema.payslip.$inferInsert> = {},
  opts: { noAttendance?: boolean } = {},
) {
  if (!opts.noAttendance) {
    await owner.db.insert(schema.attendance).values({
      tenantId: b.tenantId,
      employmentId,
      attendanceDate: '2026-05-04',
      workedMinutes: 480,
    });
  }
  await owner.db.insert(schema.payslip).values({
    tenantId: b.tenantId,
    batchId,
    employmentId,
    basicSalary: '5000.00',
    grossPay: '5000.00',
    totalDeductions: '800.00',
    netPay: '4200.00',
    employerCost: '5700.00',
    daysWorked: '31.00',
    statutory: { epfEmployee: 550, socsoEmployee: 24.75, eisEmployee: 9.9, pcb: 215 },
    ...over,
  });
}

/** Close, then assert it really closed. `closeBatch` returns nothing, so the status IS the result. */
async function expectCloses(batchId: string) {
  await closeBatch(a, { batchId });
  const [row] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
  expect(row.status).toBe('closed');
  expect(row.closedAt).not.toBeNull();
}

const liveVerdicts = (batchId: string) =>
  owner.db
    .select()
    .from(schema.payrollAnomalyVerdict)
    .where(and(eq(schema.payrollAnomalyVerdict.batchId, batchId), isNull(schema.payrollAnomalyVerdict.supersededAt)));

const findingsOf = (verdictId: string) =>
  owner.db.select().from(schema.payrollAnomalyFinding).where(eq(schema.payrollAnomalyFinding.verdictId, verdictId));

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  a = await entitledCtx(b);
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('ADR-0076 — the evaluator writes verdicts and never touches the money path', () => {
  it('a clean payslip auto-clears, and its payslip row is byte-identical afterwards', async () => {
    const { employmentId, personId } = await makeEmp('Clean');
    await giveProfile(personId);
    const batchId = await makeBatch();
    await addPayslip(batchId, employmentId);

    const before = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));

    const run = await evaluateBatchAnomalies(a, { batchId });
    expect(run.total).toBe(1);
    expect(run.autoClear).toBe(1);
    expect(run.block).toBe(0);

    const [v] = await liveVerdicts(batchId);
    expect(v.disposition).toBe('auto_clear');
    expect(await findingsOf(v.id)).toHaveLength(0);

    // THE READ-ONLY GUARANTEE, asserted rather than described.
    const after = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(after).toEqual(before);
  });

  it('a negative net BLOCKS, records the finding with its facts, and emits payroll.anomaly.flagged', async () => {
    const { employmentId, personId } = await makeEmp('Negative');
    await giveProfile(personId);
    const batchId = await makeBatch();
    await addPayslip(batchId, employmentId, { netPay: '-120.00', totalDeductions: '5120.00' });

    const run = await evaluateBatchAnomalies(a, { batchId });
    expect(run.block).toBe(1);

    const [v] = await liveVerdicts(batchId);
    expect(v.disposition).toBe('block');
    const found = await findingsOf(v.id);
    const neg = found.find((f) => f.detectorId === 'negative-net')!;
    expect(neg.severity).toBe('block');
    expect(neg.facts).toMatchObject({ netPay: -120 });
    expect(neg.suggestedAction).toMatch(/^anomaly\.action\./);

    expect(await eventTypesFor(b.tenantId, v.id)).toContain('payroll.anomaly.flagged');
  });

  it('an auto-clear emits NO per-employee event — a 3,000-person daily dry-run must not flood the log', async () => {
    const { employmentId, personId } = await makeEmp('Quiet');
    await giveProfile(personId);
    const batchId = await makeBatch();
    await addPayslip(batchId, employmentId);
    await evaluateBatchAnomalies(a, { batchId });

    const [v] = await liveVerdicts(batchId);
    expect(await eventTypesFor(b.tenantId, v.id)).not.toContain('payroll.anomaly.flagged');
    // The run-level summary still lands, so the evaluation itself is on the record.
    expect(await eventTypesFor(b.tenantId, batchId)).toContain('payroll.anomaly.evaluated');
  });

  it('cash-paid employees with no bank details do NOT block — the deskless false positive', async () => {
    const cash = await makeEmp('CashPaid', { paymentMethod: 'cash' });
    const bank = await makeEmp('BankPaid', { paymentMethod: 'bank_transfer' });
    // Neither has a statutory profile, so neither has bank details.
    const batchId = await makeBatch();
    await addPayslip(batchId, cash.employmentId);
    await addPayslip(batchId, bank.employmentId);

    await evaluateBatchAnomalies(a, { batchId });
    const rows = await liveVerdicts(batchId);
    const byEmp = new Map(rows.map((r) => [r.employmentId, r]));

    const cashFindings = await findingsOf(byEmp.get(cash.employmentId)!.id);
    expect(cashFindings.map((f) => f.detectorId)).not.toContain('missing-bank-profile');

    const bankFindings = await findingsOf(byEmp.get(bank.employmentId)!.id);
    expect(bankFindings.map((f) => f.detectorId)).toContain('missing-bank-profile');
    expect(byEmp.get(bank.employmentId)!.disposition).toBe('block');
  });
});

describe('ADR-0076 §2.4 — coverage transparency', () => {
  it('records the prior-period detectors as SKIPPED with a reason on a first cycle, not as passing', async () => {
    const { employmentId, personId } = await makeEmp('FirstCycle');
    await giveProfile(personId);
    const batchId = await makeBatch();
    await addPayslip(batchId, employmentId);

    const run = await evaluateBatchAnomalies(a, { batchId });
    const [v] = await liveVerdicts(batchId);

    const skipped = v.detectorsSkipped as { id: string; reason: string }[];
    const skippedIds = skipped.map((s) => s.id);
    for (const id of ['net-swing', 'component-appeared', 'component-vanished']) {
      expect(skippedIds, id).toContain(id);
    }
    for (const s of skipped) expect(s.reason.length).toBeGreaterThan(0);

    // The whole point: auto-clear on thin coverage must not read as a clean bill of health.
    expect(v.disposition).toBe('auto_clear');
    expect(run.coverage).toBeLessThan(1);
    expect((v.detectorsRun as string[]).length).toBeGreaterThan(0);
  });

  it('runs the prior-period detectors once a prior cycle exists, and net-swing reads its threshold from config', async () => {
    const { employmentId, personId } = await makeEmp('SecondCycle');
    await giveProfile(personId);
    const priorBatch = await makeBatch('2026-04');
    await addPayslip(priorBatch, employmentId, { netPay: '4000.00' }, { noAttendance: true });
    const batchId = await makeBatch('2026-05');
    await addPayslip(batchId, employmentId, { netPay: '6000.00' }); // +50%, over the untuned 30 default

    await evaluateBatchAnomalies(a, { batchId });
    let [v] = await liveVerdicts(batchId);
    expect((v.detectorsRun as string[])).toContain('net-swing');
    expect((await findingsOf(v.id)).map((f) => f.detectorId)).toContain('net-swing');

    // THRESHOLDS ARE DATA: the same 50% movement is unremarkable at a 60% threshold, and setting it
    // required no deploy. This is the property the whole config table exists for.
    expect(UNTUNED_DEFAULT_PARAMS['net-swing']).toEqual({ netSwingPct: 30 });
    await owner.db.insert(schema.payrollAnomalyConfig).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      detectorId: 'net-swing',
      params: { netSwingPct: 60 },
      effectiveFrom: '2026-01-01',
    });
    await evaluateBatchAnomalies(a, { batchId });
    [v] = await liveVerdicts(batchId);
    expect((await findingsOf(v.id)).map((f) => f.detectorId)).not.toContain('net-swing');
  });

  it('a disabled detector is recorded as skipped, not silently absent', async () => {
    const { employmentId, personId } = await makeEmp('Disabled');
    await giveProfile(personId);
    const batchId = await makeBatch();
    await addPayslip(batchId, employmentId, { netPay: '-5.00' });
    await owner.db.insert(schema.payrollAnomalyConfig).values({
      tenantId: b.tenantId,
      companyId: null,
      detectorId: 'negative-net',
      enabled: false,
      effectiveFrom: '2026-01-01',
    });

    await evaluateBatchAnomalies(a, { batchId });
    const [v] = await liveVerdicts(batchId);
    const skipped = (v.detectorsSkipped as { id: string; reason: string }[]).find((s) => s.id === 'negative-net');
    expect(skipped?.reason).toMatch(/disabled/i);
    expect((await findingsOf(v.id)).map((f) => f.detectorId)).not.toContain('negative-net');
  });
});

describe('ADR-0076 — idempotence, because the daily dry-run re-runs this constantly', () => {
  it('a re-run supersedes rather than duplicates, and the superseded row is KEPT', async () => {
    const { employmentId, personId } = await makeEmp('Rerun');
    await giveProfile(personId);
    const batchId = await makeBatch();
    await addPayslip(batchId, employmentId);

    await evaluateBatchAnomalies(a, { batchId });
    await evaluateBatchAnomalies(a, { batchId });
    await evaluateBatchAnomalies(a, { batchId });

    expect(await liveVerdicts(batchId)).toHaveLength(1);
    const all = await owner.db
      .select()
      .from(schema.payrollAnomalyVerdict)
      .where(eq(schema.payrollAnomalyVerdict.batchId, batchId));
    expect(all).toHaveLength(3);
    expect(all.filter((r) => r.supersededAt !== null)).toHaveLength(2);
  });

  it('a re-run picks up a fix: correcting the payslip flips block to auto-clear', async () => {
    const { employmentId, personId } = await makeEmp('Fixed');
    await giveProfile(personId);
    const batchId = await makeBatch();
    await addPayslip(batchId, employmentId, { netPay: '-1.00' });

    await evaluateBatchAnomalies(a, { batchId });
    expect((await liveVerdicts(batchId))[0].disposition).toBe('block');

    await owner.db.update(schema.payslip).set({ netPay: '4200.00' }).where(eq(schema.payslip.batchId, batchId));
    await evaluateBatchAnomalies(a, { batchId });
    expect((await liveVerdicts(batchId))[0].disposition).toBe('auto_clear');
  });
});

describe('ADR-0076 slice 3 — the closeBatch guard, the only touch to existing payroll code', () => {
  it('A BATCH WITH NO VERDICT ROWS CLOSES EXACTLY AS IT DOES TODAY (the additive guarantee)', async () => {
    const { employmentId, personId } = await makeEmp('Untouched');
    await giveProfile(personId);
    const batchId = await makeBatch();
    await addPayslip(batchId, employmentId, { netPay: '-999.00' }); // would block IF evaluated

    // Never evaluated ⇒ no verdicts ⇒ the guard cannot fire.
    expect(await withTenant(a, (tx) => openBlockingVerdicts(tx, batchId))).toHaveLength(0);
    await expectCloses(batchId);
  });

  it('refuses to close while an unresolved block stands, and names the employments', async () => {
    const { employmentId, personId } = await makeEmp('Blocked');
    await giveProfile(personId);
    const batchId = await makeBatch();
    await addPayslip(batchId, employmentId, { netPay: '-50.00' });
    await evaluateBatchAnomalies(a, { batchId });

    await expect(closeBatch(a, { batchId })).rejects.toBeInstanceOf(BatchHasBlockingAnomaliesError);
    await expect(closeBatch(a, { batchId })).rejects.toMatchObject({ employmentIds: [employmentId] });

    // A refused close changes NOTHING — it is thrown before any write.
    const [row] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(row.status).toBe('processed');
    expect(row.closedAt).toBeNull();
  });

  it('resolving the verdict releases the close, and records who and why', async () => {
    const { employmentId, personId } = await makeEmp('Resolved');
    await giveProfile(personId);
    const batchId = await makeBatch();
    await addPayslip(batchId, employmentId, { netPay: '-50.00' });
    await evaluateBatchAnomalies(a, { batchId });
    const [v] = await liveVerdicts(batchId);

    await resolveAnomalyVerdict(a, { verdictId: v.id, resolution: 'accepted', note: 'clawback agreed' });

    const [after] = await liveVerdicts(batchId);
    expect(after.resolution).toBe('accepted');
    expect(after.resolvedAt).not.toBeNull();
    expect(after.resolutionNote).toBe('clawback agreed');
    expect(await eventTypesFor(b.tenantId, v.id)).toContain('payroll.anomaly.resolved');

    await expectCloses(batchId);
  });

  it('a REVIEW verdict never blocks the close — only unambiguous bugs do', async () => {
    const { employmentId, personId } = await makeEmp('Reviewed');
    await giveProfile(personId);
    const batchId = await makeBatch();
    // Zero net on positive gross: review, not block.
    await addPayslip(batchId, employmentId, { netPay: '0.00', totalDeductions: '5000.00' });

    await evaluateBatchAnomalies(a, { batchId });
    expect((await liveVerdicts(batchId))[0].disposition).toBe('review');
    await expectCloses(batchId);
  });

  it('a SUPERSEDED block does not keep the batch shut — only the live verdict counts', async () => {
    const { employmentId, personId } = await makeEmp('Superseded');
    await giveProfile(personId);
    const batchId = await makeBatch();
    await addPayslip(batchId, employmentId, { netPay: '-50.00' });
    await evaluateBatchAnomalies(a, { batchId });

    await owner.db.update(schema.payslip).set({ netPay: '4200.00' }).where(eq(schema.payslip.batchId, batchId));
    await evaluateBatchAnomalies(a, { batchId }); // supersedes the block with an auto-clear

    expect(await withTenant(a, (tx) => openBlockingVerdicts(tx, batchId))).toHaveLength(0);
    await expectCloses(batchId);
  });
});

describe('ADR-0076 — the metrics the whole programme is judged on', () => {
  it('reports auto-clear / review / block counts and a coverage figure for the run', async () => {
    const clean = await makeEmp('M1');
    const review = await makeEmp('M2');
    const block = await makeEmp('M3');
    for (const e of [clean, review, block]) await giveProfile(e.personId);
    const batchId = await makeBatch();
    await addPayslip(batchId, clean.employmentId);
    await addPayslip(batchId, review.employmentId, { netPay: '0.00', totalDeductions: '5000.00' });
    await addPayslip(batchId, block.employmentId, { netPay: '-10.00' });

    const run = await evaluateBatchAnomalies(a, { batchId });
    expect(run.total).toBe(3);
    expect(run.autoClear).toBe(1);
    expect(run.review).toBe(1);
    expect(run.block).toBe(1);
    expect(run.coverage).toBeGreaterThan(0);
    expect(run.coverage).toBeLessThanOrEqual(1);

    // The run summary is on the event log, which is where the metrics layer will read it from.
    expect(await eventTypesFor(b.tenantId, batchId)).toContain('payroll.anomaly.evaluated');
  });

  it('an empty batch evaluates to nothing rather than throwing', async () => {
    const batchId = await makeBatch();
    const run = await evaluateBatchAnomalies(a, { batchId });
    expect(run.total).toBe(0);
    expect(run.autoClear).toBe(0);
  });
});

describe('ADR-0076 — RLS', () => {
  it('a verdict is invisible to another tenant', async () => {
    const { employmentId, personId } = await makeEmp('Mine');
    await giveProfile(personId);
    const batchId = await makeBatch();
    await addPayslip(batchId, employmentId, { netPay: '-1.00' });
    await evaluateBatchAnomalies(a, { batchId });
    expect(await liveVerdicts(batchId)).toHaveLength(1);

    const otherTenant = randomUUID();
    const rows = await withTenant({ ...a, tenantId: otherTenant } as SessionContext, (tx) =>
      tx.select().from(schema.payrollAnomalyVerdict),
    ).catch(() => []);
    expect(rows).toHaveLength(0);
  });
});
