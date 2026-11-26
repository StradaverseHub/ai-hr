/**
 * Board bc6b5490 (with 038c304b and the CP38 part of 124a979e), 26 Nov 2026 — CP38 corrections, correction history,
 * the last-month amount and the inclusive "Effective to", against the real database:
 *  - Effective to is the LAST month deducted: January to July deducts July, a one-month record deducts its month, and
 *    the month the screens show (listCp38 / listCp38Across) is the last month cp38ForPeriod charges;
 *  - the last-month amount replaces the monthly amount in the last charged month only (RM300 Jan–Jun, RM289.35 Jul,
 *    nothing in Aug), and needs an end (service and the 7510 CHECK);
 *  - edits and deletes of a record a CLOSED payroll used succeed, the closed payslip and run stay byte-identical, the
 *    processed (not closed) run is marked Reprocess Required (category cp38), and reprocessing reads the correction;
 *  - every edit and delete writes one revision row (before/after, actor), which ai_hr_app cannot update or delete;
 *  - an overlap is refused with a named error, not the database's;
 *  - writes resolve the record to its employment's company: a company-scoped administrator cannot change another
 *    company's record by id, the screen's company scope is honoured, and another tenant sees and changes nothing;
 *  - the company-wide list pages by key with a capped count and filters by company, employee and status;
 *  - the Effective to data step lists operator-typed ends only, moves only confirmed rows, marks the processed run and
 *    never marks a closed one.
 * All names are invented.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createBatch, generatePayslips, getReprocessJob, listRecalcChangeCategories, reprocessSelectedEmployees } from '../core/payroll';
import {
  Cp38InputError,
  Cp38NotFoundError,
  Cp38OutOfScopeError,
  Cp38OverlapError,
  cp38ForPeriod,
  deleteCp38,
  listCp38,
  listCp38Across,
  listCp38Revisions,
  setCp38,
  terminateCp38,
  updateCp38,
} from '../core/cp38';
import { applyCp38EffectiveTo, listCp38EffectiveToCandidates } from '../scripts/cp38-inclusive-effective-to-bc6b5490';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

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

const hire = (ctx: SessionContext, name: string, companyId = base.companyId, departmentId = base.deptA) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${randomUUID().slice(0, 8)}@cp38.test` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2025-01-01',
  });

/** A paid employee (salary and an IC), so payroll runs write a payslip for them. */
async function paid(name: string, ic: string) {
  const e = await hire(a, name);
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 6000, monthlyAllowance: 0, effectiveFrom: '2025-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
  return e;
}

const charged = async (employmentId: string, period: string) =>
  (await withTenant(a, (tx) => cp38ForPeriod(tx, [employmentId], period))).get(employmentId)?.amount ?? 0;

async function slip(batchId: string, employmentId: string) {
  const [row] = await owner.db
    .select()
    .from(schema.payslip)
    .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
  return row;
}
const batchRow = async (batchId: string) => (await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId)))[0];
const run = async (period: string) => {
  const b = await createBatch(a, { companyId: base.companyId, payPeriod: period });
  await generatePayslips(a, { batchId: b.batchId });
  return b.batchId;
};
const page = { limit: 25, size: 25 as const, last: false, exactCount: false };

/** A second company in the same tenant, its department, and an administrator of that company only. */
async function secondCompany() {
  const [c] = await owner.db.insert(schema.company).values({ tenantId: base.tenantId, legalName: 'Fictional Beta Sdn Bhd' }).returning({ id: schema.company.id });
  const [d] = await owner.db.insert(schema.department).values({ tenantId: base.tenantId, companyId: c.id, name: 'Beta Ops' }).returning({ id: schema.department.id });
  const [p] = await owner.db.insert(schema.person).values({ tenantId: base.tenantId, fullName: 'Fictional Beta Admin', primaryEmail: `${randomUUID()}@cp38.test` }).returning({ id: schema.person.id });
  const [u] = await owner.db.insert(schema.appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: schema.appUser.id });
  const grants = [{ role: 'hr_admin', companyId: c.id }];
  await owner.db.insert(schema.roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId: c.id, role: 'hr_admin' });
  const ctx: SessionContext = { ...(await entitledCtx(base)), userId: u.id, personId: p.id, roles: ['hr_admin'], grants } as SessionContext;
  return { companyId: c.id, departmentId: d.id, betaAdmin: ctx };
}

describe('bc6b5490 — Effective to is the last month deducted', () => {
  it('January to July deducts July, a one-month record deducts its month, and the screen and the engine agree', async () => {
    const jan = await hire(a, 'Fictional Inclusive A');
    const one = await hire(a, 'Fictional Inclusive B');
    await setCp38(a, { employmentId: jan.employmentId, cp38Ref: 'CP38/INC/1', amount: 100, validFrom: '2026-01-01', validTo: '2026-07-01' });
    await setCp38(a, { employmentId: one.employmentId, cp38Ref: 'CP38/INC/2', amount: 50, validFrom: '2026-03-15', validTo: '2026-03-20' });

    const [row] = await listCp38(a, { employmentId: jan.employmentId });
    expect(row.validTo).toBe('2026-07-01');
    const [stored] = await owner.db.select({ validTo: schema.employeeCp38.validTo }).from(schema.employeeCp38).where(eq(schema.employeeCp38.id, row.id));
    expect(stored.validTo).toBe('2026-08-01');

    const months = ['2025-12', '2026-01', '2026-06', '2026-07', '2026-08'];
    expect(await Promise.all(months.map((m) => charged(jan.employmentId, m)))).toEqual([0, 100, 100, 100, 0]);
    expect(await Promise.all(['2026-02', '2026-03', '2026-04'].map((m) => charged(one.employmentId, m)))).toEqual([0, 50, 0]);

    // The last month the screen shows is the last month the engine charges, for both records.
    for (const e of [jan, one]) {
      const [r] = await listCp38(a, { employmentId: e.employmentId });
      const last = r.validTo!.slice(0, 7);
      const next = new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)), 1)).toISOString().slice(0, 7);
      expect(await charged(e.employmentId, last)).toBeGreaterThan(0);
      expect(await charged(e.employmentId, next)).toBe(0);
    }
    // And the company-wide list shows the same month.
    const across = await listCp38Across(a, { companyIds: [base.companyId], today: '2026-05-10', page });
    expect(across.rows.map((r) => [r.cp38Ref, r.validTo, r.status])).toEqual([
      ['CP38/INC/1', '2026-07-01', 'active'],
      ['CP38/INC/2', '2026-03-01', 'ended'],
    ]);
  });
});

describe('bc6b5490 — the last-month amount', () => {
  it('RM300 January to June, RM289.35 in July, nothing in August — and the July payslip carries it', async () => {
    const e = await paid('Fictional Last Month', '900101017777');
    await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/LAST', amount: 300, lastMonthAmount: 289.35, validFrom: '2026-01-01', validTo: '2026-07-01' });
    expect(await Promise.all(['2026-01', '2026-06', '2026-07', '2026-08'].map((m) => charged(e.employmentId, m)))).toEqual([300, 300, 289.35, 0]);
    const june = await run('2026-06');
    expect(((await slip(june, e.employmentId)).statutory as Record<string, number>).cp38).toBe(300);
    const july = await run('2026-07');
    expect(((await slip(july, e.employmentId)).statutory as Record<string, number>).cp38).toBe(289.35);
  });

  it('needs an end and a non-negative amount (service), and the 7510 CHECK backs it at the database', async () => {
    const e = await hire(a, 'Fictional Last Month Refusals');
    await expect(setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/X', amount: 300, lastMonthAmount: 10, validFrom: '2026-01-01' }))
      .rejects.toMatchObject({ name: 'Cp38InputError', problem: 'lastMonthNeedsEnd' });
    await expect(setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/X', amount: 300, lastMonthAmount: -1, validFrom: '2026-01-01', validTo: '2026-02-01' }))
      .rejects.toBeInstanceOf(Cp38InputError);
    await expect(setCp38(a, { employmentId: e.employmentId, cp38Ref: '  ', amount: 300, validFrom: '2026-01-01' }))
      .rejects.toMatchObject({ problem: 'refRequired' });
    await expect(setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/X', amount: 300, validFrom: '2026-05-01', validTo: '2026-04-01' }))
      .rejects.toMatchObject({ problem: 'backwards' });
    let caught: unknown;
    try {
      await owner.db.insert(schema.employeeCp38).values({ tenantId: base.tenantId, employmentId: e.employmentId, cp38Ref: 'CP38/DB', amount: '1.00', lastMonthAmount: '2.00', validFrom: '2026-01-01', validTo: null });
    } catch (err) {
      caught = err;
    }
    expect(`${(caught as Error)?.message} ${JSON.stringify((caught as { cause?: unknown })?.cause ?? {})}`).toMatch(/employee_cp38_last_month_amount_check|check constraint/i);
  });

  it('un-ticking on Edit clears it; an Edit that removes the end while it is set is refused by name', async () => {
    const e = await hire(a, 'Fictional Last Month Edit');
    const { id } = await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/E', amount: 300, lastMonthAmount: 5, validFrom: '2026-01-01', validTo: '2026-03-01' });
    await expect(updateCp38(a, { id, validTo: null })).rejects.toMatchObject({ problem: 'lastMonthNeedsEnd' });
    await updateCp38(a, { id, lastMonthAmount: null });
    expect((await listCp38(a, { employmentId: e.employmentId }))[0].lastMonthAmount).toBeNull();
    expect(await charged(e.employmentId, '2026-03')).toBe(300);
  });
});

describe('bc6b5490 — corrections after processing', () => {
  it('edit and delete of a record a closed payroll used succeed, the closed run is untouched, the processed run is marked and reprocess reads the change', async () => {
    const e = await paid('Fictional Correction', '900101018888');
    const { id } = await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/C', amount: 200, validFrom: '2026-01-01' });
    const jan = await run('2026-01');
    await closeBatch(a, { batchId: jan });
    const feb = await run('2026-02');
    const closedSlip = JSON.stringify(await slip(jan, e.employmentId));
    const closedRun = JSON.stringify(await batchRow(jan));
    expect(((await slip(feb, e.employmentId)).statutory as Record<string, number>).cp38).toBe(200);

    await expect(updateCp38(a, { id, amount: 250 })).resolves.toEqual({ id, changed: true });
    // Closed: byte-identical payslip and run, not marked.
    expect(JSON.stringify(await slip(jan, e.employmentId))).toBe(closedSlip);
    expect(JSON.stringify(await batchRow(jan))).toBe(closedRun);
    // Processed, not closed: marked for this employee with the CP38 category, once.
    expect((await batchRow(feb)).recalcEmploymentIds).toEqual([e.employmentId]);
    expect(await listRecalcChangeCategories(a, { batchId: feb })).toEqual({ [e.employmentId]: ['cp38'] });
    // Reprocess reads the corrected record; nothing was reprocessed automatically before that.
    expect(((await slip(feb, e.employmentId)).statutory as Record<string, number>).cp38).toBe(200);
    // Selective reprocess is the multi-cycle module's (core/payroll.ts enqueueSelectiveReprocess).
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const reprocessor = await entitledCtx(base);
    const job = await reprocessSelectedEmployees(reprocessor, { batchId: feb, employmentIds: [e.employmentId], idempotencyKey: randomUUID() });
    expect(((await getReprocessJob(reprocessor, job.jobId))!.result as { outcomes: { status: string }[] }).outcomes[0]).toMatchObject({ status: 'reprocessed' });
    expect(((await slip(feb, e.employmentId)).statutory as Record<string, number>).cp38).toBe(250);

    // Delete: gone from the engine and both screens' current lists, kept (as deleted) in listCp38 and in History.
    await deleteCp38(a, { id });
    expect(await charged(e.employmentId, '2026-02')).toBe(0);
    expect((await listCp38Across(a, { companyIds: [base.companyId], page })).rows).toEqual([]);
    expect((await listCp38(a, { employmentId: e.employmentId }))[0].supersededAt).not.toBeNull();
    expect((await batchRow(feb)).recalcEmploymentIds).toEqual([e.employmentId]);
    expect(JSON.stringify(await slip(jan, e.employmentId))).toBe(closedSlip);
    await expect(updateCp38(a, { id, amount: 1 })).rejects.toBeInstanceOf(Cp38NotFoundError);

    const history = await listCp38Revisions(a, { employmentId: e.employmentId });
    expect(history.map((h) => h.action)).toEqual(['delete', 'edit']);
    const [del, edit] = history;
    expect(edit.before).toMatchObject({ cp38Ref: 'CP38/C', amount: '200.00', validTo: null });
    expect(edit.after).toMatchObject({ amount: '250.00' });
    expect(del.before).toMatchObject({ amount: '250.00' });
    expect(del.after).toBeNull();
    expect(history.every((h) => h.byUser)).toBe(true);
    expect((await listCp38Revisions(a, { cp38Ids: [id] })).map((h) => h.id)).toEqual(history.map((h) => h.id));
  });

  it('a change dated after a processed month does not mark that run; a remarks-only edit marks nothing', async () => {
    const e = await paid('Fictional Later Change', '900101019999');
    const mar = await run('2026-03');
    const { id } = await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/L', amount: 120, validFrom: '2026-05-01' });
    expect((await batchRow(mar)).needsRecalcAt).toBeNull();
    await updateCp38(a, { id, remarks: 'Fictional note' });
    expect((await batchRow(mar)).needsRecalcAt).toBeNull();
    // Moving the start back into March reaches the processed run.
    await updateCp38(a, { id, validFrom: '2026-03-01' });
    expect((await batchRow(mar)).recalcEmploymentIds).toEqual([e.employmentId]);
  });

  it('the revision is append-only for the application role', async () => {
    const e = await hire(a, 'Fictional Append Only');
    const { id } = await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/A', amount: 10, validFrom: '2026-01-01' });
    await updateCp38(a, { id, amount: 11 });
    await expect(withTenant(a, (tx) => tx.execute(sql`update employee_cp38_revision set after = null`))).rejects.toThrow();
    await expect(withTenant(a, (tx) => tx.execute(sql`delete from employee_cp38_revision`))).rejects.toThrow();
    expect(await listCp38Revisions(a, { cp38Ids: [id] })).toHaveLength(1);
  });

  it('refuses an overlap with a named error, before the database', async () => {
    const e = await hire(a, 'Fictional Overlap');
    await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/O1', amount: 10, validFrom: '2026-04-01' });
    // A start at or before the open record's own start.
    await expect(setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/O2', amount: 10, validFrom: '2026-02-01', validTo: '2026-05-01' }))
      .rejects.toMatchObject({ name: 'Cp38OverlapError', cp38Ref: 'CP38/O1', validFrom: '2026-04-01', validTo: null });
    // An edit that runs into another current record.
    const { id } = await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/O3', amount: 10, validFrom: '2026-07-01' });
    const rows = await listCp38(a, { employmentId: e.employmentId });
    const first = rows.find((r) => r.cp38Ref === 'CP38/O1')!;
    expect(first.validTo).toBe('2026-06-01');
    await expect(updateCp38(a, { id: first.id, validTo: '2026-08-01' })).rejects.toBeInstanceOf(Cp38OverlapError);
    await expect(updateCp38(a, { id, validFrom: '2026-06-01' })).rejects.toMatchObject({ cp38Ref: 'CP38/O1' });
  });

  it('terminate ends at the month before this one and refuses a record that has not started', async () => {
    const e = await hire(a, 'Fictional Terminate');
    const future = await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/F', amount: 10, validFrom: '2099-01-01' });
    await expect(terminateCp38(a, { id: future.id })).rejects.toMatchObject({ name: 'Cp38NotStartedError' });
  });
});

describe('038c304b — company scope and tenant isolation', () => {
  it('a company administrator cannot change another company’s record by id, the screen scope is honoured, and the list shows only administered companies', async () => {
    const beta = await secondCompany();
    const alphaEmp = await hire(a, 'Fictional Alpha Person');
    const betaEmp = await hire(a, 'Fictional Beta Person', beta.companyId, beta.departmentId);
    const alphaRec = await setCp38(a, { employmentId: alphaEmp.employmentId, cp38Ref: 'CP38/ALPHA', amount: 10, validFrom: '2026-01-01' });
    const betaRec = await setCp38(a, { employmentId: betaEmp.employmentId, cp38Ref: 'CP38/BETA', amount: 20, validFrom: '2026-01-01' });

    // Beta's administrator: their own company only. An Alpha record by id is refused — as not found when row security
    // already hides it from them, as out of scope when they can see it but do not administer its payroll.
    const refusedByScope = (e: unknown) => ['Cp38OutOfScopeError', 'Cp38NotFoundError'].includes((e as Error).name);
    expect(await updateCp38(beta.betaAdmin, { id: alphaRec.id, amount: 99 }).then(() => false, refusedByScope)).toBe(true);
    expect(await deleteCp38(beta.betaAdmin, { id: alphaRec.id }).then(() => false, refusedByScope)).toBe(true);
    expect((await listCp38(a, { employmentId: alphaEmp.employmentId }))[0]).toMatchObject({ amount: '10.00', supersededAt: null });
    await expect(setCp38(beta.betaAdmin, { employmentId: alphaEmp.employmentId, cp38Ref: 'CP38/HACK', amount: 1, validFrom: '2026-09-01' })).rejects.toBeInstanceOf(Cp38OutOfScopeError);
    await expect(updateCp38(beta.betaAdmin, { id: betaRec.id, amount: 21 })).resolves.toMatchObject({ changed: true });
    const betaList = await listCp38Across(beta.betaAdmin, { companyIds: [base.companyId, beta.companyId], page });
    expect(betaList.rows.map((r) => r.cp38Ref)).toEqual(['CP38/BETA']);

    // The group administrator with the switcher on Beta: an Alpha record is outside the screen's scope.
    await expect(updateCp38(a, { id: alphaRec.id, amount: 11, companyIds: [beta.companyId] })).rejects.toBeInstanceOf(Cp38OutOfScopeError);
    const all = await listCp38Across(a, { companyIds: [base.companyId, beta.companyId], page });
    expect(all.rows.map((r) => [r.company, r.cp38Ref])).toEqual([['Acme Sdn Bhd', 'CP38/ALPHA'], ['Fictional Beta Sdn Bhd', 'CP38/BETA']]);
    expect(all.total).toEqual({ count: 2, capped: false });
    expect((await listCp38Across(a, { companyIds: [beta.companyId], page })).rows.map((r) => r.cp38Ref)).toEqual(['CP38/BETA']);
    expect((await listCp38Across(a, { companyIds: [base.companyId, beta.companyId], employmentId: alphaEmp.employmentId, page })).rows.map((r) => r.cp38Ref)).toEqual(['CP38/ALPHA']);

    // History is readable where the record is.
    expect(await listCp38Revisions(beta.betaAdmin, { cp38Ids: [alphaRec.id] })).toEqual([]);
    expect((await listCp38Revisions(beta.betaAdmin, { cp38Ids: [betaRec.id] })).map((h) => h.action)).toEqual(['edit']);
  });

  it('another tenant sees and changes nothing', async () => {
    const e = await hire(a, 'Fictional Tenant A');
    const rec = await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/T', amount: 10, validFrom: '2026-01-01' });
    await updateCp38(a, { id: rec.id, amount: 12 });
    const other = await seedBase();
    const o = adminCtx(other);
    expect((await listCp38Across(o, { companyIds: [base.companyId, other.companyId], page })).rows).toEqual([]);
    await expect(updateCp38(o, { id: rec.id, amount: 1 })).rejects.toBeInstanceOf(Cp38NotFoundError);
    await expect(deleteCp38(o, { id: rec.id })).rejects.toBeInstanceOf(Cp38NotFoundError);
    expect(await listCp38Revisions(o, { cp38Ids: [rec.id] })).toEqual([]);
    expect(await listCp38(o, { employmentId: e.employmentId })).toEqual([]);
  });
});

describe('038c304b — the company-wide list pages by key', () => {
  it('pages forward and back with a stable order, filters by status and counts exactly below the cap', async () => {
    const people = [];
    for (let i = 0; i < 5; i++) people.push(await hire(a, `Fictional Pager ${i}`));
    const codes = (await owner.db.select({ id: schema.employment.id, code: schema.employment.employeeCode }).from(schema.employment)
      .where(eq(schema.employment.tenantId, base.tenantId))).reduce<Record<string, string | null>>((m, r) => ({ ...m, [r.id]: r.code }), {});
    for (const [i, p] of people.entries()) {
      await setCp38(a, { employmentId: p.employmentId, cp38Ref: `CP38/P${i}`, amount: 10 + i, validFrom: i === 4 ? '2026-12-01' : '2026-01-01', validTo: i === 3 ? '2026-02-01' : null });
    }
    const today = '2026-06-15';
    const two = { ...page, limit: 2, size: 25 as const };
    const first = await listCp38Across(a, { companyIds: [base.companyId], today, page: two });
    expect(first.rows).toHaveLength(2);
    expect(first.hasNext).toBe(true);
    expect(first.total).toEqual({ count: 5, capped: false });
    const second = await listCp38Across(a, { companyIds: [base.companyId], today, page: { ...two, after: first.rows[1].id } });
    const third = await listCp38Across(a, { companyIds: [base.companyId], today, page: { ...two, after: second.rows[1].id } });
    const order = [...first.rows, ...second.rows, ...third.rows].map((r) => r.id);
    expect(new Set(order).size).toBe(5);
    // Ordered by company, then employee code (then start and id).
    const sortedCodes = [...first.rows, ...second.rows, ...third.rows].map((r) => r.employeeCode ?? '');
    expect(sortedCodes).toEqual([...sortedCodes].sort());
    expect(sortedCodes).toEqual(people.map((p) => codes[p.employmentId] ?? '').sort());
    expect(third.hasNext).toBe(false);
    const back = await listCp38Across(a, { companyIds: [base.companyId], today, page: { ...two, before: third.rows[0].id } });
    expect(back.rows.map((r) => r.id)).toEqual(second.rows.map((r) => r.id));
    // A deleted anchor serves the first page.
    await deleteCp38(a, { id: first.rows[1].id });
    const stale = await listCp38Across(a, { companyIds: [base.companyId], today, page: { ...two, after: first.rows[1].id } });
    expect(stale.anchorFound).toBe(false);
    // Status against the month of `today`.
    const by = async (status: 'active' | 'upcoming' | 'ended') =>
      (await listCp38Across(a, { companyIds: [base.companyId], today, status, page })).rows.map((r) => r.cp38Ref).sort();
    const deletedRef = first.rows[1].cp38Ref;
    expect(await by('upcoming')).toEqual(['CP38/P4'].filter((r) => r !== deletedRef));
    expect(await by('ended')).toEqual(['CP38/P3'].filter((r) => r !== deletedRef));
    expect(await by('active')).toEqual(['CP38/P0', 'CP38/P1', 'CP38/P2'].filter((r) => r !== deletedRef));
  });
});

describe('bc6b5490 — the Effective to data step', () => {
  it('lists operator-typed ends only, moves only confirmed rows, marks the processed run and never a closed one', async () => {
    const typed = await paid('Fictional Typed End', '900101011111');
    // Paid too: a run refuses to process while anyone in scope is not ready (no salary or IC).
    const closing = await paid('Fictional Closing End', '900101013131');
    const closedMonth = await paid('Fictional Closed Month', '900101012121');
    const raw = (employmentId: string, cp38Ref: string, from: string, to: string | null) =>
      owner.db.insert(schema.employeeCp38).values({ tenantId: base.tenantId, employmentId, cp38Ref, amount: '100.00', validFrom: from, validTo: to }).returning({ id: schema.employeeCp38.id });
    // As the old screen stored them: an operator typed "July" (stored 2026-07-01, deducted to June).
    const [t1] = await raw(typed.employmentId, 'CP38/TYPED', '2026-01-01', '2026-07-01');
    // setCp38's closing: the predecessor ends where its successor starts — already right, never listed.
    await setCp38(a, { employmentId: closing.employmentId, cp38Ref: 'CP38/OLD', amount: 10, validFrom: '2026-01-01' });
    await setCp38(a, { employmentId: closing.employmentId, cp38Ref: 'CP38/NEW', amount: 20, validFrom: '2026-04-01' });
    // An operator-typed end whose newly deducted month is already closed.
    const [t2] = await raw(closedMonth.employmentId, 'CP38/CLOSED', '2026-01-01', '2026-05-01');

    const may = await run('2026-05');
    await closeBatch(a, { batchId: may });
    const july = await run('2026-07');
    const closedRun = JSON.stringify(await batchRow(may));
    const closedSlip = JSON.stringify(await slip(may, closedMonth.employmentId));

    const listed = await listCp38EffectiveToCandidates(owner.db);
    expect(listed.filter((c) => c.tenantId === base.tenantId).map((c) => [c.cp38Ref, c.newlyDeductedMonth, c.payrollState, c.blocked]).sort()).toEqual([
      ['CP38/CLOSED', '2026-05', 'closed', false],
      ['CP38/TYPED', '2026-07', 'processed', false],
    ]);
    // Nothing is written by listing, and an unlisted id refuses the whole step.
    expect(await charged(typed.employmentId, '2026-07')).toBe(0);
    await expect(applyCp38EffectiveTo(owner.db, [t1.id, randomUUID()])).rejects.toThrow(/nothing was written/);
    expect(await charged(typed.employmentId, '2026-07')).toBe(0);

    const result = await applyCp38EffectiveTo(owner.db, [t1.id, t2.id]);
    expect(result).toEqual({ moved: 2, marked: 1 });
    expect(await charged(typed.employmentId, '2026-07')).toBe(100);
    expect(await charged(typed.employmentId, '2026-08')).toBe(0);
    expect((await listCp38(a, { employmentId: typed.employmentId }))[0].validTo).toBe('2026-07-01');
    expect((await batchRow(july)).recalcEmploymentIds).toEqual([typed.employmentId]);
    expect(await listRecalcChangeCategories(a, { batchId: july })).toEqual({ [typed.employmentId]: ['cp38'] });
    // The closed month: not marked, its payslip unchanged.
    expect(JSON.stringify(await batchRow(may))).toBe(closedRun);
    expect(JSON.stringify(await slip(may, closedMonth.employmentId))).toBe(closedSlip);
    // The closing-set rows were never touched; the moved rows have a data-step revision.
    const old = (await listCp38(a, { employmentId: closing.employmentId })).find((r) => r.cp38Ref === 'CP38/OLD')!;
    expect(old.validTo).toBe('2026-03-01');
    const [rev] = await listCp38Revisions(a, { cp38Ids: [t1.id] });
    expect(rev).toMatchObject({ action: 'edit', byUser: false, before: { validTo: '2026-06-01' }, after: { validTo: '2026-07-01' } });
    // Re-running lists the moved rows again only if they still are not a successor's start, and moves nothing unasked.
    expect((await listCp38EffectiveToCandidates(owner.db)).filter((c) => c.tenantId === base.tenantId).map((c) => c.validTo).sort()).toEqual(['2026-06-01', '2026-08-01']);
  });
});

// Integration review (26 Nov 2026): the master report reads the same exclusive valid_to, so its CP38 "Effective to" must
// be the last month deducted and the record ends after it — it used to show the month after (core/employee-master-projection.ts).
describe('bc6b5490 — the master report shows the last month deducted', () => {
  it('a record saved January–July 2026 reports 31 July 2026 and reads ended from 1 August', async () => {
    const { cp38MasterRow } = await import('../core/employee-master-projection');
    const e = await hire(a, 'Master Report Employee');
    await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38/MR/1', amount: 300, validFrom: '2026-01', validTo: '2026-07' });
    const [stored] = await owner.db.select().from(schema.employeeCp38).where(eq(schema.employeeCp38.employmentId, e.employmentId));
    expect(stored.validTo).toBe('2026-08-01');
    expect(cp38MasterRow(stored, '2026-07-15')).toEqual({ status: 'active', validTo: '2026-07-31', reportEffectiveTo: '2026-07-31' });
    expect(cp38MasterRow(stored, '2026-08-01').status).toBe('ended');
    expect(cp38MasterRow(stored, '2025-12-31').status).toBe('future');
    expect(cp38MasterRow({ validFrom: '2026-01-01', validTo: null }, '2026-09-01')).toEqual({ status: 'active', validTo: null, reportEffectiveTo: null });
  });
});
