/**
 * a1a80747 (approved plan r2) — "Reprocess Required" on the Payroll Process list counts new / pending employees too, and
 * the list's number is the Reprocess Required tab's number.
 *
 * Real fixtures, real runs (fictional people): employees are hired, paid and the run is processed by `generatePayslips`
 * before anything is asked. What is proved, each against independent expectations:
 *
 *   A. ONE OWNER, ONE NUMBER. For the same run, the list's count (`payrollRunOutstandingCounts` over the stored answer
 *      and the live mark), the owner (`runOutstandingTx`), the tab (`reprocessRequiredPage` owed rows and total) and
 *      Close's own refusal (`BatchHasPendingEmployeesError`) name the same employees, each once — a new joiner with no
 *      payslip (the Fiamma case), the mark on a paid employee, and the same employee named by both.
 *   B. IT FOLLOWS THE RUN: a reprocess that adds the new joiner drops them at once (payslip presence is read live), the
 *      last mark cleared returns the run to zero, a reset drops the stored answer, a closed run never has an entry.
 *   C. NOT OWED IS NOT COUNTED: a bonus run's non-recipients, someone outside a chosen-list run, a nothing-payable skip
 *      and someone removed on purpose stay at zero on the list and appear on the tab as not owed, with the reason.
 *   D. THE REFRESH JOB: the list's request claims only due, processed runs the caller administers payroll for, queues one
 *      job, is not repeated within the freshness window, and the job stores the owner's answer; a caller without payroll
 *      administration claims and stores nothing; another tenant sees nothing.
 *   E. SCALE (SCALE-AND-RELEASE-RULES 2 and 3): 70 companies and 1,000 employments, read in ONE transaction for every run
 *      under All companies, and under one company, equal to an independent count.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { client, withTenant, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { requirePackFor } from '../localization/registry';
import { runBulkJobTick } from '../core/bulk-job-worker';
import {
  BatchHasPendingEmployeesError,
  closeBatch,
  createAdditionalRun,
  createBatch,
  generatePayslips,
  payrollRunOutstandingCounts,
  payrollRunOutstandingRefreshJobHandler,
  readPayrollRunOutstandingRefresh,
  refreshRunOutstandingTx,
  removeEmployeePayroll,
  reprocessRequiredWithSkipPage,
  requestPayrollRunOutstandingRefresh,
  resetProcessedBatch,
  runOutstandingTx,
  setPayrollInput,
} from '../packs/payroll/service';
import { parsePageQuery } from '../lib/pagination';
import { todayInKualaLumpur } from '../lib/hr-date';
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
  setSetting,
  type Base,
} from './harness';

let b: Base;
let ctx: SessionContext;
let period: string;
let hiredOn: string;
let ic = 0;

/** Last month, through the HR date owner — a fully elapsed period. */
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
  await setSetting(b.tenantId, 'payroll.reset_enabled', true);
  ctx = { ...(await entitledCtx(b, ['hr_admin'])), grants: [{ role: 'hr_admin', companyId: null }] };
  period = lastMonth();
  hiredOn = `${Number(period.slice(0, 4)) - 1}-01-01`;
});

async function hire(name: string, code: string, basic: number, opts: { companyId?: string; departmentId?: string; on?: string } = {}) {
  const on = opts.on ?? hiredOn;
  const e = await hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${randomUUID()}@fixture.test` },
    companyId: opts.companyId ?? b.companyId,
    departmentId: opts.departmentId ?? b.deptA,
    employeeCode: code,
    employmentType: 'full_time',
    hiredOn: on,
  });
  await setCompensation(ctx, {
    employmentId: e.employmentId,
    basicSalary: basic,
    effectiveFrom: on,
    ...(basic === 0 ? { remarks: 'Fictional quarterly director fees' } : {}),
  });
  ic += 1;
  await requirePackFor('MY').statutory.set(ctx, { personId: e.personId, icNumber: `91010101${String(ic).padStart(4, '0')}` });
  return e.employmentId;
}

async function processedRun(p: { companyId?: string; scope?: { employmentIds: string[] } } = {}) {
  const { batchId } = await createBatch(ctx, { companyId: p.companyId ?? b.companyId, payPeriod: period, scope: p.scope });
  await generatePayslips(ctx, { batchId });
  return batchId;
}

const refresh = (batchId: string, who: SessionContext = ctx) => withTenant(who, (tx) => refreshRunOutstandingTx(tx, who, batchId));
const rule = (batchId: string) => withTenant(ctx, (tx) => runOutstandingTx(tx, ctx, batchId));
const tab = (batchId: string) => reprocessRequiredWithSkipPage(ctx, { batchId, page: parsePageQuery({ size: 'all' }) });
const listCount = async (batchId: string) => (await payrollRunOutstandingCounts(ctx, [batchId])).get(batchId);
/** The stored row, read as the payroll administrator (the table forces row security, so not as the storage owner). */
const storedRow = async (batchId: string) =>
  (await withTenant(ctx, (tx) => tx.select().from(s.payrollRunOutstanding).where(eq(s.payrollRunOutstanding.batchId, batchId))))[0];
const mark = (batchId: string, ids: unknown[]) =>
  owner.db
    .update(s.payrollBatch)
    .set({ needsRecalcAt: new Date(), recalcEmploymentIds: sql`${JSON.stringify(ids)}::jsonb` })
    .where(eq(s.payrollBatch.id, batchId));

/** The list's number, the owner's set and the tab's owed rows are one answer. Returns that set. */
async function oneAnswer(batchId: string): Promise<string[]> {
  const owned = await rule(batchId);
  const listed = await listCount(batchId);
  const page = await tab(batchId);
  const owedRows = page.rows.filter((r) => r.owed).map((r) => r.employmentId).sort();
  expect(listed?.known, 'the list read a stored answer').toBe(true);
  expect(listed?.count, 'list count = owner').toBe(owned.employmentIds.length);
  expect(page.owedRunTotal, 'tab count = owner').toBe(owned.employmentIds.length);
  expect(page.owedTotal).toBe(owned.employmentIds.length);
  expect(owedRows, 'tab owed rows = owner').toEqual(owned.employmentIds);
  expect(new Set(page.rows.map((r) => r.employmentId)).size, 'each employee once on the tab').toBe(page.rows.length);
  return owned.employmentIds;
}

describe('a1a80747 · A — one owner, one number', () => {
  it('a new joiner with no payslip is counted on the list, owed on the tab, and is who Close refuses for', async () => {
    const ada = await hire('Fictional Ada', 'OS001', 5000);
    const batchId = await processedRun();
    // Joins after processing: eligible for the month, no payslip on the run.
    const late = await hire('Fictional Late Joiner', 'OS002', 4200, { on: `${period}-10` });

    // Before the first refresh the list has only the mark to go on, as before this item.
    expect(await listCount(batchId)).toEqual({ count: 0, marked: false, known: false, due: true });
    expect(await refresh(batchId)).toBe('stored');
    expect(await listCount(batchId)).toEqual({ count: 1, marked: false, known: true, due: false });
    expect(await storedRow(batchId)).toMatchObject({ employmentIds: [late], tenantId: b.tenantId });
    expect(await oneAnswer(batchId)).toEqual([late]);

    // The same employees Close refuses for.
    const refused = (await closeBatch(ctx, { batchId }).catch((e: unknown) => e)) as BatchHasPendingEmployeesError;
    expect(refused).toBeInstanceOf(BatchHasPendingEmployeesError);
    expect(refused.employees.map((e) => e.employmentId)).toEqual([late]);

    // The tab's New row is labelled New and owed; the paid employee is not on it at all.
    const page = await tab(batchId);
    expect(page.rows.map((r) => [r.employmentId, r.kind, r.owed, r.notOwedReason])).toEqual([[late, 'added', true, null]]);
    expect(page.rows.some((r) => r.employmentId === ada)).toBe(false);
  });

  it('the mark on a paid employee and the new joiner count once each, however often they are named', async () => {
    const ada = await hire('Fictional Ada', 'OS001', 5000);
    const ben = await hire('Fictional Ben', 'OS003', 4500);
    const batchId = await processedRun();
    const late = await hire('Fictional Late Joiner', 'OS002', 4200, { on: `${period}-10` });
    await refresh(batchId);
    // Ada twice, the late joiner (no payslip) also in the mark, a non-string and an empty string: Ada + late = 2.
    await mark(batchId, [ada, ada, late, 7, '']);
    expect(await listCount(batchId)).toMatchObject({ count: 2, marked: true, known: true });
    expect(await oneAnswer(batchId)).toEqual([ada, late].sort());
    // Ben is paid and unmarked: owed nothing.
    expect((await tab(batchId)).rows.some((r) => r.employmentId === ben)).toBe(false);
  });
});

describe('a1a80747 · B — the number follows the run', () => {
  it('a reprocess that adds the new joiner drops them at once; clearing the last mark returns the run to zero', async () => {
    const ada = await hire('Fictional Ada', 'OS001', 5000);
    await hire('Fictional Ben', 'OS003', 4500);
    const batchId = await processedRun();
    const late = await hire('Fictional Late Joiner', 'OS002', 4200, { on: `${period}-10` });
    await refresh(batchId);
    await mark(batchId, [ada]);
    expect((await listCount(batchId))?.count).toBe(2);

    // Add the new joiner through the real selective path: no refresh needed for the list to see it.
    await generatePayslips(ctx, { batchId, reprocessSubset: { employmentIds: [late], reason: 'add the new joiner' } });
    expect((await listCount(batchId))?.count).toBe(1);
    await generatePayslips(ctx, { batchId, reprocessSubset: { employmentIds: [ada], reason: 'recalculate' } });
    expect((await listCount(batchId))?.count).toBe(0);
    expect((await listCount(batchId))?.marked).toBe(false);
    // …and a fresh answer agrees: nobody owed.
    await refresh(batchId);
    expect(await oneAnswer(batchId)).toEqual([]);
  });

  it('a reset drops the stored answer; a closed run never has an entry and a refresh clears its row', async () => {
    await hire('Fictional Ada', 'OS001', 5000);
    const batchId = await processedRun();
    await hire('Fictional Late Joiner', 'OS002', 4200, { on: `${period}-10` });
    await refresh(batchId);
    expect(await storedRow(batchId)).toBeTruthy();
    await resetProcessedBatch(ctx, { batchId, reason: 'fixture reset' });
    expect(await storedRow(batchId)).toBeUndefined();
    expect(await payrollRunOutstandingCounts(ctx, [batchId])).toEqual(new Map());

    // Processed again, refreshed, then closed by the owner with the answer still stored.
    await generatePayslips(ctx, { batchId });
    expect(await storedRow(batchId), 'a new processing starts without a stored answer').toBeUndefined();
    await refresh(batchId);
    await owner.db.update(s.payrollBatch).set({ status: 'closed', closedAt: new Date() }).where(eq(s.payrollBatch.id, batchId));
    expect(await payrollRunOutstandingCounts(ctx, [batchId]), 'closed never shows Reprocess Required').toEqual(new Map());
    expect((await tab(batchId)).owedRunTotal).toBe(0);
    expect(await refresh(batchId)).toBe('cleared');
    expect(await storedRow(batchId)).toBeUndefined();
  });
});

describe('a1a80747 · C — people the run does not owe are not counted', () => {
  it('a bonus run: its non-recipients stay off the count and read as not paid by this run', async () => {
    const ada = await hire('Fictional Ada', 'OS001', 5000);
    const cara = await hire('Fictional Cara', 'OS006', 3000);
    await processedRun();
    const { batchId: bonus } = await createAdditionalRun(ctx, { companyId: b.companyId, payPeriod: period, runType: 'bonus' });
    await setPayrollInput(ctx, { batchId: bonus, employmentId: ada, overtimeAmount: 0, bonusAmount: 100 });
    await generatePayslips(ctx, { batchId: bonus });
    await refresh(bonus);
    expect(await listCount(bonus)).toMatchObject({ count: 0, known: true });
    expect(await oneAnswer(bonus)).toEqual([]);
    const caraRow = (await tab(bonus)).rows.find((r) => r.employmentId === cara);
    expect(caraRow).toMatchObject({ kind: 'added', owed: false, notOwedReason: 'notPaidByRun' });
  });

  it('a chosen-list run: the outsider and a nothing-payable skip are not counted; each says why on the tab', async () => {
    const ada = await hire('Fictional Ada', 'OS001', 5000);
    const director = await hire('Fictional Director', 'OS007', 0);
    const outsider = await hire('Fictional Outsider', 'OS008', 3000);
    const scoped = await processedRun({ scope: { employmentIds: [ada, director] } });
    await refresh(scoped);
    expect(await listCount(scoped)).toMatchObject({ count: 0, known: true });
    expect(await oneAnswer(scoped)).toEqual([]);
    const rows = (await tab(scoped)).rows;
    expect(rows.find((r) => r.employmentId === outsider)).toMatchObject({ owed: false, notOwedReason: 'outsideScope', outsideScope: true });
    // The nothing-payable skip keeps its own group (skip set), and is not owed.
    expect(rows.find((r) => r.employmentId === director)).toMatchObject({ owed: false, skip: 'NOTHING_PAYABLE_THIS_PERIOD' });
  });

  it('someone removed from the run on purpose is not counted and reads as removed', async () => {
    await hire('Fictional Ada', 'OS001', 5000);
    const ben = await hire('Fictional Ben', 'OS003', 4500);
    const batchId = await processedRun();
    await removeEmployeePayroll(ctx, { batchId, employmentIds: [ben], reason: 'fixture removal' });
    await refresh(batchId);
    expect(await listCount(batchId)).toMatchObject({ count: 0, known: true });
    expect(await oneAnswer(batchId)).toEqual([]);
    expect((await tab(batchId)).rows.find((r) => r.employmentId === ben)).toMatchObject({ owed: false, notOwedReason: 'removed' });
  });
});

describe('a1a80747 · D — the refresh job', () => {
  const tickUntilIdle = async () => {
    for (let i = 0; i < 50; i++) if (!(await runBulkJobTick(owner.client, { handlers: [payrollRunOutstandingRefreshJobHandler] }))) return;
  };
  const jobState = async (id: string) =>
    (await owner.client<{ state: string; notified: boolean }[]>`select state,notified_at is not null as notified from bulk_job where id=${id}::uuid`)[0];

  it('claims due processed runs, queues one job that stores the owner answer, and is not repeated within a minute', async () => {
    await hire('Fictional Ada', 'OS001', 5000);
    const batchId = await processedRun();
    const late = await hire('Fictional Late Joiner', 'OS002', 4200, { on: `${period}-10` });
    const { batchId: draftId } = await createAdditionalRun(ctx, { companyId: b.companyId, payPeriod: period, runType: 'bonus' });

    const first = await requestPayrollRunOutstandingRefresh(ctx, [batchId, draftId, 'not-a-uuid', batchId]);
    expect(first.jobId).toBeTruthy();
    expect(first.batchIds, 'only the processed run is claimed, once').toEqual([batchId]);
    expect(await readPayrollRunOutstandingRefresh(ctx, first.jobId!)).toBe('running');
    // Claimed, not yet worked out: the list keeps its fallback and does not ask again.
    expect(await listCount(batchId)).toMatchObject({ known: false, due: false });
    expect(await requestPayrollRunOutstandingRefresh(ctx, [batchId])).toEqual({ jobId: null, batchIds: [] });

    await tickUntilIdle();
    expect((await jobState(first.jobId!))?.state).toBe('completed');
    expect(await readPayrollRunOutstandingRefresh(ctx, first.jobId!)).toBe('done');
    expect(await storedRow(batchId)).toMatchObject({ employmentIds: [late] });
    expect(await listCount(batchId)).toEqual({ count: 1, marked: false, known: true, due: false });
    // Fresh: not asked again.
    expect((await requestPayrollRunOutstandingRefresh(ctx, [batchId])).jobId).toBeNull();
    // Older than the freshness window: asked again.
    await withTenant(ctx, (tx) =>
      tx
        .update(s.payrollRunOutstanding)
        .set({ refreshedAt: new Date(Date.now() - 120_000), requestedAt: new Date(Date.now() - 120_000) })
        .where(eq(s.payrollRunOutstanding.batchId, batchId)),
    );
    expect(await listCount(batchId)).toMatchObject({ due: true });
    const again = await requestPayrollRunOutstandingRefresh(ctx, [batchId]);
    expect(again.batchIds).toEqual([batchId]);
  });

  it('a caller without payroll administration claims and stores nothing, and another tenant sees nothing', async () => {
    await hire('Fictional Ada', 'OS001', 5000);
    const batchId = await processedRun();
    await hire('Fictional Late Joiner', 'OS002', 4200, { on: `${period}-10` });
    const managerId = await createAppUser(b.tenantId, null, 'manager');
    const manager: SessionContext = { ...ctx, userId: managerId, roles: ['manager'], grants: [{ role: 'manager', companyId: null }] };
    expect(await requestPayrollRunOutstandingRefresh(manager, [batchId])).toEqual({ jobId: null, batchIds: [] });
    expect(await refresh(batchId, manager)).toBe('skipped');
    expect(await storedRow(batchId)).toBeUndefined();

    await refresh(batchId);
    const foreign = adminCtx(await seedBase());
    expect(await payrollRunOutstandingCounts(foreign, [batchId])).toEqual(new Map());
    // The stored row itself is invisible to the other tenant.
    const seen = await withTenant(foreign, (tx) => tx.select().from(s.payrollRunOutstanding));
    expect(seen).toEqual([]);
  });
});

describe('a1a80747 · E — the list read at group shape', () => {
  it('70 companies, 1,000 employments: one transaction for every run, equal to an independent count, group-wide and per company', async () => {
    const ada = await hire('Fictional Ada', 'OS001', 5000);
    const home = await processedRun();
    const [slip] = await owner.db.select().from(s.payslip).where(and(eq(s.payslip.batchId, home), eq(s.payslip.employmentId, ada)));
    expect(slip).toBeTruthy();
    // 69 more companies, each with one processed run.
    const companies = await owner.db
      .insert(s.company)
      .values(Array.from({ length: 69 }, (_, i) => ({ tenantId: b.tenantId, legalName: `Fictional group company ${i}` })))
      .returning({ id: s.company.id });
    const runs: { id: string; companyId: string }[] = [{ id: home, companyId: b.companyId }];
    for (const c of companies) {
      const { batchId } = await createBatch(ctx, { companyId: c.id, payPeriod: period });
      runs.push({ id: batchId, companyId: c.id });
    }
    await owner.db.update(s.payrollBatch).set({ status: 'processed' }).where(sql`${s.payrollBatch.id} in (${sql.join(runs.map((r) => sql`${r.id}::uuid`), sql`, `)})`);
    // 1,000 employments spread over the companies (person + employment rows only; nothing is calculated).
    const people = Array.from({ length: 1000 }, (_, i) => ({ personId: randomUUID(), employmentId: randomUUID(), run: runs[i % runs.length], i }));
    for (let i = 0; i < people.length; i += 200) {
      const chunk = people.slice(i, i + 200);
      await owner.db.insert(s.person).values(chunk.map((p) => ({ id: p.personId, tenantId: b.tenantId, fullName: `Fictional member ${p.i}`, primaryEmail: `${p.personId}@example.invalid` })));
      await owner.db.insert(s.employment).values(chunk.map((p) => ({ id: p.employmentId, tenantId: b.tenantId, personId: p.personId, companyId: p.run.companyId, hiredOn: '2020-01-01', employeeCode: `GS-${p.i}` })));
    }
    // Per run: the mark names members with and without a payslip (only those with one count), the stored answer names
    // members with and without one (only those without one still count); on the home run every third member is paid.
    const expected = new Map<string, number>();
    for (const run of runs) {
      const members = people.filter((p) => p.run.id === run.id);
      // Cloned payslips stay on the home company's run, whose company is their employer.
      const paid = run.id === home ? members.filter((_, k) => k % 3 === 0) : [];
      if (paid.length) await owner.db.insert(s.payslip).values(paid.map((p) => ({ ...slip, id: randomUUID(), batchId: run.id, employmentId: p.employmentId })));
      const paidIds = new Set(paid.map((p) => p.employmentId));
      const marked = members.filter((_, k) => k % 2 === 0).map((p) => p.employmentId);
      const stored = members.filter((_, k) => k % 5 === 0).map((p) => p.employmentId);
      if (marked.length) await mark(run.id, [...marked, marked[0]]);
      await withTenant(ctx, (tx) => tx.insert(s.payrollRunOutstanding).values({ batchId: run.id, tenantId: b.tenantId, employmentIds: stored, refreshedAt: new Date() }));
      const owed = new Set([...marked.filter((id) => paidIds.has(id)), ...stored.filter((id) => !paidIds.has(id))]);
      expected.set(run.id, owed.size);
    }
    for (const name of ['payroll_batch', 'payslip', 'payroll_run_outstanding', 'employment', 'person']) await owner.client.unsafe('analyze public.' + name);

    const begin = vi.spyOn(client, 'begin');
    let all: Awaited<ReturnType<typeof payrollRunOutstandingCounts>>;
    try {
      all = await payrollRunOutstandingCounts(ctx, runs.map((r) => r.id));
      expect(begin, 'one transaction for every run on the list').toHaveBeenCalledTimes(1);
    } finally {
      begin.mockRestore();
    }
    expect(all.size).toBe(70);
    for (const run of runs) expect(all.get(run.id), run.id).toEqual({ count: expected.get(run.id), marked: true, known: true, due: false });
    expect([...expected.values()].some((n) => n > 0)).toBe(true);

    // One company's administrator, asked (as the list asks) for the runs of the companies in their scope.
    const scopedUser = await createAppUser(b.tenantId, null, 'hr_admin');
    const target = runs[5];
    await owner.db.update(s.roleAssignment).set({ companyId: target.companyId }).where(eq(s.roleAssignment.appUserId, scopedUser));
    const scoped: SessionContext = { ...ctx, userId: scopedUser, roles: ['hr_admin'], grants: [{ role: 'hr_admin', companyId: target.companyId }] };
    const mine = await payrollRunOutstandingCounts(scoped, runs.filter((r) => r.companyId === target.companyId).map((r) => r.id));
    expect([...mine.keys()]).toEqual([target.id]);
    expect(mine.get(target.id)).toEqual(all.get(target.id));
  }, 600_000);
});
