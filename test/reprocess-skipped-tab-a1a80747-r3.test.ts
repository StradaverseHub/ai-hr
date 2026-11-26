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
  generatePayslips,
  reprocessRequiredPage,
  reprocessSelectAll,
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
    await hire('Fictional Late', 'SK004', 4200, `${period}-10`);
    const other = await seedBase();
    await setModule(other.tenantId, 'payroll', 'active');
    const stranger = { ...(await entitledCtx(other, ['hr_admin'])), grants: [{ role: 'hr_admin' as const, companyId: null }] };
    expect((await reprocessSelectAll(stranger, { batchId, tab: 'required' })).rows).toEqual([]);
    expect((await reprocessSelectAll(ctx, { batchId: randomUUID(), tab: 'required' })).rows).toEqual([]);
  });
});
