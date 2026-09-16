/**
 * Feedback d0d2c9d1 — "RM23,170 entered and never paid: no screen shows unattached transactions."
 *
 * Eleven rows with `batch_id IS NULL` totalling RM23,170 accumulated across several months. The rows
 * were always LISTABLE (/payroll/transaction-view?tab=individual&txnStatus=unattached has shown them
 * since f1564110 Phase 2) — what did not exist was the aggregate: a per-employee, per-month total, a
 * grand total, and whether the month's run has already gone past them.
 *
 * This file covers the READ side and the pre-flight warning. It deliberately adds NOTHING about attach
 * BEHAVIOUR: test/payroll-individual-txn.test.ts already pins that contract (a regular run collects that
 * month only; an off-cycle run leaves rows unattached; a scoped run leaves out-of-scope rows unattached)
 * and this item must not change it.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createAdditionalRun, createBatch, generatePayslips } from '../core/payroll';
import { upsertPayrollCycle } from '../core/payroll-cycle';
import { createIndividualTxn, createIndividualTxnsBulk } from '../core/payroll-individual-txn';
import { listUnattachedTxnSummary, unattachedHoldersOutsideSelection } from '../core/payroll-view';
import {
  adminCtx,
  closeAll,
  createAppUser,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
  harnessSnapshot,
} from './harness';

let base: Base;
let icSeq = 0;
const nextIc = () => `9304040${String(30000 + icSeq++).slice(-5)}`;

async function hire(name: string) {
  const a = adminCtx(base);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary: 5000,
    monthlyAllowance: 0,
    effectiveFrom: '2026-01-01',
  });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc() });
  return e;
}

/** An UNATTACHED transaction — keyed against (company, month) with no batch. */
const txn = (employmentId: string, payPeriod: string, day: string, amount: number) =>
  createIndividualTxn(adminCtx(base), {
    companyId: base.companyId,
    payPeriod,
    employmentId,
    kind: 'earning',
    txnDate: `${payPeriod}-${day}`,
    amount,
  });

const groupFor = (rows: Awaited<ReturnType<typeof listUnattachedTxnSummary>>, employmentId: string, period: string) =>
  rows.find((r) => r.employmentId === employmentId && r.payPeriod === period);

// FILE-level lifecycle, deliberately not per-describe: `closeAll()` tears down the shared connection
// pool, so a per-describe afterAll would close it out from under every later describe in this file.
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

describe('d0d2c9d1 — listUnattachedTxnSummary', () => {

  it('groups by (employee, month) with an exact count and an exact total', async () => {
    const e1 = await hire('Outstanding One');
    const e2 = await hire('Outstanding Two');
    for (const [emp, amounts] of [
      [e1, [100, 200, 300]],
      [e2, [10, 20, 30]],
    ] as const) {
      for (const period of ['2026-02', '2026-03']) {
        for (let i = 0; i < amounts.length; i++) await txn(emp.employmentId, period, `1${i}`, amounts[i]);
      }
    }

    const rows = await listUnattachedTxnSummary(adminCtx(base), { companyIds: [base.companyId] });

    // EXACTLY 4 groups from 12 rows. An ungrouped implementation returns 12 and breaks here before any
    // total is compared; a SUM at the wrong grain returns 4 groups with wrong totals and breaks below.
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r.count).toBe(3);
    expect(groupFor(rows, e1.employmentId, '2026-02')!.totalAmount).toBe('600.00');
    expect(groupFor(rows, e1.employmentId, '2026-03')!.totalAmount).toBe('600.00');
    expect(groupFor(rows, e2.employmentId, '2026-02')!.totalAmount).toBe('60.00');
    expect(groupFor(rows, e2.employmentId, '2026-03')!.totalAmount).toBe('60.00');
    // The oldest entry is the artefact an operator uses to judge how long money has been sitting.
    expect(groupFor(rows, e1.employmentId, '2026-02')!.oldestTxnDate).toBe('2026-02-10');
  });

  it('fails closed on an empty scope', async () => {
    const e1 = await hire('Outstanding Three');
    await txn(e1.employmentId, '2026-02', '05', 500);
    expect(await listUnattachedTxnSummary(adminCtx(base), { companyIds: [] })).toEqual([]);
  });

  it('reports the run state of the month’s REGULAR run, and "none" when there is no run', async () => {
    const a = adminCtx(base);
    const e1 = await hire('Outstanding Four');
    await txn(e1.employmentId, '2026-02', '05', 100); // (a) no run at all
    await txn(e1.employmentId, '2026-03', '05', 100); // (b) draft run
    await txn(e1.employmentId, '2026-04', '05', 100); // (c) processed run

    await createBatch(a, { companyId: base.companyId, payPeriod: '2026-03' }); // stays draft
    const { batchId: apr } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-04' });
    // Generation ATTACHES 2026-04's row, which is the correct behaviour and not what this asserts —
    // so a second, later row is keyed in afterwards to leave something outstanding to report on.
    await generatePayslips(a, { batchId: apr });
    await txn(e1.employmentId, '2026-04', '20', 100);

    const rows = await listUnattachedTxnSummary(a, { companyIds: [base.companyId] });
    expect(groupFor(rows, e1.employmentId, '2026-02')!.runState).toBe('none');
    expect(groupFor(rows, e1.employmentId, '2026-03')!.runState).toBe('draft');
    expect(groupFor(rows, e1.employmentId, '2026-04')!.runState).toBe('processed');
  });

  it('distinguishes a row that arrived AFTER processing from one the run skipped', async () => {
    const a = adminCtx(base);
    const inScope = await hire('Outstanding In');
    const outScope = await hire('Outstanding Out');

    // Row A: keyed in BEFORE generation, but for an employment the run's scope leaves out — so it
    // survives the attach. Row B: keyed in AFTER generation. Both end up unattached for the same
    // month; only B arrived after processing.
    await txn(outScope.employmentId, '2026-05', '05', 700);
    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { employmentIds: [inScope.employmentId] },
    });
    await generatePayslips(a, { batchId });
    await txn(inScope.employmentId, '2026-05', '20', 900);

    const rows = await listUnattachedTxnSummary(a, { companyIds: [base.companyId] });
    // Comparing against payroll_batch.created_at instead of the processed event's occurred_at would
    // flip A to true — the batch row existed before A was keyed in.
    expect(groupFor(rows, outScope.employmentId, '2026-05')!.arrivedAfterProcessing).toBe(false);
    expect(groupFor(rows, inScope.employmentId, '2026-05')!.arrivedAfterProcessing).toBe(true);
  });

  it('RLS: a payroll admin scoped to another company gets nothing, even asking for this one by id', async () => {
    const e1 = await hire('Outstanding Five');
    await txn(e1.employmentId, '2026-02', '05', 1234);

    // A plain employee — no payroll admin rights on base.companyId at all. companyIds is passed
    // EXPLICITLY so the application filter cannot be what excludes the row; the only thing left
    // standing is migration 0176's app.can_admin_payroll_for(company_id).
    const userId = await createAppUser(base.tenantId, e1.personId, 'employee');
    const outsider: SessionContext = {
      tenantId: base.tenantId,
      userId,
      roles: ['employee'],
      personId: e1.personId, entitlements: harnessSnapshot(base.tenantId) };
    expect(await listUnattachedTxnSummary(outsider, { companyIds: [base.companyId] })).toEqual([]);
  });
});

describe('d0d2c9d1 — unattachedHoldersOutsideSelection (pre-flight, informational only)', () => {

  it('names the employees the narrowed run will LEAVE OUT, and stays silent on an unscoped run', async () => {
    const inScope = await hire('Preflight In');
    const outScope = await hire('Preflight Out');
    await txn(inScope.employmentId, '2026-06', '05', 100);
    await txn(outScope.employmentId, '2026-06', '05', 5000);
    await txn(outScope.employmentId, '2026-06', '06', 2500);

    const warned = await unattachedHoldersOutsideSelection(adminCtx(base), {
      companyIds: [base.companyId],
      payPeriod: '2026-06',
      employmentIds: [inScope.employmentId],
    });
    // Exactly the EXCLUDED holder, with its exact figures. An implementation returning all holders
    // fails here; one returning the selected holder fails here too.
    expect(warned).toHaveLength(1);
    expect(warned[0].employmentId).toBe(outScope.employmentId);
    expect(warned[0].count).toBe(2);
    expect(warned[0].amount).toBe('7500.00');

    // An UNSCOPED regular run collects everything, so there is nothing to warn about.
    expect(await unattachedHoldersOutsideSelection(adminCtx(base), { companyIds: [base.companyId], payPeriod: '2026-06' })).toEqual([]);
    expect(
      await unattachedHoldersOutsideSelection(adminCtx(base), { companyIds: [base.companyId], payPeriod: '2026-06', employmentIds: [] }),
    ).toEqual([]);
  });

  it('fails closed on a missing scope or a malformed period', async () => {
    expect(await unattachedHoldersOutsideSelection(adminCtx(base), { companyIds: [], payPeriod: '2026-06', employmentIds: ['x'] })).toEqual([]);
    expect(
      await unattachedHoldersOutsideSelection(adminCtx(base), { companyIds: [base.companyId], payPeriod: 'June', employmentIds: ['x'] }),
    ).toEqual([]);
  });

  it('the pre-flight never gates Process', () => {
    // Anchored to the onStatusChange CALL SITE, not to the file: an over-broad guard would match a
    // comment that merely cites the invariant, which is exactly how r86 lost a round.
    const src = require('node:fs').readFileSync(
      new URL('../app/payroll/process/steps/step-validation.tsx', import.meta.url),
      'utf8',
    ) as string;
    const calls = [...src.matchAll(/onStatusChange\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args).not.toContain('unattached');
  });
});


/**
 * c11e81aa — THE TWO READERS OF THE OLD "REGULAR RUN ONLY" INVARIANT, AFTER THE INVARIANT MOVED.
 *
 * `listUnattachedTxnSummary` keyed its batch join on run_type='regular' and `unattachedHoldersOutside
 * Selection` returned [] for an unscoped run, both on the same reasoning: only the regular run ever
 * collected, and a full regular run collected everything. A transaction can now NAME a Pay Cycle, and the
 * run that collects it is the run opened under that cycle — so a full regular run walks past everything
 * marked for another cycle. Left alone, the first reader would have invented a fault (reporting a bonus
 * row as sitting behind a "processed" regular run that was never going to touch it) and the second would
 * have gone silent on exactly the money the change teaches the run to abandon.
 */
describe('c11e81aa — the unattached readers follow the run that will actually collect', () => {
  async function cycles() {
    const a = adminCtx(base);
    const regular = await upsertPayrollCycle(a, { companyId: base.companyId, name: 'Monthly Salary', runType: 'regular' });
    const bonus = await upsertPayrollCycle(a, { companyId: base.companyId, name: 'Bonus Run', runType: 'bonus' });
    return { regular: regular.id, bonus: bonus.id };
  }

  /** The same write the entry screen makes: unattached, against a month, NAMING a configured cycle. */
  const markedTxn = (employmentId: string, payPeriod: string, day: string, amount: number, intendedCycleId: string) =>
    createIndividualTxnsBulk(adminCtx(base), {
      companyId: base.companyId,
      payPeriod,
      employmentIds: [employmentId],
      rows: [{ kind: 'earning', txnDate: `${payPeriod}-${day}`, amount }],
      intendedCycleId,
    });

  it('runState reports the BONUS run’s state for a bonus-marked row, not the regular run’s', async () => {
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const e = await hire('Cycle Reader');
    const { bonus } = await cycles();
    await markedTxn(e.employmentId, '2026-07', '05', 900, bonus);
    await txn(e.employmentId, '2026-07', '06', 50); // names nothing — still the regular run's

    // Only the REGULAR run exists, and it is processed. It never had any claim on the bonus row.
    const { batchId } = await createBatch(adminCtx(base), { companyId: base.companyId, payPeriod: '2026-07' });
    await generatePayslips(adminCtx(base), { batchId });

    const rows = await listUnattachedTxnSummary(adminCtx(base), { companyIds: [base.companyId], year: 2026, month: 7 });
    // The unmarked row was collected by that run, so only the bonus row is still outstanding — and its
    // run state is 'none', because no bonus run exists. Joining on run_type='regular' would have called
    // it 'processed' and invented a fault.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ payPeriod: '2026-07', count: 1, runState: 'none', intendedCycleId: bonus, intendedRunType: 'bonus' });

    // Open the bonus run: NOW the row has a run, and the state it reports is that run's.
    const multi = await entitledCtx(base);
    await createAdditionalRun(multi, {
      companyId: base.companyId,
      payPeriod: '2026-07',
      runType: 'bonus',
      payrollCycleId: bonus,
    });
    const after = await listUnattachedTxnSummary(adminCtx(base), { companyIds: [base.companyId], year: 2026, month: 7 });
    expect(after).toHaveLength(1);
    expect(after[0].runState).toBe('draft');
  });

  it('the pre-flight reports what a FULL regular run abandons — the silence this change would have caused', async () => {
    const e = await hire('Preflight Cycle');
    const { regular, bonus } = await cycles();
    await markedTxn(e.employmentId, '2026-07', '05', 1200, bonus);
    await markedTxn(e.employmentId, '2026-07', '06', 40, regular);
    await txn(e.employmentId, '2026-07', '07', 10);

    // WITHOUT the run type this is the old call, and the old answer: an unscoped run warns about nobody.
    // Kept, because every caller that cannot name its run (wizard resume) still takes that path.
    expect(
      await unattachedHoldersOutsideSelection(adminCtx(base), { companyIds: [base.companyId], payPeriod: '2026-07' }),
    ).toEqual([]);

    // WITH it, the RM1,200 the regular run will not pay is named — even though nobody was excluded.
    const warned = await unattachedHoldersOutsideSelection(adminCtx(base), {
      companyIds: [base.companyId],
      payPeriod: '2026-07',
      intendedRunType: 'regular',
    });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ employmentId: e.employmentId, count: 1, amount: '1200.00' });
  });

  it('a bonus-marked row is reported even for an employee who IS in a narrowed regular run', async () => {
    const e = await hire('Preflight Both');
    const { bonus } = await cycles();
    await markedTxn(e.employmentId, '2026-07', '05', 300, bonus);

    const warned = await unattachedHoldersOutsideSelection(adminCtx(base), {
      companyIds: [base.companyId],
      payPeriod: '2026-07',
      employmentIds: [e.employmentId],
      intendedRunType: 'regular',
    });
    // In scope, and still abandoned — the two causes are independent, and reading only the scope one
    // would hide this entirely.
    expect(warned).toHaveLength(1);
    expect(warned[0].amount).toBe('300.00');
  });
});
