/**
 * cdb1c6ca — Close Batch: the service half. What closing a payroll run refuses, what it records, and what it
 * must never touch.
 *
 * Real fixtures, real runs: employees are hired, paid, and the run is processed by `generatePayslips` before
 * anything is closed. Reprocess jobs are written as rows because the gates read the job ledger, not the
 * engine that wrote it — the fixture states exactly the ledger the gate is asked about.
 *
 *   A. Yes closes ONLY the selected run: a sibling run in the same month, and another company's run, are
 *      untouched; the month closes only once every one of its runs is closed.
 *   B. The audit record names the run: company, payroll month, pay cycle, run identity, previous and new
 *      status — and no amount.
 *   C. The three outstanding-work gates each refuse with the people named and leave the run Processed with
 *      nothing written; a deliberate nothing-payable skip and an employee outside the run's chosen list do
 *      not block; an abandoned job and a superseded failure do not block.
 *   D. Permission: a caller without payroll.close is refused at the service, and the list's per-company
 *      visibility read agrees.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import * as s from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { requirePackFor } from '../localization/registry';
import {
  BatchHasFailedReprocessError,
  BatchHasPendingEmployeesError,
  BatchReprocessInProgressError,
  PayrollPermissionDeniedError,
  closeBatch,
  createAdditionalRun,
  createBatch,
  generatePayslips,
  payrollCloseCompanyIds,
  setPayrollInput,
  setPayrollPermissionGrant,
} from '../packs/payroll/service';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let b: Base;
let ctx: SessionContext;
let period: string;
let hiredOn: string;
let ic = 0;

/** Last month, through the HR date owner — a closeable, fully elapsed period. */
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
  period = lastMonth();
  hiredOn = `${Number(period.slice(0, 4)) - 1}-01-01`;
});

async function hire(
  name: string,
  code: string,
  basic: number,
  opts: { companyId?: string; departmentId?: string; on?: string } = {},
) {
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
    // r369 — a record with no monthly basic must say why.
    ...(basic === 0 ? { remarks: 'Fictional quarterly director fees' } : {}),
  });
  ic += 1;
  await requirePackFor('MY').statutory.set(ctx, { personId: e.personId, icNumber: `90010101${String(ic).padStart(4, '0')}` });
  return e.employmentId;
}

async function processedRun(p: { companyId?: string; scope?: { employmentIds: string[] } } = {}) {
  const { batchId } = await createBatch(ctx, { companyId: p.companyId ?? b.companyId, payPeriod: period, scope: p.scope });
  await generatePayslips(ctx, { batchId });
  return batchId;
}

const batchRow = async (id: string) => (await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id, id)))[0];
const eventsOf = (id: string) =>
  owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.aggregateId, id)).orderBy(s.domainEvent.id);
const periodRow = async () =>
  (
    await owner.db
      .select()
      .from(s.payPeriod)
      .where(and(eq(s.payPeriod.tenantId, b.tenantId), eq(s.payPeriod.companyId, b.companyId), eq(s.payPeriod.period, period)))
  )[0];

/** Assert a close is refused with `type` and that NOTHING on the run moved. */
async function refused<T extends Error>(batchId: string, type: new (...a: never[]) => T): Promise<T> {
  const before = { batch: await batchRow(batchId), events: await eventsOf(batchId) };
  const err = await closeBatch(ctx, { batchId }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(type);
  expect(await batchRow(batchId)).toEqual(before.batch);
  expect(before.batch.status).toBe('processed');
  expect(await eventsOf(batchId)).toEqual(before.events);
  return err as T;
}

async function job(batchId: string, p: { status: string; employmentIds: string[]; result?: unknown; ageMs?: number; createdAt?: Date }) {
  const at = new Date(Date.now() - (p.ageMs ?? 0));
  await owner.db.insert(s.payrollReprocessJob).values({
    tenantId: b.tenantId,
    batchId,
    idempotencyKey: randomUUID(),
    status: p.status,
    employmentIds: p.employmentIds,
    result: p.result ?? null,
    createdAt: p.createdAt ?? at,
    updatedAt: at,
  });
}

/** A saved per-employee outcome in the exact shape `decodeReprocessEmployeeOutcomes` accepts. */
async function outcome(batchId: string, employmentId: string, status: 'validation_failed' | 'skipped', at: Date) {
  const [slip] = await owner.db
    .select()
    .from(s.payslip)
    .where(and(eq(s.payslip.batchId, batchId), eq(s.payslip.employmentId, employmentId)));
  const [who] = await owner.db
    .select({ code: s.employment.employeeCode, name: s.person.fullName })
    .from(s.employment)
    .innerJoin(s.person, eq(s.person.id, s.employment.personId))
    .where(eq(s.employment.id, employmentId));
  const retained = status === 'validation_failed' && slip != null;
  return {
    employmentId,
    name: who.name,
    employeeCode: who.code,
    status,
    reasonCode: status === 'skipped' ? 'NOTHING_PAYABLE' : 'PAYROLL_CONFIGURATION_INCOMPLETE',
    ...(status === 'validation_failed' ? { validationCode: 'FIXTURE_GAP' } : {}),
    resultRetained: retained,
    payslipId: retained ? slip.id : null,
    versionBefore: retained ? slip.version : null,
    versionAfter: retained ? slip.version : null,
    historyId: null,
    at: at.toISOString(),
  };
}

describe('cdb1c6ca · A — Yes closes only the selected run', () => {
  it('a sibling run in the same month and another company’s run are untouched; the month closes with its last run', async () => {
    const ada = await hire('Fictional Ada', 'CB001', 5000);
    // Paid by the regular run, nothing on the bonus run: an additional run leaves her out on purpose (r226),
    // so she must not read as New / Pending there.
    await hire('Fictional Cara', 'CB006', 3000);
    const [other] = await owner.db
      .insert(s.company)
      .values({ tenantId: b.tenantId, legalName: 'Fictional Other Co', companyLabel: 'FIC-O' })
      .returning();
    const [otherDept] = await owner.db
      .insert(s.department)
      .values({ tenantId: b.tenantId, companyId: other.id, name: 'Fictional Other Dept' })
      .returning();
    await hire('Fictional Ben', 'CB900', 4000, { companyId: other.id, departmentId: otherDept.id });
    const regular = await processedRun();
    const { batchId: bonus } = await createAdditionalRun(ctx, { companyId: b.companyId, payPeriod: period, runType: 'bonus' });
    await setPayrollInput(ctx, { batchId: bonus, employmentId: ada, overtimeAmount: 0, bonusAmount: 100 });
    await generatePayslips(ctx, { batchId: bonus });
    const otherRun = await processedRun({ companyId: other.id });
    const otherBefore = await batchRow(otherRun);

    await closeBatch(ctx, { batchId: regular });
    expect((await batchRow(regular)).status).toBe('closed');
    expect((await batchRow(bonus)).status).toBe('processed');
    expect((await periodRow()).status).toBe('open');
    expect(await batchRow(otherRun)).toEqual(otherBefore);

    await closeBatch(ctx, { batchId: bonus });
    expect((await batchRow(bonus)).status).toBe('closed');
    expect((await periodRow()).status).toBe('closed');
    expect(await batchRow(otherRun)).toEqual(otherBefore);
  });
});

describe('cdb1c6ca · B — the audit record names the run', () => {
  it('payroll-batch.closed carries company, month, cycle, run identity and the status move — references only', async () => {
    await hire('Fictional Ada', 'CB001', 5000);
    const batchId = await processedRun();
    await closeBatch(ctx, { batchId });
    const [ev] = (await eventsOf(batchId)).filter((e) => e.eventType === 'payroll-batch.closed');
    expect(ev.actorId).toBe(b.adminUserId);
    expect(ev.occurredAt).toBeInstanceOf(Date);
    const run = await batchRow(batchId);
    const cycleName = run.payrollCycleId
      ? (await owner.db.select().from(s.payrollCycle).where(eq(s.payrollCycle.id, run.payrollCycleId)))[0].name
      : null;
    expect(ev.payload).toEqual({
      releasedAt: run.releasedAt!.toISOString(),
      companyId: b.companyId,
      payPeriod: period,
      payrollCycleId: run.payrollCycleId ?? null,
      payrollCycleName: cycleName,
      runType: 'regular',
      runSeq: run.runSeq,
      fromStatus: 'processed',
      toStatus: 'closed',
    });
    // ADR-0030 — no figure rides the audit payload.
    expect(JSON.stringify(ev.payload)).not.toMatch(/5000|gross|net|amount/i);
  });
});

describe('cdb1c6ca · C — outstanding work refuses the close and changes nothing', () => {
  it('an eligible employee still New / Pending blocks, named by code and name', async () => {
    await hire('Fictional Ada', 'CB001', 5000);
    const batchId = await processedRun();
    // Joins after the run was processed: eligible for the month, no payslip on the run.
    await hire('Fictional Late Joiner', 'CB002', 4200, { on: `${period}-10` });
    const err = await refused(batchId, BatchHasPendingEmployeesError);
    expect(err.employees.map((e) => [e.employeeCode, e.name])).toEqual([['CB002', 'Fictional Late Joiner']]);
    expect(Object.keys(err.employees[0]).sort()).toEqual(['employeeCode', 'employmentId', 'name']);
  });

  it('a deliberate nothing-payable skip does not block, and neither does someone outside the run’s chosen list', async () => {
    const ada = await hire('Fictional Ada', 'CB001', 5000);
    await hire('Fictional Director', 'CB003', 0); // no monthly basic, nothing keyed — Skipped, not pending
    await hire('Fictional Outsider', 'CB004', 3000); // eligible, but the run was opened for Ada only
    const batchId = await processedRun({ scope: { employmentIds: [ada] } });
    await closeBatch(ctx, { batchId });
    expect((await batchRow(batchId)).status).toBe('closed');
  });

  it('a running reprocess blocks; one abandoned past the reclaim window does not', async () => {
    const ada = await hire('Fictional Ada', 'CB001', 5000);
    const batchId = await processedRun();
    await job(batchId, { status: 'running', employmentIds: [ada], ageMs: 11 * 60 * 1000 });
    await job(batchId, { status: 'running', employmentIds: [ada] });
    await refused(batchId, BatchReprocessInProgressError);
    await owner.db
      .update(s.payrollReprocessJob)
      .set({ updatedAt: new Date(Date.now() - 11 * 60 * 1000) })
      .where(eq(s.payrollReprocessJob.batchId, batchId));
    await closeBatch(ctx, { batchId });
    expect((await batchRow(batchId)).status).toBe('closed');
  });

  it('a latest outcome of validation_failed blocks, naming the employee', async () => {
    const ada = await hire('Fictional Ada', 'CB001', 5000);
    const ben = await hire('Fictional Ben', 'CB005', 4500);
    const batchId = await processedRun();
    const t0 = new Date(Date.now() - 60_000);
    await job(batchId, {
      status: 'completed',
      employmentIds: [ada, ben],
      result: { outcomes: [await outcome(batchId, ben, 'validation_failed', t0)], selected: 2 },
      ageMs: 60_000,
    });
    const err = await refused(batchId, BatchHasFailedReprocessError);
    expect(err.employees.map((e) => e.employeeCode)).toEqual(['CB005']);
    expect(err.employees.some((e) => e.employmentId === ada)).toBe(false);
  });

  it('a stopped job blocks the people it never reached, until a later outcome supersedes it', async () => {
    const ada = await hire('Fictional Ada', 'CB001', 5000);
    const batchId = await processedRun();
    await job(batchId, { status: 'failed', employmentIds: [ada], ageMs: 120_000 });
    const err = await refused(batchId, BatchHasFailedReprocessError);
    expect(err.employees.map((e) => e.employeeCode)).toEqual(['CB001']);

    // A later attempt for Ada that did not fail clears it.
    await job(batchId, {
      status: 'completed',
      employmentIds: [ada],
      result: { outcomes: [await outcome(batchId, ada, 'skipped', new Date())], selected: 1 },
    });
    await closeBatch(ctx, { batchId });
    expect((await batchRow(batchId)).status).toBe('closed');
  });
});

describe('cdb1c6ca · D — payroll.close is enforced by the service and mirrored by the list', () => {
  it('a caller denied payroll.close for the company is refused, and the list does not offer Close there', async () => {
    await hire('Fictional Ada', 'CB001', 5000);
    const batchId = await processedRun();
    expect([...(await payrollCloseCompanyIds(ctx, [b.companyId, b.companyId]))]).toEqual([b.companyId]);
    await setPayrollPermissionGrant(
      { ...adminCtx(b), grants: [{ role: 'hr_admin', companyId: null }] },
      { companyId: b.companyId, permissionKey: 'payroll.close', role: 'hr_admin', allowed: false },
    );
    expect(await payrollCloseCompanyIds(ctx, [b.companyId])).toEqual(new Set());
    await refused(batchId, PayrollPermissionDeniedError);
  });

  it('the visibility read asks nothing for an empty list', async () => {
    expect(await payrollCloseCompanyIds(ctx, [])).toEqual(new Set());
  });
});
