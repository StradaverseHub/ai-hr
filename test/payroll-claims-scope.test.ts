/**
 * Payroll Process wizard plan — the one intended engine behaviour change: claims scope safety.
 * Before this fix, prefillClaimsForBatch queued the whole company's approved-taxable claims regardless
 * of a batch's scope, and generatePayslips marked EVERY reserved claim paid — including claims belonging
 * to people outside a filtered run, who received no payslip. This suite proves both halves of the fix:
 *   (a) prefill only reserves claims for employments in the batch's scope.
 *   (b) generation marks paid only claims whose employment actually got a payslip in THIS batch; any
 *       linked claim without a payslip here (out-of-scope) reverts to unlinked/approved so it re-queues
 *       on the next batch instead of being stranded.
 * f1564110 Phase 1 note: the comp-less variant of (b) can no longer reach generation — an in-scope
 * employee with no compensation row now HARD-BLOCKS generatePayslips (PreProcessBlockedError; see
 * payroll-preprocess-advisory.test.ts), so (b) is exercised via a post-prefill scope narrow instead.
 */
import { eq,sql } from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import { createClaimType, decideClaim, prefillClaimsForBatch, submitClaim } from '../core/claims';
import { setCompensation } from '../core/comp';
import { createBatch, generatePayslips, updateBatchScope, resolveBatchScopeFilter } from '../core/payroll';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

// The kernel judges these dates in MYT (bb4f2265); a fixture built in UTC disagrees with it
// between 00:00 and 08:00 MYT, which is a test that fails only at night.
import { todayInKualaLumpur } from '../lib/hr-date';

const hire = (ctx: SessionContext, b: Base, name: string, departmentId: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

const recent = (daysBack = 5): string =>
  new Date(new Date(`${todayInKualaLumpur()}T00:00:00Z`).getTime() - daysBack * 86400000)
    .toISOString()
    .slice(0, 10);

describe('Payroll Process wizard — claims scope safety', () => {
  let base: Base;
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

  it('shares the real department/explicit union and refuses an entire mixed subset outside the actor data ceiling',async()=>{
    const a=adminCtx(base),inside=await hire(a,base,'ScopeInside',base.deptA),outside=await hire(a,base,'ScopeOutside',base.deptB);
    const source=await withTenant(a,tx=>resolveBatchScopeFilter(tx,{departmentIds:[base.deptA],employmentIds:[inside.employmentId,outside.employmentId]}));
    expect(source.employmentIds?.slice().sort()).toEqual([inside.employmentId,outside.employmentId].sort());
    expect((await withTenant(a,tx=>resolveBatchScopeFilter(tx,null))).employmentIds).toBeNull();
    const id=randomUUID(),revision=randomUUID(),rules={legacyCompany:false,predicates:[{field:'department',values:[base.deptA]}]};
    await owner.client`insert into data_permission_profile(id,tenant_id,name) values(${id},${base.tenantId},${'Fictional payroll subset '+id})`;
    await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by) values(${revision},${base.tenantId},${id},${JSON.stringify(rules)}::text::jsonb,${a.userId!})`;
    await owner.client`update data_permission_profile set enabled=true,active_revision_id=${revision} where id=${id}`;
    await owner.client`insert into user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by) values(${base.tenantId},${a.userId!},${id},${a.userId!})`;
    const [scope]=await withTenant(a,tx=>tx.execute<{inside:boolean;outside:boolean}>(sql`select app.data_permission_matches(${inside.employmentId}::uuid) as inside,app.data_permission_matches(${outside.employmentId}::uuid) as outside`));expect(scope).toEqual({inside:true,outside:false});
    await expect(withTenant(a,tx=>resolveBatchScopeFilter(tx,{departmentIds:[base.deptA],employmentIds:[outside.employmentId]}))).rejects.toThrow();
    expect((await withTenant(a,tx=>resolveBatchScopeFilter(tx,{departmentIds:[base.deptA]}))).employmentIds).toEqual([inside.employmentId]);
  });

  it('refuses a finite reservation without its actual native input and completed audit',async()=>{
    const a=adminCtx(base),employee=await hire(a,base,'FiniteClaim',base.deptA);
    const {id:typeId}=await createClaimType(a,{code:'FINITE',name:'Finite source',defaultTaxable:true,requiresReceipt:false});
    const {id:claimId}=await submitClaim(a,{employmentId:employee.employmentId,claimTypeId:typeId,amount:89,incurredOn:recent()});
    await decideClaim(a,{claimRequestId:claimId,decision:'approve'});
    const {batchId}=await createBatch(a,{companyId:base.companyId,payPeriod:'2026-05',scope:{employmentIds:[employee.employmentId]}});
    const [before]=await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id,claimId));
    const reserve=()=>withTenant(a,async tx=>{
      await tx.execute(sql`select app.access_payroll_batch_begin(${batchId}::uuid,'edit')`);
      const rows=await tx.execute<{id:string;employment_id:string}>(sql`select * from app.payroll_claim_apply(${batchId}::uuid,'reserve',ARRAY[${claimId}::uuid],null::uuid[])`);
      expect(rows).toHaveLength(1);expect(rows[0]).toEqual({id:claimId,employment_id:employee.employmentId});
    });
    let state:string|undefined;try{await reserve();}catch(error){let cause:unknown=error;while(cause&&typeof cause==='object'){const current=cause as {code?:string;cause?:unknown};state=current.code??state;cause=current.cause;}}
    expect(state).toBe('42501');
    expect(await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id,claimId))).toEqual([before]);
    await expect(withTenant(a,tx=>tx.execute(sql`select * from app.payroll_claim_apply(${batchId}::uuid,'reserve',ARRAY[${claimId}::uuid],null::uuid[])`))).rejects.toMatchObject({cause:expect.objectContaining({code:'42501'})});
    await expect(withTenant(a,tx=>tx.execute(sql`select * from app.financial_claim_port_effect`))).rejects.toMatchObject({cause:expect.objectContaining({code:'42501'})});
  });

  it('refuses mixed agent markers at the native Claim money port before its financial effects',async()=>{
    const a=adminCtx(base),employee=await hire(a,base,'AgentClaim',base.deptA);
    const {id:typeId}=await createClaimType(a,{code:'AGENT',name:'Actor source',defaultTaxable:true,requiresReceipt:false});
    const {id:claimId}=await submitClaim(a,{employmentId:employee.employmentId,claimTypeId:typeId,amount:77,incurredOn:recent()});await decideClaim(a,{claimRequestId:claimId,decision:'approve'});
    const {batchId}=await createBatch(a,{companyId:base.companyId,payPeriod:'2026-05',scope:{employmentIds:[employee.employmentId]}});
    const [principal]=await owner.client`insert into app.ai_agent_principal(tenant_id) values(${base.tenantId}) on conflict(tenant_id) do update set tenant_id=excluded.tenant_id returning id`;
    const [before]=await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id,claimId));
    for(const marker of [principal.id as string,'invalid-agent-marker']){
      let code:string|undefined,message='';try{await withTenant(a,async tx=>{
        await tx.execute(sql`select app.access_payroll_batch_begin(${batchId}::uuid,'edit')`);
        const source=await tx.execute<{id:string}>(sql`select id from app.payroll_claim_prefill_sources(${batchId}::uuid)`);expect(source.map(row=>row.id)).toContain(claimId);
        await tx.execute(sql`select set_config('app.agent_principal_id',${marker},true)`);
        const [human]=await tx.execute<{current:boolean}>(sql`select app.principal_snapshot_current() as current`);expect(human.current).toBe(true);
        await tx.execute(sql`select * from app.payroll_claim_apply(${batchId}::uuid,'reserve',ARRAY[${claimId}::uuid],null::uuid[])`);
      });}catch(error){let cause:unknown=error;while(cause&&typeof cause==='object'){const row=cause as {code?:string;message?:string;cause?:unknown};code=row.code??code;message+=' '+(row.message??'');cause=row.cause;}}
      expect(code).toBe('42501');expect(message).toContain('Payroll claim actor unavailable');expect(await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id,claimId))).toEqual([before]);
    }
  });

  it('prefill reserves ONLY claims for employees in the batch scope', async () => {
    const a = adminCtx(base);
    const inScope = await hire(a, base, 'InScope', base.deptA);
    const outOfScope = await hire(a, base, 'OutOfScope', base.deptA);
    await setCompensation(a, { employmentId: inScope.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setCompensation(a, { employmentId: outOfScope.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });

    const { id: typeId } = await createClaimType(a, { code: 'PHONE', name: 'Phone', defaultTaxable: true, requiresReceipt: false });
    const { id: inScopeClaim } = await submitClaim(a, { employmentId: inScope.employmentId, claimTypeId: typeId, amount: 100, incurredOn: recent() });
    await decideClaim(a, { claimRequestId: inScopeClaim, decision: 'approve' });
    const { id: outOfScopeClaim } = await submitClaim(a, { employmentId: outOfScope.employmentId, claimTypeId: typeId, amount: 200, incurredOn: recent() });
    await decideClaim(a, { claimRequestId: outOfScopeClaim, decision: 'approve' });

    const { batchId } = await createBatch(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      scope: { employmentIds: [inScope.employmentId] },
    });
    const { applied, claims, total } = await prefillClaimsForBatch(a, { batchId });
    expect(applied).toBe(1);
    expect(claims).toBe(1);
    expect(total).toBeCloseTo(100, 2);

    const [inClaim] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, inScopeClaim));
    expect(inClaim.payrollBatchId).toBe(batchId);
    const [outClaim] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, outOfScopeClaim));
    expect(outClaim.payrollBatchId).toBeNull();
    expect(outClaim.status).toBe('approved');
  });

  it('generation marks paid only claims with a payslip in this batch; linked claims without a payslip re-queue', async () => {
    const a = adminCtx(base);
    const withPayslip = await hire(a, base, 'WithPayslip', base.deptA);
    const excluded = await hire(a, base, 'Excluded', base.deptA);
    await setCompensation(a, { employmentId: withPayslip.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setCompensation(a, { employmentId: excluded.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });

    const { id: typeId } = await createClaimType(a, { code: 'MEDICAL', name: 'Medical', defaultTaxable: true, requiresReceipt: false });
    const { id: claimA } = await submitClaim(a, { employmentId: withPayslip.employmentId, claimTypeId: typeId, amount: 150, incurredOn: recent() });
    await decideClaim(a, { claimRequestId: claimA, decision: 'approve' });
    const { id: claimB } = await submitClaim(a, { employmentId: excluded.employmentId, claimTypeId: typeId, amount: 250, incurredOn: recent() });
    await decideClaim(a, { claimRequestId: claimB, decision: 'approve' });

    // Whole-company batch (no scope) so both claims are reserved via the normal unscoped path.
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await prefillClaimsForBatch(a, { batchId });

    const [beforeA] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, claimA));
    const [beforeB] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, claimB));
    expect(beforeA.payrollBatchId).toBe(batchId);
    expect(beforeB.payrollBatchId).toBe(batchId);

    // Narrow the scope AFTER prefill — the excluded employee keeps a linked claim but gets no payslip.
    // (f1564110 Phase 1: the previous comp-less route to a payslip-less linked claim now hard-blocks
    // generation instead of silently dropping the employee.)
    await updateBatchScope(a, { batchId, scope: { employmentIds: [withPayslip.employmentId] } });

    await generatePayslips(a, { batchId });

    const [afterA] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, claimA));
    expect(afterA.status).toBe('paid');
    expect(afterA.payrollBatchId).toBe(batchId);

    // The scoped-out employee got no payslip → the linked claim reverts to unlinked/approved so it
    // re-queues on the next batch instead of being stranded forever.
    const [afterB] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, claimB));
    expect(afterB.status).toBe('approved');
    expect(afterB.payrollBatchId).toBeNull();
  });
});
