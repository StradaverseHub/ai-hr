/**
 * Multi-company Payroll Process (feedback 3653d14b, Phase 1). Proves the orchestration composes the
 * existing per-company primitives WITHOUT changing the kernel, and — the two central hazards —
 *   1. one company failing (already processed this month) never aborts the run (→ overall "partial"), and
 *   2. a company outside the admin's grants becomes a NOT_AUTHORIZED row, never a widened run and never an
 *      abort (no batch is created for it).
 * Plus the pure result helpers (reason mapping, overall status, summary counts, one-shot encode/decode).
 */
import { readFileSync } from 'node:fs';
import { NonCashBenefitConfigurationError } from '../localization/noncash-benefits';
import { TaxSelectionError } from '../localization/my/tax-selection';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import { type SessionContext } from '../db/client';
import { setCompensation } from '../core/comp';
import { hireEmployee, terminateEmployment } from '../core/org';
import { seedPayrollCycleCatalog, listPayrollCycles, setPayrollCycleActive } from '../core/payroll-cycle';
import * as payrollRead from '../core/read';
import { createBatch } from '../core/payroll';
import {
  decodeRunGroupResult,
  encodeRunGroupResult,
  overallStatusOf,
  reasonForError,
  reasonForPayrollError,
  runMultiCompanyPayroll,
  saveMultiCompanyPayrollDrafts,
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

  it('typed wizard failures retain safe reasons through result transport and every locale', () => {
    const errors = [
      ...(['confirmation_required','invalid_scheme','citizenship_unknown','not_resident'] as const).map(code=>new TaxSelectionError(code)),
      ...(['classification_conflict','unsupported_kind','normal_remuneration_required','month_baseline_unavailable'] as const).map(reason=>new NonCashBenefitConfigurationError('PRIVATE_COMPONENT',reason)),
    ];
    const expected = ['TAX_SELECTION_CONFIRMATION_REQUIRED','TAX_SELECTION_INVALID_SCHEME','TAX_SELECTION_CITIZENSHIP_UNKNOWN','TAX_SELECTION_NOT_RESIDENT','NON_CASH_CLASSIFICATION_CONFLICT','NON_CASH_UNSUPPORTED_KIND','NON_CASH_NORMAL_REMUNERATION_REQUIRED','NON_CASH_MONTH_BASELINE_UNAVAILABLE'];
    errors.forEach((error,i)=>{
      const reason=reasonForPayrollError(error);expect(reason).toBe(expected[i]);
      const result=summarize('2026-07','s','e',[{companyId:'a',companyName:'A',status:'failed',employeesSelected:1,employeesSucceeded:0,reason}]);
      const encoded=encodeRunGroupResult(result);expect(encoded).not.toContain('PRIVATE_COMPONENT');expect(decodeRunGroupResult(encoded)?.perCompany[0].reason).toBe(reason);
      for(const locale of ['en','ms','zh','ta','th','vi']){const messages=JSON.parse(readFileSync(new URL(`../messages/${locale}.json`,import.meta.url),'utf8'));expect(messages.payroll.process.reason[reason]).toBeTruthy();}
    });
    for(const code of ['not_found','invalid_period','stale_context'] as const)expect(reasonForPayrollError(new TaxSelectionError(code))).toBe('SYSTEM_VALIDATION_ERROR');
    expect(reasonForPayrollError(new Error('private SQL failure'))).toBe('SYSTEM_VALIDATION_ERROR');expect(reasonForPayrollError(null)).toBe('SYSTEM_VALIDATION_ERROR');
    expect(reasonForPayrollError(new Error('No localization pack for MY'))).toBe('NO_PAYROLL_CONFIG');
    const actions=readFileSync(new URL('../app/(app)/payroll/process/actions.ts',import.meta.url),'utf8');
    const orchestration=readFileSync(new URL('../core/payroll-run-group.ts',import.meta.url),'utf8');
    expect(actions).toContain('reason: reasonForPayrollError(e)');expect(orchestration).toContain('reason: reasonForPayrollError(e)');
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
   * A real snapshot is attached rather than an exemption marker because an exempt context cannot
   * answer a BILLABLE module question at all: before slice 3 it answered TRUE — silently switching the
   * typed-pay-component earnings source ON for a test that has always exercised the legacy path, i.e.
   * making the file green while changing what it proves — and as of slice 3 it THROWS
   * EntitlementsExemptForBillableError instead. Resolved from the tenant's rows, `typed_pay_components`
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

  it('saves both selected Regular company drafts with exact scope/date/cycle and no generated payslips; repeat refuses duplicate creation',async()=>{
    const a=groupAdmin(),emps=await owner.db.select().from(schema.employment).orderBy(schema.employment.id);
    const selected=emps.filter(e=>[base.companyId,companyB].includes(e.companyId)).map(e=>e.id);
    const input={companyIds:[base.companyId,companyB],payPeriod:'2026-05',payrollCycleId:await regularCycleId(base.companyId),employmentIds:selected,explicitSelection:true,paymentDate:'2026-05-25'};
    const saved=await saveMultiCompanyPayrollDrafts(a,input);
    expect(saved.mode).toBe('draft');expect(saved.companiesSucceeded).toBe(2);expect(saved.totalEmployeesSucceeded).toBe(0);expect(saved.totalEmployeesFailed).toBe(0);
    const batches=await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.payPeriod,input.payPeriod)).orderBy(schema.payrollBatch.id);expect(batches).toHaveLength(2);
    for(const batch of batches){expect(batch.status).toBe('draft');expect(batch.batchDate).toBe(input.paymentDate);expect(batch.payrollCycleId).toBe(await regularCycleId(batch.companyId));expect(batch.scope).toEqual({employmentIds:emps.filter(e=>e.companyId===batch.companyId).map(e=>e.id)});}
    expect(await owner.db.select().from(schema.payslip).orderBy(schema.payslip.id)).toHaveLength(0);
    const repeated=await saveMultiCompanyPayrollDrafts(a,input);expect(repeated.companiesSucceeded).toBe(0);expect(repeated.perCompany.every(c=>c.reason==='PERIOD_ALREADY_PROCESSED')).toBe(true);expect(await owner.db.select().from(schema.payrollBatch).orderBy(schema.payrollBatch.id)).toHaveLength(2);expect(await owner.db.select().from(schema.payslip).orderBy(schema.payslip.id)).toHaveLength(0);
  });

  it.each(['draft','process'] as const)('%s never widens an explicit company-empty subset to all employees',async mode=>{
    const a=groupAdmin(),[alice]=await owner.db.select().from(schema.employment).where(eq(schema.employment.companyId,base.companyId)).orderBy(schema.employment.id);
    const action=mode==='draft'?saveMultiCompanyPayrollDrafts:runMultiCompanyPayroll;
    const result=await action(a,{companyIds:[base.companyId,companyB],payPeriod:'2026-05',payrollCycleId:await regularCycleId(base.companyId),employmentIds:[alice.id],explicitSelection:true});
    expect(result.perCompany.find(c=>c.companyId===companyB)).toMatchObject({status:'failed',reason:'EMPTY_SELECTION',employeesSelected:0});
    const batches=await owner.db.select().from(schema.payrollBatch).orderBy(schema.payrollBatch.id);expect(batches).toHaveLength(1);expect(batches[0].companyId).toBe(base.companyId);expect(batches[0].scope).toEqual({employmentIds:[alice.id]});
    const slips=await owner.db.select().from(schema.payslip).orderBy(schema.payslip.id);expect(slips.every(slip=>slip.employmentId===alice.id)).toBe(true);
  });

  it.each(['draft','process'] as const)('%s refuses touched-empty and stale employee selections without creating runs',async mode=>{
    const a=groupAdmin(),action=mode==='draft'?saveMultiCompanyPayrollDrafts:runMultiCompanyPayroll;
    for(const employmentIds of [[],[randomUUID()]]) {
      const result=await action(a,{companyIds:[base.companyId,companyB],payPeriod:'2026-05',payrollCycleId:await regularCycleId(base.companyId),employmentIds,explicitSelection:true});
      expect(result.companiesSucceeded).toBe(0);expect(result.perCompany.every(c=>c.reason===(employmentIds.length?'INVALID_SELECTION':'EMPTY_SELECTION'))).toBe(true);
      expect(await owner.db.select().from(schema.payrollBatch).orderBy(schema.payrollBatch.id)).toHaveLength(0);expect(await owner.db.select().from(schema.payslip).orderBy(schema.payslip.id)).toHaveLength(0);
    }
  });

  it('draft scope uses the Payroll period population, retaining a mid-period leaver',async()=>{
    const a=groupAdmin(),employees=await owner.db.select().from(schema.employment).where(eq(schema.employment.companyId,base.companyId)).orderBy(schema.employment.id);expect(employees).toHaveLength(1);const employee=employees[0];
    await terminateEmployment(a,{employmentId:employee.id,terminationDate:'2026-05-15'});
    const result=await saveMultiCompanyPayrollDrafts(a,{companyIds:[base.companyId],payPeriod:'2026-05',payrollCycleId:await regularCycleId(base.companyId),employmentIds:[employee.id],explicitSelection:true});
    expect(result.companiesSucceeded).toBe(1);const batches=await owner.db.select().from(schema.payrollBatch).orderBy(schema.payrollBatch.id);expect(batches).toHaveLength(1);expect(batches[0].scope).toEqual({employmentIds:[employee.id]});expect(batches[0].status).toBe('draft');
  });

  it('simultaneous Regular draft saves create only one batch and no payslips',async()=>{
    const a=groupAdmin(),input={companyIds:[base.companyId],payPeriod:'2026-05',payrollCycleId:await regularCycleId(base.companyId),employmentIds:[]};
    const results=await Promise.all([saveMultiCompanyPayrollDrafts(a,input),saveMultiCompanyPayrollDrafts(a,input)]);expect(results.reduce((n,r)=>n+r.companiesSucceeded,0)).toBe(1);
    expect(await owner.db.select().from(schema.payrollBatch).orderBy(schema.payrollBatch.id)).toHaveLength(1);expect(await owner.db.select().from(schema.payslip).orderBy(schema.payslip.id)).toHaveLength(0);
  });

  it.each(['draft','process'] as const)('%s refuses unknown, empty and deactivated selected cycles even when Regular remains available',async mode=>{
    const a=groupAdmin(),action=mode==='draft'?saveMultiCompanyPayrollDrafts:runMultiCompanyPayroll;
    const bonus=(await listPayrollCycles(a,base.companyId,{activeOnly:true})).find(c=>c.runType==='bonus');expect(bonus).toBeDefined();
    await setPayrollCycleActive(a,{id:bonus!.id,active:false});
    for(const payrollCycleId of [randomUUID(),'',bonus!.id]) {
      const result=await action(a,{companyIds:[base.companyId,companyB],payPeriod:'2026-05',payrollCycleId,employmentIds:[]});
      expect(result.companiesSucceeded).toBe(0);expect(result.perCompany.every(c=>c.reason==='INVALID_CYCLE')).toBe(true);
      expect(await owner.db.select().from(schema.payrollBatch).orderBy(schema.payrollBatch.id)).toHaveLength(0);expect(await owner.db.select().from(schema.payslip).orderBy(schema.payslip.id)).toHaveLength(0);
    }
  });

  it.each(['draft','process'] as const)('%s retains per-company population failures and safely proceeds only for proven scopes',async mode=>{
    const a=groupAdmin(),action=mode==='draft'?saveMultiCompanyPayrollDrafts:runMultiCompanyPayroll,read=payrollRead.listEmployeesForPayrollRun;
    const spy=vi.spyOn(payrollRead,'listEmployeesForPayrollRun').mockImplementation((ctx,ids,period)=>{
      if((Array.isArray(ids)?ids:[ids]).includes(companyB))return Promise.reject(new Error('PRIVATE reader failure'));
      return read(ctx,ids,period);
    });
    try {
      const result=await action(a,{companyIds:[base.companyId,companyB],payPeriod:'2026-05',payrollCycleId:await regularCycleId(base.companyId),employmentIds:[]});
      expect(result.perCompany.find(c=>c.companyId===base.companyId)?.status).toBe('succeeded');expect(result.perCompany.find(c=>c.companyId===companyB)).toMatchObject({status:'failed',reason:'SYSTEM_VALIDATION_ERROR'});
      expect(JSON.stringify(result)).not.toContain('PRIVATE');const batches=await owner.db.select().from(schema.payrollBatch).orderBy(schema.payrollBatch.id);expect(batches).toHaveLength(1);expect(batches[0].companyId).toBe(base.companyId);
    } finally {spy.mockRestore();}
  });

  it.each(['draft','process'] as const)('%s refuses the whole unproven explicit selection when a selected ID may belong to an unreadable company',async mode=>{
    const a=groupAdmin(),action=mode==='draft'?saveMultiCompanyPayrollDrafts:runMultiCompanyPayroll,read=payrollRead.listEmployeesForPayrollRun;
    const employees=await owner.db.select().from(schema.employment).orderBy(schema.employment.id);
    const spy=vi.spyOn(payrollRead,'listEmployeesForPayrollRun').mockImplementation((ctx,ids,period)=>{
      if((Array.isArray(ids)?ids:[ids]).includes(companyB))return Promise.reject(new Error('PRIVATE reader failure'));
      return read(ctx,ids,period);
    });
    try {
      const result=await action(a,{companyIds:[base.companyId,companyB],payPeriod:'2026-05',payrollCycleId:await regularCycleId(base.companyId),employmentIds:employees.map(e=>e.id),explicitSelection:true});
      expect(result.companiesSucceeded).toBe(0);expect(result.perCompany.every(c=>c.reason==='SYSTEM_VALIDATION_ERROR')).toBe(true);
      expect(await owner.db.select().from(schema.payrollBatch).orderBy(schema.payrollBatch.id)).toHaveLength(0);expect(await owner.db.select().from(schema.payslip).orderBy(schema.payslip.id)).toHaveLength(0);
    } finally {spy.mockRestore();}
  });

  it('draft saving retains per-company authorization and never creates a run outside the grant',async()=>{
    const scoped=await scopedAdminFor(base.companyId),result=await saveMultiCompanyPayrollDrafts(scoped,{companyIds:[base.companyId,companyB],payPeriod:'2026-05',payrollCycleId:await regularCycleId(base.companyId),employmentIds:[]});
    expect(result.perCompany.find(c=>c.companyId===companyB)).toMatchObject({status:'failed',reason:'NOT_AUTHORIZED'});
    const batches=await owner.db.select().from(schema.payrollBatch).orderBy(schema.payrollBatch.id);expect(batches).toHaveLength(1);expect(batches[0].companyId).toBe(base.companyId);expect(batches[0].status).toBe('draft');
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
