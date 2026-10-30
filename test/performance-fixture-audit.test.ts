/** Native reproduction of the performance fixture's audit boundary, without a production build. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {createClaimType} from '../packs/claims/service';
import {createBatch} from '../packs/payroll/service';
import {verifyTenantChain} from '../core/audit-chain';
import {todayInKualaLumpur} from '../lib/hr-date';
import {fixtureAuditCounts,assertFixtureAudit} from '../scripts/performance/fixture-audit';
beforeAll(migrateTestDb);afterAll(closeAll);
it('retains only the canonical initialization prefix while chaining fixture domain and raw grant writes',async()=>{
 await resetDb();const previous=process.env.AUDIT_HASH_CHAIN_ENABLED;
 process.env.AUDIT_HASH_CHAIN_ENABLED='true';
 try{
  const b=await seedBase(),ctx=adminCtx(b);
  await createClaimType(ctx,{code:'AUDIT_FIXTURE',name:'Fictional audit fixture',defaultTaxable:false,requiresReceipt:false});
  await createBatch(ctx,{companyId:b.companyId,payPeriod:todayInKualaLumpur().slice(0,7)});
  const subject=await hireEmployee(ctx,{person:{fullName:'Fictional chained fixture person',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2025-01-01'});
  const userId=randomUUID();
  await owner.db.insert(s.appUser).values({id:userId,tenantId:b.tenantId,personId:subject.personId,workosUserId:'fixture_'+userId});
  await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:userId,role:'employee',companyId:b.companyId});
  const rows=await owner.db.select({type:s.domainEvent.eventType,sequence:s.domainEvent.chainSeq}).from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId));
  expect(rows.filter(row=>row.sequence===null)).toEqual([{type:'access-configuration.initialized',sequence:null}]);
  const chained=rows.filter(row=>row.sequence!==null);expect(chained.length).toBeGreaterThan(0);
  const counts=await fixtureAuditCounts(owner.client,[b.tenantId]);
  expect(counts).toEqual([{tenant_id:b.tenantId,events:rows.length,chained:chained.length,initialization_prefix:1}]);
  expect(()=>assertFixtureAudit(counts,[b.tenantId])).not.toThrow();
  expect(()=>assertFixtureAudit([{...counts[0],events:rows.length+1}],[b.tenantId])).toThrow();
  expect(()=>assertFixtureAudit(counts,[randomUUID()])).toThrow();
  expect(await verifyTenantChain(ctx)).toMatchObject({valid:true,checked:chained.length,unchained:1,unchainedInsideChain:0});
 }finally{
  if(previous===undefined)delete process.env.AUDIT_HASH_CHAIN_ENABLED;else process.env.AUDIT_HASH_CHAIN_ENABLED=previous;
 }
});
