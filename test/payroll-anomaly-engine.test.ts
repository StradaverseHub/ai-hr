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
import { terasPayrollLoopSetting } from '../db/teras-payroll-cycle-schema';
import { netSwings } from '../core/loops/net-swing';
import { swingRowsTx } from '../core/loops/swing-rows';
import { withTenant, type SessionContext } from '../db/client';
import {
  evaluateBatchAnomalies,
  openBlockingVerdicts,
  resolveAnomalyVerdict,
  thresholdsInForce,
  UNTUNED_DEFAULT_PARAMS,
} from '../core/payroll-anomaly';
import {
  anomalyMetrics,
  evaluateCircuitBreaker,
} from '../core/payroll-anomaly';
import { BatchHasBlockingAnomaliesError, BatchSwingTooLargeError, closeBatch } from '../core/payroll';
import { closeAll, entitledCtx, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, setModule, setTenantStatus, type Base } from './harness';

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

/** A prior cycle is a CLOSED run (design review, 4 November 2026; test/payroll-close-prior-cycle.test.ts): the fixture's
 *  earlier month is a finished one. */
const closeRun = (batchId: string) =>
  owner.db.update(schema.payrollBatch).set({ status: 'closed', closedAt: new Date() }).where(eq(schema.payrollBatch.id, batchId));

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

describe('Owner rule (4 November 2026) — data-aware checks: a legitimate set-up is not an exception', () => {
  const detectorsOf = async (batchId: string, employmentId: string) => {
    const v = (await liveVerdicts(batchId)).find((r) => r.employmentId === employmentId)!;
    return { verdict: v, findings: await findingsOf(v.id) };
  };

  it('missing-bank-profile stores WHY it blocked, and cash still never fires', async () => {
    const unset = await makeEmp('UnsetMethod', { paymentMethod: null });
    const bank = await makeEmp('BankNoDetails', { paymentMethod: 'bank_transfer' });
    const cash = await makeEmp('CashNoDetails', { paymentMethod: 'cash' });
    const cheque = await makeEmp('ChequeNoDetails', { paymentMethod: 'cheque' });
    const batchId = await makeBatch();
    for (const e of [unset, bank, cash, cheque]) await addPayslip(batchId, e.employmentId);

    await evaluateBatchAnomalies(a, { batchId });
    const bankFinding = async (employmentId: string) =>
      (await detectorsOf(batchId, employmentId)).findings.find((f) => f.detectorId === 'missing-bank-profile');

    expect((await bankFinding(unset.employmentId))?.facts).toEqual({ netPay: 4200, paymentMethod: 'unset', reason: 'payment-method-not-set' });
    expect((await detectorsOf(batchId, unset.employmentId)).verdict.disposition).toBe('block');
    expect((await bankFinding(bank.employmentId))?.facts).toEqual({ netPay: 4200, paymentMethod: 'bank_transfer', reason: 'bank-details-missing' });
    expect(await bankFinding(cash.employmentId)).toBeUndefined();
    expect(await bankFinding(cheque.employmentId)).toBeUndefined();
  });

  it('pay-without-attendance runs only where the company has Attendance, read once for the batch', async () => {
    const { employmentId, personId } = await makeEmp('NoClockIn');
    await giveProfile(personId);
    const batchId = await makeBatch();
    await addPayslip(batchId, employmentId, {}, { noAttendance: true });
    const ghostFlag = async () => {
      await evaluateBatchAnomalies(a, { batchId });
      const { verdict, findings } = await detectorsOf(batchId, employmentId);
      // Always RUN (the coverage figure is unchanged); whether it FINDS anything is the data-aware part.
      expect(verdict.detectorsRun as string[]).toContain('pay-without-attendance');
      return findings.some((f) => f.detectorId === 'pay-without-attendance');
    };

    // Every test tenant (like every tenant the 0313 backfill reached) starts with Attendance granted tenant-wide
    // (packs/catalog.ts LEGACY_ENABLED_MODULE_CODES): in use, so the person with no attendance is flagged.
    expect(await ghostFlag()).toBe(true);
    // Removed: Attendance is off for the company, so nobody there clocks in and zero days is the normal set-up.
    await setModule(b.tenantId, 'attendance', null);
    expect(await ghostFlag()).toBe(false);
    // Granted only for ANOTHER company of the group: still off here.
    const [other] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Other Fictional Sdn Bhd' }).returning({ id: schema.company.id });
    await setModule(b.tenantId, 'attendance', 'active', other.id);
    expect(await ghostFlag()).toBe(false);
    // Granted for THIS company.
    await setModule(b.tenantId, 'attendance', 'active', b.companyId);
    expect(await ghostFlag()).toBe(true);
    // A suspended tenant reads every billable module off — which must never switch the check off. (`a` was resolved
    // while the tenant was active, so its transaction may still write; the evaluator's own in-transaction read is the
    // one that sees the suspension.)
    await setModule(b.tenantId, 'attendance', null, b.companyId);
    await setTenantStatus(b.tenantId, 'suspended');
    expect(await ghostFlag()).toBe(true);
  });

  it('re-evaluation supersedes a verdict the old rules raised — it neither stays open nor duplicates', async () => {
    // A verdict as the OLD rules wrote it: a cash employee blocked on bank details, and a ghost flag at a company
    // without Attendance. Inserted directly, because the current detectors can no longer produce either.
    await setModule(b.tenantId, 'attendance', null); // the ghost's company does not use Attendance
    const cash = await makeEmp('OldCashBlock', { paymentMethod: 'cash' });
    const ghost = await makeEmp('OldGhostFlag');
    await giveProfile(ghost.personId);
    const batchId = await makeBatch();
    await addPayslip(batchId, cash.employmentId);
    await addPayslip(batchId, ghost.employmentId, {}, { noAttendance: true });
    const stale = await owner.db
      .insert(schema.payrollAnomalyVerdict)
      .values([
        { tenantId: b.tenantId, batchId, employmentId: cash.employmentId, disposition: 'block' },
        { tenantId: b.tenantId, batchId, employmentId: ghost.employmentId, disposition: 'review' },
      ])
      .returning({ id: schema.payrollAnomalyVerdict.id, employmentId: schema.payrollAnomalyVerdict.employmentId });
    await owner.db.insert(schema.payrollAnomalyFinding).values([
      { tenantId: b.tenantId, verdictId: stale[0].id, detectorId: 'missing-bank-profile', severity: 'block', facts: { netPay: 4200, paymentMethod: 'cash' }, sourceEventIds: [], suggestedAction: 'anomaly.action.missingBankProfile' },
      { tenantId: b.tenantId, verdictId: stale[1].id, detectorId: 'pay-without-attendance', severity: 'review', facts: { netPay: 4200 }, sourceEventIds: [], suggestedAction: 'anomaly.action.payWithoutAttendance' },
    ]);
    expect(await withTenant(a, (tx) => openBlockingVerdicts(tx, batchId))).toHaveLength(1);

    await evaluateBatchAnomalies(a, { batchId });

    const all = await owner.db.select().from(schema.payrollAnomalyVerdict).where(eq(schema.payrollAnomalyVerdict.batchId, batchId));
    // Superseded, never deleted, and NOT marked resolved: it is history, not a human decision.
    for (const old of stale) {
      const row = all.find((r) => r.id === old.id)!;
      expect(row.supersededAt).not.toBeNull();
      expect(row.resolvedAt).toBeNull();
    }
    // Exactly one live verdict per person, and neither carries the old finding.
    const live = all.filter((r) => r.supersededAt === null);
    expect(live.map((r) => r.employmentId).sort()).toEqual([cash.employmentId, ghost.employmentId].sort());
    for (const v of live) {
      const ids = (await findingsOf(v.id)).map((f) => f.detectorId);
      expect(ids).not.toContain('missing-bank-profile');
      expect(ids).not.toContain('pay-without-attendance');
    }
    expect(await withTenant(a, (tx) => openBlockingVerdicts(tx, batchId))).toEqual([]);
  });
});

describe('One net-swing threshold — what the evaluator reads, and that it agrees with the Salary loop on the same rows', () => {
  const setThreshold = (thresholdBp: number) =>
    owner.db.insert(terasPayrollLoopSetting).values({
      tenantId: b.tenantId, companyId: b.companyId, version: 1, checkInterval: 'daily', swingThresholdBp: thresholdBp, swingExclusions: [],
      remindersEnabled: true, source: 'admin', changedByUserId: b.adminUserId,
    });
  const swingFindings = async (batchId: string) => {
    const out = new Map<string, Record<string, string | number>>();
    for (const v of await liveVerdicts(batchId))
      for (const f of await findingsOf(v.id)) if (f.detectorId === 'net-swing') out.set(v.employmentId, f.facts as Record<string, string | number>);
    return out;
  };
  /** One person paid 4,000 in a closed April and `current` in a processed May. */
  async function moved(current: string) {
    const { employmentId, personId } = await makeEmp(`Mover_${randomUUID().slice(0, 6)}`);
    await giveProfile(personId);
    const april = await makeBatch('2026-04');
    await addPayslip(april, employmentId, { netPay: '4000.00' }, { noAttendance: true });
    await closeRun(april);
    const may = await makeBatch('2026-05');
    await addPayslip(may, employmentId, { netPay: current });
    return { employmentId, may };
  }

  it('the company setting is used by an administrator and by the sweep; a payroll partner says it could not read it and uses 15%', async () => {
    await setThreshold(3000);
    const { employmentId, may } = await moved('4800.00'); // +20%: inside the company's 30%, outside the 15% default

    // A company administrator reads the 30%: no flag, and the disclosure says it is the company's own.
    await evaluateBatchAnomalies(a, { batchId: may });
    expect((await swingFindings(may)).has(employmentId)).toBe(false);
    const own = (await thresholdsInForce(a, { batchId: may })).thresholds.find((t) => t.detectorId === 'net-swing')!;
    expect(own).toMatchObject({ params: { netSwingPct: 30 }, source: 'configured' });

    // The scheduled sweep's carrier (no user): row security hides the setting, so it reads the threshold through the
    // narrow reader (migration 5160 app.sweep_swing_thresholds) and judges by the company's own 30% too.
    const sweep: SessionContext = { tenantId: b.tenantId, roles: ['hr_admin'], entitlements: a.entitlements };
    await evaluateBatchAnomalies(sweep, { batchId: may });
    expect((await swingFindings(may)).has(employmentId)).toBe(false);
    const swept = (await thresholdsInForce(sweep, { batchId: may })).thresholds.find((t) => t.detectorId === 'net-swing')!;
    expect(swept).toMatchObject({ params: { netSwingPct: 30 }, source: 'configured' });

    // A payroll partner of this company administers its payroll but not its loop settings: row security hides the setting,
    // the narrow reader answers no login, so 15% with no exclusion, and the finding and the disclosure both say so.
    const [u] = await owner.db.insert(schema.appUser).values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null }).returning({ id: schema.appUser.id });
    await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: u.id, companyId: b.companyId, role: 'payroll_partner' });
    const partner: SessionContext = { ...(await entitledCtx(b, ['payroll_partner'])), userId: u.id, personId: null, roles: ['payroll_partner'],
      grants: [{ role: 'payroll_partner', companyId: b.companyId }] };
    await evaluateBatchAnomalies(partner, { batchId: may });
    expect((await swingFindings(may)).get(employmentId)).toMatchObject({ thresholdPct: 15, thresholdSource: 'default_company_setting_unreadable' });
    expect((await thresholdsInForce(partner, { batchId: may })).thresholds.find((t) => t.detectorId === 'net-swing')).toMatchObject({ source: 'unreadable_default' });
  });

  it('never a vacuous pass: a prior cycle older than the months read is compared like with like', async () => {
    const { employmentId, personId } = await makeEmp('LongGap');
    await giveProfile(personId);
    const december = await makeBatch('2025-12');
    await addPayslip(december, employmentId, { netPay: '4000.00' }, { noAttendance: true });
    await closeRun(december);
    const may = await makeBatch('2026-05');
    await addPayslip(may, employmentId, { netPay: '6000.00' });
    await evaluateBatchAnomalies(a, { batchId: may });
    expect((await swingFindings(may)).get(employmentId)).toMatchObject({ movementPct: 50, comparedWith: 'previous_run_of_same_type' });
  });

  it('the detector and the Salary loop flag the same people from the same database rows, on the same baseline', async () => {
    // Steady, +20% with no record, +10%, and one paid in a closed March whose April run is only PROCESSED.
    const april = await makeBatch('2026-04');
    const march = await makeBatch('2026-03');
    const may = await makeBatch('2026-05');
    const people: string[] = [];
    for (const [priorNet, mayNet] of [['4000.00', '4000.00'], ['4000.00', '4800.00'], ['4000.00', '4400.00']] as const) {
      const { employmentId, personId } = await makeEmp(`Agree_${randomUUID().slice(0, 6)}`);
      await giveProfile(personId);
      await addPayslip(april, employmentId, { netPay: priorNet }, { noAttendance: true });
      await addPayslip(may, employmentId, { netPay: mayNet });
      people.push(employmentId);
    }
    const late = await makeEmp(`AgreeLate_${randomUUID().slice(0, 6)}`);
    await giveProfile(late.personId);
    await addPayslip(march, late.employmentId, { netPay: '4000.00' }, { noAttendance: true });
    await addPayslip(may, late.employmentId, { netPay: '4800.00' });
    await closeRun(march);
    await closeRun(april);
    // The late person's April: an off-cycle run left PROCESSED. Were it read as "last month", May (4,800) would compare
    // with it (4,800) and nothing would move; on the shared baseline both checks compare May with the closed March.
    const [aprilBatch] = await owner.db.select({ payPeriodId: schema.payrollBatch.payPeriodId }).from(schema.payrollBatch).where(eq(schema.payrollBatch.id, april));
    const [unfinished] = await owner.db.insert(schema.payrollBatch).values({ tenantId: b.tenantId, companyId: b.companyId, payPeriodId: aprilBatch.payPeriodId,
      payPeriod: '2026-04', batchDate: '2026-04-28', status: 'processed', runType: 'off_cycle', runSeq: 2 }).returning({ id: schema.payrollBatch.id });
    await addPayslip(unfinished.id, late.employmentId, { netPay: '4800.00' }, { noAttendance: true });
    await evaluateBatchAnomalies(a, { batchId: may });
    const anomaly = [...(await swingFindings(may)).keys()].sort();
    const loop = await withTenant(a, async (tx) =>
      netSwings(await swingRowsTx(tx, { companyId: b.companyId, period: '2026-05' }), { period: '2026-05', companyId: b.companyId, thresholdBp: 1500, exclusions: [] }));
    expect(loop.people.filter((x) => x.flagged).map((x) => x.employmentId).sort()).toEqual(anomaly);
    expect(anomaly).toEqual([people[1], late.employmentId].sort());
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

  it('runs the prior-period detectors once a prior cycle exists, and net-swing reads the ONE Salary loop threshold', async () => {
    const { employmentId, personId } = await makeEmp('SecondCycle');
    await giveProfile(personId);
    const priorBatch = await makeBatch('2026-04');
    await addPayslip(priorBatch, employmentId, { netPay: '4000.00' }, { noAttendance: true });
    await closeRun(priorBatch);
    const batchId = await makeBatch('2026-05');
    await addPayslip(batchId, employmentId, { netPay: '6000.00' }); // +50%, over the 15% default, and no record explains it

    await evaluateBatchAnomalies(a, { batchId });
    let [v] = await liveVerdicts(batchId);
    expect((v.detectorsRun as string[])).toContain('net-swing');
    expect((await findingsOf(v.id)).map((f) => f.detectorId)).toContain('net-swing');

    const [finding] = (await findingsOf(v.id)).filter((f) => f.detectorId === 'net-swing');
    expect(finding.facts).toMatchObject({ movementPct: 50, thresholdPct: 15, explainedCauses: '', unexplainedShare: 1 });

    // ONE THRESHOLD (owner, 11 November 2026): a per-detector netSwingPct in payroll_anomaly_config no longer applies…
    expect(UNTUNED_DEFAULT_PARAMS['net-swing']).toEqual({ netSwingPct: 15 });
    await owner.db.insert(schema.payrollAnomalyConfig).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      detectorId: 'net-swing',
      params: { netSwingPct: 60 },
      effectiveFrom: '2026-01-01',
    });
    await evaluateBatchAnomalies(a, { batchId });
    [v] = await liveVerdicts(batchId);
    expect((await findingsOf(v.id)).map((f) => f.detectorId)).toContain('net-swing');
    // …the company's Salary payroll loop setting does, read once for the batch: at 50% the same 50% movement is not over it.
    await owner.db.insert(terasPayrollLoopSetting).values({
      tenantId: b.tenantId, companyId: b.companyId, version: 1, checkInterval: 'daily', swingThresholdBp: 5000, swingExclusions: [],
      remindersEnabled: true, source: 'admin', changedByUserId: b.adminUserId,
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


describe('ADR-0076 §4 — the run-level circuit breaker', () => {
  /** Two cycles for the same company, each with `n` employees paid `net`. */
  async function twoCycles(priorNet: string, currentNet: string, n = 3) {
    const prior = await makeBatch('2026-04');
    const current = await makeBatch('2026-05');
    for (let i = 0; i < n; i++) {
      const { employmentId, personId } = await makeEmp(`CB${i}_${randomUUID().slice(0, 6)}`);
      await giveProfile(personId);
      await addPayslip(prior, employmentId, { netPay: priorNet }, { noAttendance: true });
      await addPayslip(current, employmentId, { netPay: currentNet });
    }
    await closeRun(prior);
    return { prior, current };
  }

  it('self-disables on cycle one — there is nothing to compare against', async () => {
    const { employmentId, personId } = await makeEmp('CBFirst');
    await giveProfile(personId);
    const batchId = await makeBatch();
    await addPayslip(batchId, employmentId);
    const cb = await withTenant(a, (tx) => evaluateCircuitBreaker(tx, b.tenantId, batchId));
    expect(cb.tripped).toBe(false);
    expect(cb.movementPct).toBeNull();
    expect(cb.skippedReason).toMatch(/no prior cycle/i);
  });

  it('does NOT trip on an ordinary month', async () => {
    const { current } = await twoCycles('4000.00', '4100.00'); // +2.5%
    const cb = await withTenant(a, (tx) => evaluateCircuitBreaker(tx, b.tenantId, current));
    expect(cb.tripped).toBe(false);
    expect(cb.movementPct).toBeCloseTo(2.5, 1);
  });

  it('TRIPS on a uniform global mis-key that every per-employee detector rates as unremarkable', async () => {
    // +25% for everyone. With the company's per-employee threshold at 30% (its Salary payroll loop setting, the one
    // net-swing threshold since 11 November 2026), net-swing does NOT fire per employee, which is exactly the blind
    // spot this breaker exists to cover.
    await owner.db.insert(terasPayrollLoopSetting).values({
      tenantId: b.tenantId, companyId: b.companyId, version: 1, checkInterval: 'daily', swingThresholdBp: 3000, swingExclusions: [],
      remindersEnabled: true, source: 'admin', changedByUserId: b.adminUserId,
    });
    const { current } = await twoCycles('4000.00', '5000.00');
    await evaluateBatchAnomalies(a, { batchId: current });
    const perEmployee = await liveVerdicts(current);
    for (const v of perEmployee) {
      const ids = (await findingsOf(v.id)).map((f) => f.detectorId);
      expect(ids).not.toContain('net-swing');
    }

    const cb = await withTenant(a, (tx) => evaluateCircuitBreaker(tx, b.tenantId, current));
    expect(cb.tripped).toBe(true);
    expect(cb.movementPct).toBeCloseTo(25, 1);
    await expect(closeBatch(a, { batchId: current })).rejects.toBeInstanceOf(BatchSwingTooLargeError);
  });

  it('the threshold is data: raising it for the company lets the same run close', async () => {
    const { current } = await twoCycles('4000.00', '5000.00');
    await evaluateBatchAnomalies(a, { batchId: current });
    await expect(closeBatch(a, { batchId: current })).rejects.toBeInstanceOf(BatchSwingTooLargeError);

    await owner.db.insert(schema.payrollAnomalyConfig).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      detectorId: 'batch-swing',
      params: { batchSwingPct: 40 },
      effectiveFrom: '2026-01-01',
    });
    await expectCloses(current);
  });

  it('AN UN-EVALUATED BATCH IS UNAFFECTED — the breaker cannot fire on a run this layer never saw', async () => {
    // Same 25% swing, but evaluateBatchAnomalies is never called. This is the additivity guarantee for the
    // breaker: unlike the per-employee guard it is RECOMPUTED, so without the gate it would refuse to close
    // batches that predate the anomaly layer entirely.
    const { current } = await twoCycles('4000.00', '5000.00');
    const cb = await withTenant(a, (tx) => evaluateCircuitBreaker(tx, b.tenantId, current));
    expect(cb.tripped).toBe(true); // the swing IS real...
    await expectCloses(current); // ...and the close is still allowed, because the layer is not in use here
  });
});

describe('ADR-0076 §5 — the metrics ADR-0074 is judged on', () => {
  it('reports the auto-clear rate BESIDE coverage, so a thin clean cannot read as a clean bill of health', async () => {
    const clean = await makeEmp('X1');
    const flagged = await makeEmp('X2');
    for (const e of [clean, flagged]) await giveProfile(e.personId);
    const batchId = await makeBatch();
    await addPayslip(batchId, clean.employmentId);
    await addPayslip(batchId, flagged.employmentId, { netPay: '-1.00' });
    await evaluateBatchAnomalies(a, { batchId });

    const m = await anomalyMetrics(a, { batchId });
    expect(m.total).toBe(2);
    expect(m.autoClear).toBe(1);
    expect(m.block).toBe(1);
    expect(m.autoClearRate).toBeCloseTo(0.5, 3);
    expect(m.flaggedPerThousand).toBeCloseTo(500, 0);
    // First cycle ⇒ the prior-period detectors could not run ⇒ coverage is BELOW 1 and says so.
    expect(m.coverage).toBeGreaterThan(0);
    expect(m.coverage).toBeLessThan(1);
    expect(m.unresolvedFlagged).toBe(1);
    expect(m.falsePositiveRate).toBeNull(); // nothing resolved yet
    expect(m.mttrSeconds).toBeNull();
  });

  it('false-positive rate and MTTR appear once a human dispositions a flag', async () => {
    const { employmentId, personId } = await makeEmp('FP');
    await giveProfile(personId);
    const batchId = await makeBatch();
    await addPayslip(batchId, employmentId, { netPay: '-1.00' });
    await evaluateBatchAnomalies(a, { batchId });
    const [v] = await liveVerdicts(batchId);

    await resolveAnomalyVerdict(a, { verdictId: v.id, resolution: 'false_positive', note: 'expected' });

    const m = await anomalyMetrics(a, { batchId });
    expect(m.falsePositiveRate).toBe(1);
    expect(m.mttrSeconds).not.toBeNull();
    expect(m.mttrSeconds!).toBeGreaterThanOrEqual(0);
    expect(m.unresolvedFlagged).toBe(0);
  });

  it('an un-evaluated batch reports zeroes rather than throwing', async () => {
    const batchId = await makeBatch();
    const m = await anomalyMetrics(a, { batchId });
    expect(m.total).toBe(0);
    expect(m.autoClearRate).toBe(1);
    expect(m.flaggedPerThousand).toBe(0);
  });
});
