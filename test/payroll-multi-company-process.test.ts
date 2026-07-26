/**
 * Multi-company Payroll Process (feedback 3653d14b, Phase 1). Proves the orchestration composes the
 * existing per-company primitives WITHOUT changing the kernel, and — the two central hazards —
 *   1. one company failing (already processed this month) never aborts the run (→ overall "partial"), and
 *   2. a company outside the admin's grants becomes a NOT_AUTHORIZED row, never a widened run and never an
 *      abort (no batch is created for it).
 * Plus the pure result helpers (reason mapping, overall status, summary counts, one-shot encode/decode).
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { type SessionContext } from '../db/client';
import { setCompensation } from '../core/comp';
import { hireEmployee } from '../core/org';
import { seedPayrollCycleCatalog } from '../core/payroll-cycle';
import { createBatch } from '../core/payroll';
import {
  decodeRunGroupResult,
  encodeRunGroupResult,
  overallStatusOf,
  reasonForError,
  runMultiCompanyPayroll,
  summarize,
  type CompanyOutcome,
} from '../core/payroll-run-group';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

describe('multi-company payroll — pure helpers', () => {
  it('reasonForError maps the known engine throws to stable codes', () => {
    expect(reasonForError('A payroll process already exists for this period')).toBe('PERIOD_ALREADY_PROCESSED');
    expect(reasonForError('No localization pack for MY')).toBe('NO_PAYROLL_CONFIG');
    expect(reasonForError('something else entirely')).toBe('SYSTEM_VALIDATION_ERROR');
  });

  it('overallStatusOf: all ok → succeeded, some fail → partial, all fail → failed', () => {
    const ok: CompanyOutcome = { companyId: 'a', companyName: 'A', status: 'succeeded', employeesSelected: 1, employeesSucceeded: 1 };
    const bad: CompanyOutcome = { companyId: 'b', companyName: 'B', status: 'failed', employeesSelected: 1, employeesSucceeded: 0, reason: 'PERIOD_ALREADY_PROCESSED' };
    expect(overallStatusOf([ok, ok])).toBe('succeeded');
    expect(overallStatusOf([ok, bad])).toBe('partial');
    expect(overallStatusOf([bad, bad])).toBe('failed');
  });

  it('summarize aggregates the header counts (failed = selected − succeeded)', () => {
    const per: CompanyOutcome[] = [
      { companyId: 'a', companyName: 'A', status: 'succeeded', batchId: 'ba', employeesSelected: 3, employeesSucceeded: 2 },
      { companyId: 'b', companyName: 'B', status: 'failed', employeesSelected: 4, employeesSucceeded: 0, reason: 'PERIOD_ALREADY_PROCESSED' },
    ];
    const r = summarize('2026-05', 's', 'e', per);
    expect(r.totalCompanies).toBe(2);
    expect(r.companiesSucceeded).toBe(1);
    expect(r.companiesFailed).toBe(1);
    expect(r.totalEmployeesSelected).toBe(7);
    expect(r.totalEmployeesSucceeded).toBe(2);
    expect(r.totalEmployeesFailed).toBe(5);
    expect(r.overallStatus).toBe('partial');
  });

  it('encode/decode round-trips the result; bad input decodes to null', () => {
    const r = summarize('2026-05', 's', 'e', [
      { companyId: 'a', companyName: 'A', status: 'succeeded', batchId: 'ba', employeesSelected: 1, employeesSucceeded: 1 },
    ]);
    expect(decodeRunGroupResult(encodeRunGroupResult(r))).toEqual(r);
    expect(decodeRunGroupResult(undefined)).toBeNull();
    expect(decodeRunGroupResult('%%%not-json%%%')).toBeNull();
  });
});

describe('multi-company payroll — orchestration (DB)', () => {
  let base: Base;
  /** company B (base.companyId is company A) + a paid employee in each. */
  let companyB: string;
  let deptB: string;
  /**
   * ADR-0077 slice 3 — this tenant's REAL entitlement snapshot, resolved once per test in `beforeEach`.
   *
   * This file mutates no gate and never did (it carries no env write), but it is still affected by the
   * flip: both contexts below are hand-built literals, and `generatePayslips` now asks
   * `isModuleEnabled(ctx, 'typed_pay_components')` (core/payroll.ts:1857, :2512) plus
   * `settingEnabled(ctx, 'payroll.individual_txn_pay_enabled')` (:2612). A context carrying neither a
   * snapshot nor an exempt marker makes those throw `EntitlementsUnresolvedError`, so the whole
   * orchestration describe block failed for a wiring reason, not a behavioural one.
   *
   * The snapshot is attached rather than `entitlementsExempt: 'harness'` because an exempt context
   * answers TRUE for every catalogued module — which would silently switch the typed-pay-component
   * earnings source ON for a test that has always exercised the legacy path, i.e. it would make the
   * file green while changing what it proves. Resolved from the tenant's rows, `typed_pay_components`
   * has NO row (test/env.ts deletes TYPED_PAY_COMPONENTS_ENABLED, so `seedBase` seeds none) and a
   * missing row is disabled — exactly the pre-slice-3 env answer.
   *
   * Only `entitlements` is taken from `entitledCtx`, NOT the whole context: `entitledCtx` also sets
   * `roles: ['hr_admin']`, and spreading that into the company-SCOPED admin below would hand it a
   * group-wide role alongside its single-company grant — the precise widening HAZARD 1 asserts against.
   */
  let entitlements: SessionContext['entitlements'];

  /** A GROUP admin (grants: company-null hr_admin) — allowedCompanies returns every company in the tenant. */
  function groupAdmin(): SessionContext {
    return { tenantId: base.tenantId, userId: base.adminUserId, grants: [{ role: 'hr_admin', companyId: null }], entitlements };
  }

  /** A COMPANY-SCOPED admin (grant to a single company) — allowedCompanies returns only that company. */
  async function scopedAdminFor(companyId: string): Promise<SessionContext> {
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
      .returning({ id: schema.appUser.id });
    await owner.db.insert(schema.roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId, role: 'hr_admin' });
    return { tenantId: base.tenantId, userId: u.id, grants: [{ role: 'hr_admin', companyId }], entitlements };
  }

  async function seedPaidEmployee(ctx: SessionContext, companyId: string, departmentId: string, name: string) {
    const e = await hireEmployee(ctx, {
      person: { fullName: name, primaryEmail: `${name.toLowerCase()}@mc.test` },
      companyId,
      departmentId,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(ctx, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    return e.employmentId;
  }

  /** The active regular ("Monthly") cycle id for a company. */
  async function regularCycleId(companyId: string): Promise<string> {
    const [row] = await owner.db
      .select({ id: schema.payrollCycle.id })
      .from(schema.payrollCycle)
      .where(and(eq(schema.payrollCycle.companyId, companyId), eq(schema.payrollCycle.runType, 'regular')));
    return row.id;
  }

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    // Point-in-time read, exactly as a real session takes it — so it must come after seedBase has
    // written the tenant's rows and before the first context is built from it.
    entitlements = (await entitledCtx(base)).entitlements;
    const a = groupAdmin();
    const [c2] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Beta Sdn Bhd' })
      .returning({ id: schema.company.id });
    companyB = c2.id;
    const [dB] = await owner.db
      .insert(schema.department)
      .values({ tenantId: base.tenantId, companyId: companyB, name: 'Beta Ops' })
      .returning({ id: schema.department.id });
    deptB = dB.id;
    await seedPayrollCycleCatalog(a, base.companyId);
    await seedPayrollCycleCatalog(a, companyB);
    await seedPaidEmployee(a, base.companyId, base.deptA, 'Alice');
    await seedPaidEmployee(a, companyB, deptB, 'Bob');
  });
  afterAll(async () => {
    await closeAll();
  });

  it('processes two companies in one run; each gets its own paid payslip', async () => {
    const a = groupAdmin();
    const result = await runMultiCompanyPayroll(a, {
      companyIds: [base.companyId, companyB],
      payPeriod: '2026-05',
      payrollCycleId: await regularCycleId(base.companyId),
      employmentIds: [],
    });
    expect(result.overallStatus).toBe('succeeded');
    expect(result.totalCompanies).toBe(2);
    expect(result.totalEmployeesSucceeded).toBe(2);
    // A batch exists for each company this period.
    const batches = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.payPeriod, '2026-05'));
    expect(new Set(batches.map((b) => b.companyId))).toEqual(new Set([base.companyId, companyB]));
  });

  it('HAZARD 2: one company already processed this month → that company fails, the other still runs (partial)', async () => {
    const a = groupAdmin();
    // Pre-create the regular run for company A so createBatch throws PERIOD_ALREADY_PROCESSED for it.
    await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });

    const result = await runMultiCompanyPayroll(a, {
      companyIds: [base.companyId, companyB],
      payPeriod: '2026-05',
      payrollCycleId: await regularCycleId(base.companyId),
      employmentIds: [],
    });

    expect(result.overallStatus).toBe('partial');
    const outA = result.perCompany.find((c) => c.companyId === base.companyId)!;
    const outB = result.perCompany.find((c) => c.companyId === companyB)!;
    expect(outA.status).toBe('failed');
    expect(outA.reason).toBe('PERIOD_ALREADY_PROCESSED');
    expect(outB.status).toBe('succeeded');
    expect(outB.employeesSucceeded).toBe(1);
    // Company B was still processed — its payslip exists.
    const bBatch = await owner.db.select().from(schema.payrollBatch).where(and(eq(schema.payrollBatch.companyId, companyB), eq(schema.payrollBatch.payPeriod, '2026-05')));
    expect(bBatch).toHaveLength(1);
  });

  it('HAZARD 1: a company outside the admin grants → NOT_AUTHORIZED row, no batch created, run not aborted', async () => {
    // A scoped admin that can only access company A submits BOTH A and B.
    const scoped = await scopedAdminFor(base.companyId);
    const result = await runMultiCompanyPayroll(scoped, {
      companyIds: [base.companyId, companyB],
      payPeriod: '2026-05',
      payrollCycleId: await regularCycleId(base.companyId),
      employmentIds: [],
    });

    expect(result.overallStatus).toBe('partial');
    const outA = result.perCompany.find((c) => c.companyId === base.companyId)!;
    const outB = result.perCompany.find((c) => c.companyId === companyB)!;
    expect(outA.status).toBe('succeeded'); // the authorized company still ran
    expect(outB.status).toBe('failed');
    expect(outB.reason).toBe('NOT_AUTHORIZED');
    // The run was NOT widened: no batch was created for company B.
    const bBatch = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.companyId, companyB));
    expect(bBatch).toHaveLength(0);
  });

  it('appends one run-group.completed DomainEvent for the whole run', async () => {
    const a = groupAdmin();
    await runMultiCompanyPayroll(a, {
      companyIds: [base.companyId, companyB],
      payPeriod: '2026-05',
      payrollCycleId: await regularCycleId(base.companyId),
      employmentIds: [],
    });
    const evs = await owner.db
      .select({ t: schema.domainEvent.eventType, agg: schema.domainEvent.aggregateType })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, base.tenantId), eq(schema.domainEvent.eventType, 'payroll-run-group.completed')));
    expect(evs).toHaveLength(1);
    expect(evs[0].agg).toBe('payroll-run-group');
  });
});
