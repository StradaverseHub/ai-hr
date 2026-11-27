/**
 * a1a80747 (approved plan r3) — the Reprocess screen's Skipped tab, the Payroll Process list's "held for income tax
 * review" line, and Select all across every page.
 *
 * Real fixtures, real runs (fictional people): employees are hired, paid and the run is processed by `generatePayslips`.
 * A Reprocess's own tax readiness check and a processing hold are recorded exactly as the engine records them: a
 * `payroll-batch.employee-reprocess-outcome` event (`skipped`, TAX_RECALC_REQUIRED) and the `taxHeld` list of a
 * `payroll-batch.processed` event, appended through the event owner. What is proved, each against independent
 * expectations:
 *
 *   A. SKIPPED FOR INCOME TAX LEAVES REPROCESS REQUIRED. A new joiner and a changed (marked) employee the tax check
 *      skipped are on the Skipped tab, not on Reprocess Required; the tab counts add up to the owner's owed set plus the
 *      not-owed rows; the arrival ticks leave them out; the list counts them on the held line, not as affected; the run
 *      still reads Reprocess Required and Close still refuses for them.
 *   B. IT FOLLOWS THE RECORD. A later outcome that is not a tax skip ends it; a newer processed event starts the record
 *      again (an older reprocess skip no longer counts) and its own `taxHeld` list holds people.
 *   C. SELECT ALL. Every tickable row of the tab on every page, with the search applied, New rows that are not ready left
 *      out; Processed / No Change is every unmarked payslip; another tenant gets nothing.
 *   D. 8a3de8ae — AFTER A PARTIAL REPROCESS, THE STORED FACTS THE SCREEN RE-SEEDS FROM. A real job reprocesses two
 *      marked employees and fails a third (their salary record was withdrawn); a fourth is skipped by the tax check.
 *      The arrival ticks then name only the failed one, the tax-held one is on Skipped, the two reprocessed ones are on
 *      Processed / No Change at version 2, and the job's outcomes name exactly those two as reprocessed.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import * as s from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { requirePackFor } from '../localization/registry';
import {
  BatchHasPendingEmployeesError,
  closeBatch,
  createBatch,
  decodeReprocessEmployeeOutcomes,
  generatePayslips,
  getReprocessJob,
  payrollEmployeeSelectionPage,
  reprocessRequiredPage,
  reprocessSelectAll,
  reprocessSelectedEmployees,
  reprocessStaleSelection,
  runOutstandingTx,
} from '../core/payroll';
import { payrollRunOutstandingCounts } from '../core/payroll-view';
import { refreshRunOutstandingTx } from '../core/payroll-run-outstanding';
import { runTaxSkippedIdsTx } from '../core/payroll-tax-holds';
import { parsePageQuery } from '../lib/pagination';
import { todayInKualaLumpur } from '../lib/hr-date';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

let b: Base;
let ctx: SessionContext;
let period: string;
let hiredOn: string;
let ic = 0;

const lastMonth = () => {
  const [y, m] = todayInKualaLumpur().split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
};

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await setModule(b.tenantId, 'payroll', 'active');
  await setModule(b.tenantId, 'multi_cycle_payroll', 'active');
  ctx = { ...(await entitledCtx(b, ['hr_admin'])), grants: [{ role: 'hr_admin', companyId: null }] };
  await setSetting(b.tenantId, 'payroll.reset_enabled', true);
  period = lastMonth();
  hiredOn = `${Number(period.slice(0, 4)) - 1}-01-01`;
});

async function hire(name: string, code: string, basic: number | null, on = hiredOn) {
  const e = await hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${randomUUID()}@fixture.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employeeCode: code,
    employmentType: 'full_time',
    hiredOn: on,
  });
  if (basic !== null) await setCompensation(ctx, { employmentId: e.employmentId, basicSalary: basic, effectiveFrom: on });
  ic += 1;
  await requirePackFor('MY').statutory.set(ctx, { personId: e.personId, icNumber: `92020202${String(ic).padStart(4, '0')}` });
  return e.employmentId;
}

async function processedRun() {
  const { batchId } = await createBatch(ctx, { companyId: b.companyId, payPeriod: period });
  await generatePayslips(ctx, { batchId });
  return batchId;
}

const mark = (batchId: string, ids: string[]) =>
  owner.db.update(s.payrollBatch)
    .set({ needsRecalcAt: new Date(), recalcEmploymentIds: sql`${JSON.stringify(ids)}::jsonb` })
    .where(eq(s.payrollBatch.id, batchId));

/** A Reprocess outcome for one employee, recorded the way the job records it (its own transaction, so its own instant). */
const outcome = (batchId: string, employmentId: string, status: string, reasonCode: string | null) =>
  withTenant(ctx, (tx) => appendEvent(tx, {
    tenantId: b.tenantId, aggregateType: 'payroll-batch', aggregateId: batchId,
    eventType: 'payroll-batch.employee-reprocess-outcome', actor: actorOf(ctx), subjectEmploymentId: employmentId,
    payload: { jobId: randomUUID(), batchId, employmentId, status, reasonCode },
  }));
/** A newer processing record of the run, holding `held` for income tax review. */
const processedAgain = (batchId: string, held: string[]) =>
  withTenant(ctx, (tx) => appendEvent(tx, {
    tenantId: b.tenantId, aggregateType: 'payroll-batch', aggregateId: batchId,
    eventType: 'payroll-batch.processed', actor: actorOf(ctx),
    payload: { count: 0, taxHeld: held.map((employmentId) => ({ employmentId, period, reason: 'Fictional review needed' })) },
  }));

const all = parsePageQuery({ size: 'all' });
const tabRows = async (batchId: string, tab: 'required' | 'skipped', search?: string) =>
  reprocessRequiredPage(ctx, { batchId, page: all, tab, search });
const ids = (rows: { employmentId: string }[]) => rows.map((r) => r.employmentId).sort();
const refresh = (batchId: string) => withTenant(ctx, (tx) => refreshRunOutstandingTx(tx, ctx, batchId));
const listed = async (batchId: string) => (await payrollRunOutstandingCounts(ctx, [batchId])).get(batchId);

describe('a1a80747 r3 · A — skipped for income tax leaves Reprocess Required', () => {
  it('a new joiner and a changed employee skipped by the tax check move to Skipped, off the arrival ticks and onto the held line', async () => {
    const ada = await hire('Fictional Ada', 'SK001', 5000);
    const ben = await hire('Fictional Ben', 'SK002', 4800);
    const cat = await hire('Fictional Cat', 'SK003', 4600);
    const batchId = await processedRun();
    const late = await hire('Fictional Late', 'SK004', 4200, `${period}-10`);
    const later = await hire('Fictional Later', 'SK005', 4100, `${period}-12`);
    await mark(batchId, [ada, ben]);
    await refresh(batchId);

    // Before any skip: everyone owed is on Reprocess Required.
    const before = await tabRows(batchId, 'required');
    expect(ids(before.rows)).toEqual([ada, ben, late, later].sort());
    expect(before.requiredRunTotal).toBe(4);
    expect(before.skippedRunTotal).toBe(0);

    // The tax check skips Ben (changed) and Late (new).
    await outcome(batchId, ben, 'skipped', 'TAX_RECALC_REQUIRED');
    await outcome(batchId, late, 'skipped', 'TAX_RECALC_IN_PROGRESS');
    expect([...(await withTenant(ctx, (tx) => runTaxSkippedIdsTx(tx, batchId)))].sort()).toEqual([ben, late].sort());

    const required = await tabRows(batchId, 'required');
    const skipped = await tabRows(batchId, 'skipped');
    expect(ids(required.rows)).toEqual([ada, later].sort());
    expect(ids(skipped.rows)).toEqual([ben, late].sort());
    expect(skipped.rows.every((r) => r.taxSkipped && r.owed)).toBe(true);
    expect(required.rows.every((r) => !r.taxSkipped && r.owed)).toBe(true);
    // The two tabs together are the one list, each employee once; the owner's owed set is unchanged.
    const owned = await withTenant(ctx, (tx) => runOutstandingTx(tx, ctx, batchId));
    expect([...ids(required.rows), ...ids(skipped.rows)].sort()).toEqual(owned.employmentIds);
    expect(required.requiredRunTotal + required.skippedRunTotal).toBe(required.runTotal);
    expect(required.state.total).toBe(2);
    expect(skipped.state.total).toBe(2);

    // Arrival ticks: Ada only (Ben is marked but skipped for income tax).
    expect((await reprocessStaleSelection(ctx, batchId)).rows.map((r) => r.employmentId)).toEqual([ada]);

    // The list: Ada and Later affected, Ben and Late held; the run is still not closable for all four.
    expect(await listed(batchId)).toMatchObject({ count: 2, held: 2, marked: true, known: true });
    const refused = (await closeBatch(ctx, { batchId }).catch((e: unknown) => e)) as Error;
    expect(refused).toBeInstanceOf(Error);
    if (refused instanceof BatchHasPendingEmployeesError) expect(refused.employees.map((e) => e.employmentId)).toContain(late);
    // Cat is paid and unmarked: on neither tab.
    expect([...required.rows, ...skipped.rows].some((r) => r.employmentId === cat)).toBe(false);
  });

  it('the search applies inside each tab; the run totals ignore it', async () => {
    await hire('Fictional Ada', 'SK001', 5000);
    const batchId = await processedRun();
    const late = await hire('Fictional Late', 'SK004', 4200, `${period}-10`);
    const later = await hire('Fictional Later', 'SK005', 4100, `${period}-12`);
    await refresh(batchId);
    await outcome(batchId, late, 'skipped', 'TAX_RECALC_REQUIRED');
    const r = await tabRows(batchId, 'skipped', 'sk004');
    expect(ids(r.rows)).toEqual([late]);
    expect(r.skippedTotal).toBe(1);
    const none = await tabRows(batchId, 'skipped', 'sk005');
    expect(none.rows).toEqual([]);
    expect(none.skippedRunTotal).toBe(1);
    expect(ids((await tabRows(batchId, 'required', 'later')).rows)).toEqual([later]);
  });
});

describe('a1a80747 r3 · B — it follows the record', () => {
  it('a later outcome that is not a tax skip ends it; a newer processing record starts again and holds its own list', async () => {
    await hire('Fictional Ada', 'SK001', 5000);
    const batchId = await processedRun();
    const late = await hire('Fictional Late', 'SK004', 4200, `${period}-10`);
    const later = await hire('Fictional Later', 'SK005', 4100, `${period}-12`);
    await refresh(batchId);

    await outcome(batchId, late, 'skipped', 'TAX_RECALC_REQUIRED');
    expect(ids((await tabRows(batchId, 'skipped')).rows)).toEqual([late]);
    // A nothing-payable skip is not a tax skip: Late is back on Reprocess Required.
    await outcome(batchId, late, 'skipped', 'NOTHING_PAYABLE');
    expect((await tabRows(batchId, 'skipped')).rows).toEqual([]);
    expect(ids((await tabRows(batchId, 'required')).rows)).toEqual([late, later].sort());

    // Skipped again, then a newer processing record that holds only Later: the older skip no longer counts.
    await outcome(batchId, late, 'skipped', 'TAX_RECALC_REQUIRED');
    await processedAgain(batchId, [later]);
    expect(ids((await tabRows(batchId, 'skipped')).rows)).toEqual([later]);
    expect(ids((await tabRows(batchId, 'required')).rows)).toEqual([late]);
    await refresh(batchId);
    expect(await listed(batchId)).toMatchObject({ count: 1, held: 1 });
  });
});

describe('a1a80747 r3 · C — Select all', () => {
  it('ticks every tickable row of the tab on every page, with the search, and nobody who is skipped or not ready', async () => {
    const paid: string[] = [];
    for (let i = 0; i < 30; i += 1) paid.push(await hire(`Fictional Paid ${String(i).padStart(2, '0')}`, `SA${String(i).padStart(3, '0')}`, 3000 + i));
    const batchId = await processedRun();
    const ready = await hire('Fictional Ready Joiner', 'SA900', 4000, `${period}-10`);
    const notReady = await hire('Fictional Unready Joiner', 'SA901', null, `${period}-10`);
    const marked = paid.slice(0, 27);
    await mark(batchId, marked);
    await refresh(batchId);
    await outcome(batchId, marked[0], 'skipped', 'TAX_RECALC_REQUIRED');

    // Page one of 25 shows only part of the tab; Select all reads all of it.
    const pageOne = await reprocessRequiredPage(ctx, { batchId, page: parsePageQuery({ page: '0', size: '25' }), tab: 'required' });
    expect(pageOne.rows).toHaveLength(25);
    expect(pageOne.state.hasNext).toBe(true);
    const everyone = await reprocessSelectAll(ctx, { batchId, tab: 'required' });
    expect(everyone.tooMany).toBe(false);
    expect(ids(everyone.rows)).toEqual([...marked.slice(1), ready].sort());
    expect(everyone.rows.some((r) => r.employmentId === notReady)).toBe(false);
    expect(everyone.total).toBe(pageOne.requiredRunTotal);
    expect(new Set(everyone.rows.map((r) => r.employmentId)).size).toBe(everyone.rows.length);

    // With a search, only the matches.
    const matching = await reprocessSelectAll(ctx, { batchId, tab: 'required', search: 'Paid 1' });
    expect(ids(matching.rows)).toEqual(marked.filter((_, i) => i >= 10 && i <= 19).sort());

    // Processed / No Change: every payslip the mark does not name.
    expect(ids((await reprocessSelectAll(ctx, { batchId, tab: 'unchanged' })).rows)).toEqual(paid.slice(27).sort());
  });

  it('another tenant and a foreign run id get nobody', async () => {
    await hire('Fictional Ada', 'SK001', 5000);
    const batchId = await processedRun();
    const late = await hire('Fictional Late', 'SK004', 4200, `${period}-10`);
    const other = await seedBase();
    await setModule(other.tenantId, 'payroll', 'active');
    const stranger = { ...(await entitledCtx(other, ['hr_admin'])), grants: [{ role: 'hr_admin' as const, companyId: null }] };
    expect((await reprocessSelectAll(stranger, { batchId, tab: 'required' })).rows).toEqual([]);
    expect((await reprocessSelectAll(ctx, { batchId: randomUUID(), tab: 'required' })).rows).toEqual([]);
    // 7aaff171 — the Skipped tab's Select all is fenced the same way: the owner's tenant sees Late, nobody else does.
    await outcome(batchId, late, 'skipped', 'TAX_RECALC_REQUIRED');
    expect(ids((await reprocessSelectAll(ctx, { batchId, tab: 'skipped' })).rows)).toEqual([late]);
    expect((await reprocessSelectAll(stranger, { batchId, tab: 'skipped' })).rows).toEqual([]);
    expect((await reprocessSelectAll(ctx, { batchId: randomUUID(), tab: 'skipped' })).rows).toEqual([]);
  });

  /**
   * 7aaff171 — SELECT ALL ON THE SKIPPED TAB. A run set up for a chosen list of three: one marked (Reprocess Required),
   * one paid and unmarked (Processed / No Change), one marked and skipped by the tax check (Held for income tax review).
   * Everybody else in the company is Not owed on this run (outside its chosen list) — 58 ready people and one with no
   * salary record. 60 people on the Skipped tab, three pages of 25.
   */
  it('Skipped: every tickable row of the tab on every page, with the search, never a Required, Processed or not-ready one', async () => {
    const required = await hire('Fictional Chosen Marked', 'SC001', 5000);
    const processed = await hire('Fictional Chosen Paid', 'SC002', 4900);
    const held = await hire('Fictional Chosen Taxheld', 'SC003', 4800);
    const outsiders: string[] = [];
    for (let i = 0; i < 58; i += 1) {
      const e = await hireEmployee(ctx, {
        person: { fullName: `Fictional Outsider ${String(i).padStart(2, '0')}`, primaryEmail: `${randomUUID()}@fixture.test` },
        companyId: b.companyId, departmentId: b.deptA, employeeCode: `SO${String(i).padStart(3, '0')}`, employmentType: 'full_time', hiredOn,
      });
      await setCompensation(ctx, { employmentId: e.employmentId, basicSalary: 3000 + i, effectiveFrom: hiredOn });
      outsiders.push(e.employmentId);
    }
    const notReady = await hire('Fictional Outsider Unready', 'SO900', null);
    const { batchId } = await createBatch(ctx, { companyId: b.companyId, payPeriod: period, scope: { employmentIds: [required, processed, held] } });
    await generatePayslips(ctx, { batchId });
    await mark(batchId, [required, held]);
    await refresh(batchId);
    await outcome(batchId, held, 'skipped', 'TAX_RECALC_REQUIRED');

    // The tab, page by page: 60 people, the first page shows 25 of them.
    const pageOne = await reprocessRequiredPage(ctx, { batchId, page: parsePageQuery({ page: '0', size: '25' }), tab: 'skipped' });
    expect(pageOne.rows).toHaveLength(25);
    expect(pageOne.state.hasNext).toBe(true);
    expect(pageOne.skippedRunTotal).toBe(60);
    const whole = await tabRows(batchId, 'skipped');
    expect(ids(whole.rows)).toEqual([...outsiders, notReady, held].sort());
    expect(whole.rows.find((r) => r.employmentId === notReady)!.blockers.length).toBeGreaterThan(0);

    // Select all: everyone who can be ticked, every page, each once; the not-ready one is left out, as their box is.
    const everyone = await reprocessSelectAll(ctx, { batchId, tab: 'skipped' });
    expect(everyone.tooMany).toBe(false);
    expect(everyone.total).toBe(60);
    expect(ids(everyone.rows)).toEqual([...outsiders, held].sort());
    expect(new Set(everyone.rows.map((r) => r.employmentId)).size).toBe(everyone.rows.length);
    for (const nobody of [required, processed, notReady]) expect(everyone.rows.some((r) => r.employmentId === nobody), nobody).toBe(false);
    // Identity only, with what the review needs: the outsiders are additions this run owes nothing; the held one is neither.
    const byId = new Map(everyone.rows.map((r) => [r.employmentId, r]));
    expect(outsiders.every((id) => byId.get(id)!.notOwed === true && byId.get(id)!.added === true)).toBe(true);
    expect(byId.get(held)).toEqual({ employmentId: held, employeeCode: 'SC003', name: 'Fictional Chosen Taxheld' });
    expect(Object.keys(byId.get(outsiders[0])!).sort()).toEqual(['added', 'employeeCode', 'employmentId', 'name', 'notOwed']);

    // With a search, only the matches (SO010 to SO019).
    const matching = await reprocessSelectAll(ctx, { batchId, tab: 'skipped', search: 'so01' });
    expect(ids(matching.rows)).toEqual(outsiders.slice(10, 20).sort());
    expect(matching.total).toBe(10);

    // The other tabs keep their own Select all: Required is the marked one, Processed / No Change the paid one.
    expect(ids((await reprocessSelectAll(ctx, { batchId, tab: 'required' })).rows)).toEqual([required]);
    expect(ids((await reprocessSelectAll(ctx, { batchId, tab: 'unchanged' })).rows)).toEqual([processed]);
  }, 120_000);
});

describe('8a3de8ae · D — after a partial reprocess, the selection is re-seeded from the run', () => {
  it('two reprocessed, one failed, one tax-held: only the failed one is ticked on arrival; Select all never adds the others', async () => {
    const ada = await hire('Fictional Ada Done', 'MJ001', 5000);
    const ben = await hire('Fictional Ben Done', 'MJ002', 4800);
    const cid = await hire('Fictional Cid Failed', 'MJ003', 4600);
    const dan = await hire('Fictional Dan Taxheld', 'MJ004', 4400);
    const eve = await hire('Fictional Eve Paid', 'MJ005', 4200);
    const batchId = await processedRun();
    await mark(batchId, [ada, ben, cid, dan]);
    await refresh(batchId);
    // Before: all four marked employees are ticked on arrival.
    expect((await reprocessStaleSelection(ctx, batchId)).rows.map((r) => r.employmentId).sort()).toEqual([ada, ben, cid, dan].sort());

    // Cid's salary record is withdrawn after processing, so his recalculation fails on its own (the job carries on).
    await owner.client`update compensation set superseded_at=now() where tenant_id=${b.tenantId}::uuid and employment_id=${cid}::uuid and superseded_at is null`;
    const run = await reprocessSelectedEmployees(ctx, { batchId, employmentIds: [ada, ben, cid], idempotencyKey: randomUUID() });
    expect(run.status).toBe('completed');
    // Dan is held by the tax check, recorded as the job's check records it (see the file header).
    await outcome(batchId, dan, 'skipped', 'TAX_RECALC_REQUIRED');

    const job = await getReprocessJob(ctx, run.jobId);
    expect(job?.status).toBe('completed');
    const outcomes = decodeReprocessEmployeeOutcomes(job!.result, job!.employmentIds)!;
    expect(outcomes).toHaveLength(3);
    const statusOf = new Map(outcomes.map((o) => [o.employmentId, o.status]));
    expect(statusOf.get(ada)).toBe('reprocessed');
    expect(statusOf.get(ben)).toBe('reprocessed');
    expect(statusOf.get(cid)).toBe('validation_failed');
    // What the page hands the form as `reprocessedNow`.
    expect(outcomes.filter((o) => o.status === 'reprocessed').map((o) => o.employmentId).sort()).toEqual([ada, ben].sort());

    // THE FRESH SEED: only the failed employee is still marked and ticked on arrival.
    expect((await reprocessStaleSelection(ctx, batchId)).rows.map((r) => r.employmentId)).toEqual([cid]);
    const required = await tabRows(batchId, 'required');
    expect(ids(required.rows)).toEqual([cid]);
    const skipped = await tabRows(batchId, 'skipped');
    expect(ids(skipped.rows)).toEqual([dan]);
    expect(skipped.rows[0]).toMatchObject({ taxSkipped: true, kind: 'recalculated' });

    // Processed / No Change: the reprocessed two at version 2 (they read Reprocessed after any reload), Eve untouched.
    const unchanged = await payrollEmployeeSelectionPage(ctx, { batchId, kind: 'reprocess', page: all, tab: 'unchanged' });
    const version = new Map(unchanged.rows.map((r) => [r.employmentId, r.version]));
    expect([...version.keys()].sort()).toEqual([ada, ben, eve].sort());
    expect(version.get(ada)).toBe(2);
    expect(version.get(ben)).toBe(2);
    expect(version.get(eve)).toBe(1);
    expect(unchanged.rows.every((r) => !r.stale)).toBe(true);

    // Select all on Reprocess Required names the failed one only; on Skipped (7aaff171) the tax-held one only.
    expect(ids((await reprocessSelectAll(ctx, { batchId, tab: 'required' })).rows)).toEqual([cid]);
    expect(ids((await reprocessSelectAll(ctx, { batchId, tab: 'skipped' })).rows)).toEqual([dan]);
  });
});
