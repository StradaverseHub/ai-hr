/** ADR 0181 queues addendum Q0: the account task statement's replacement and claims sections read the caller's own
 * employments once (`own`, core/approvals.ts callerOwnEmploymentIdsSql), as the other sections do, instead of each
 * re-reading the subject's employment row; and a review stage the caller can decide nothing in returns its empty array
 * without reading the headers. Each section must answer exactly as before, for an administrator, a manager deciding
 * for a report and blocked from their own request, an employee and a person-less caller, under "All companies" and one
 * company. Fictional people. */
import {randomUUID} from 'node:crypto';
import {sql,type SQL} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {accountTaskCallerSql,ACCOUNT_TASK_CLAIM_PREVIEW} from '../core/account-task-bundle';
import {pendingReplacementLeaveTaskBundleSql} from '../core/replacement-request';
import {pendingClaimTaskPreviewBundleSql} from '../core/claims';
import {pendingReviewTaskBundleSql,pendingReviewTaskMetadata} from '../core/employment-review';
import * as claims from '../packs/claims/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

const OWN=sql`cast((select task_caller.own_ids from task_caller) as uuid[])`;
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'claims','active');});
const date=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T12:00:00Z')+offset*86400000).toISOString().slice(0,10);
async function employee(name:string,manager?:string){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:date(-800),reportingManagerEmploymentId:manager});
 const ctx:SessionContext={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,hired.personId,'employee'),personId:hired.personId,roles:['employee'],entitlements:harnessSnapshot(b.tenantId)};
 return {...hired,ctx};
}
async function sections(ctx:SessionContext,companyIds:string[]|undefined){
 const pair=(own:SQL,plain:SQL)=>sql`jsonb_build_array(${own},${plain})`;
 return withTenant(ctx,async tx=>{
  const [row]=await tx.execute<{replacement:[unknown,unknown];claims:[unknown,unknown]}>(sql`with ${accountTaskCallerSql(ctx)} select
   ${pair(pendingReplacementLeaveTaskBundleSql(ctx,companyIds,OWN),pendingReplacementLeaveTaskBundleSql(ctx,companyIds))} as replacement,
   ${pair(pendingClaimTaskPreviewBundleSql(ctx,ACCOUNT_TASK_CLAIM_PREVIEW,companyIds,OWN),pendingClaimTaskPreviewBundleSql(ctx,ACCOUNT_TASK_CLAIM_PREVIEW,companyIds))} as claims,
   ${pendingReviewTaskBundleSql(tx,ctx,'hr',companyIds,OWN)} as hr_reviews,${pendingReviewTaskBundleSql(tx,ctx,'manager',companyIds,OWN)} as manager_reviews`);
  return row as typeof row&{hr_reviews:unknown[];manager_reviews:unknown[]};
 });
}

describe('account task sections with the caller-own set',()=>{
 it('answer exactly as the row tests did, for every caller and scope',async()=>{
  const admin=await entitledCtx(b);
  const manager=await employee('Fictional section manager'),report=await employee('Fictional section report',manager.employmentId);
  const bystander=await employee('Fictional section bystander');
  manager.ctx.entitlements=admin.entitlements;report.ctx.entitlements=admin.entitlements;bystander.ctx.entitlements=admin.entitlements;
  const type=await claims.createClaimType(admin,{code:'Q0_OWN',name:'Fictional Q0 claim',requiresReceipt:false,defaultTaxable:false});
  // Work for the manager to decide (the report's), and the manager's own, which the self ban refuses to everyone but a super administrator.
  for(const who of [report,manager,bystander]){
   await owner.db.insert(s.claimRequest).values(Array.from({length:2},()=>({tenantId:b.tenantId,employmentId:who.employmentId,claimTypeId:type.id,amount:'1',incurredOn:date(0),status:'pending' as const})));
   await owner.db.insert(s.replacementLeaveRequest).values({tenantId:b.tenantId,employmentId:who.employmentId,unit:'day',totalDays:'1',reason:'Fictional private replacement reason',submittedOn:date(0)});
  }
  const managerCtx=manager.ctx;
  const personless:SessionContext={...bystander.ctx,personId:undefined};
  const callers:[string,SessionContext][]=[['admin',admin],['manager',managerCtx],['report',report.ctx],['bystander',bystander.ctx],['personless',personless]];
  let decided=0;
  for(const [name,ctx] of callers)for(const scope of [undefined,[b.companyId]]){
   const row=await sections(ctx,scope);
   expect(row.replacement[0],name+' replacement').toEqual(row.replacement[1]);
   expect(row.claims[0],name+' claims').toEqual(row.claims[1]);
   decided+=(row.replacement[0] as unknown[]).length+((row.claims[0] as {total:number}).total);
   const admins=(ctx.roles??[]).some(role=>role==='hr_admin'||role==='super_admin');
   if(!admins){
    expect(row.hr_reviews,name+' hr reviews').toEqual([]);
    if(ctx.personId!=null)expect(await pendingReviewTaskMetadata(ctx,'hr',scope),name+' hr review owner').toEqual([]);
    if(ctx.personId==null)expect(row.manager_reviews,name+' manager reviews').toEqual([]);
   }
  }
  // The fixture exercised real decisions, not only empty sections.
  expect(decided).toBeGreaterThan(0);
  const managerRow=await sections(managerCtx,undefined);
  expect((managerRow.replacement[0] as {personId:string}[]).map(row=>row.personId)).toEqual([report.personId]);
 },60_000);
});
