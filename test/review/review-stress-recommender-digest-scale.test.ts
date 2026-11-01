/** REVIEW (stress and concurrency) — the approver recommendation and the daily digest on larger tenants.
 * Written as if at test/review/recommender-digest-scale.test.ts. Fixtures are fictional; bulk rows go in through owner.db.
 *
 *  - core/recommenders/leave-decision.ts:122-125 reads the caller's 200 most recent approved and 200 most recent
 *    pending requests ACROSS EVERYTHING THE CALLER CAN SEE and marks own_overlap "missing" when either list is
 *    full. Any approver who can see 200 approved requests (a manager of a busy team, any HR approver) therefore
 *    never gets recommend_approve, whatever the applicant's own leave is.
 *  - core/recommenders/leave-decision.ts:130 and core/proposals/leave-decide.ts:46 call plannedAbsences without
 *    personIds, which loads every active employment the caller can see (core/read.ts:2051-2090).
 *  - latestDailyDigest (core/digest/daily-digest.ts:103-106) and the registry's lastRunTx
 *    (core/agent-registry/views.ts:35-36) filter teras_outcome_record by grantor_user_id / agent_identity, for
 *    which migration 0890 creates no index (0890:161-163). */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as schema from '../../db/schema';
import type {SessionContext} from '../../db/client';
import {hireEmployee,setReportingLine} from '../../core/org';
import {requestLeave} from '../../packs/leave/service';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {setWorkerSwitch} from '../../core/agent-registry/controls';
import {recommendLeaveDecision} from '../../core/recommenders/leave-decision';
import {digestPreview} from '../../core/digest/daily-digest';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from '../harness';

let b:Base,hr:SessionContext,manager:SessionContext,applicant:{employmentId:string;personId:string;ctx:SessionContext},colleague:{employmentId:string},requestId:string,date:string;
async function login(name:string,role:'employee'|'manager'|'hr_admin'){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,role);
 await owner.db.insert(schema.leaveLedger).values({tenantId:b.tenantId,employmentId:hired.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:todayInKualaLumpur()});
 return{...hired,ctx:{...await entitledCtx(b,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]} as SessionContext};
}
/** `count` distinct weekdays strictly before `before`, newest first. */
function pastWeekdays(before:string,count:number):string[]{
 const out:string[]=[],day=new Date(before+'T00:00:00Z');
 while(out.length<count){day.setUTCDate(day.getUTCDate()-1);if(![0,6].includes(day.getUTCDay()))out.push(day.toISOString().slice(0,10));}
 return out;
}
async function approvedLeave(employmentId:string,dates:readonly string[]){
 const requests=await owner.db.insert(schema.leaveRequest).values(dates.map(day=>({tenantId:b.tenantId,employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:day,endDate:day,days:'1',status:'approved' as const})))
  .returning({id:schema.leaveRequest.id,startDate:schema.leaveRequest.startDate});
 await owner.db.insert(schema.leaveRequestDate).values(requests.map(row=>({tenantId:b.tenantId,leaveRequestId:row.id,subjectEmploymentId:employmentId,leaveDate:String(row.startDate),days:'1',status:'approved' as const})));
}

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 hr=(await login('Fictional Scale Administrator','hr_admin')).ctx;
 const boss=await login('Fictional Scale Manager','manager');manager=boss.ctx;
 applicant=await login('Fictional Scale Applicant','employee');
 colleague=await login('Fictional Scale Colleague','employee');
 for(const report of [applicant.employmentId,colleague.employmentId])
  await setReportingLine(adminCtx(b),{subordinateEmploymentId:report,managerEmploymentId:boss.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const next=new Date(todayInKualaLumpur()+'T00:00:00Z');do{next.setUTCDate(next.getUTCDate()+1);}while([0,6].includes(next.getUTCDay()));date=next.toISOString().slice(0,10);
 requestId=(await requestLeave(applicant.ctx,{employmentId:applicant.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date,durationType:'full_day',reason:'Fictional scale reason'})).leaveRequestId;
 await setWorkerSwitch(hr,{workerId:'approver_recommendation',enabled:true});
});

describe('recommendation at scale',()=>{
 it('REVIEW pass: baseline: with little history the clean request is recommended for approval',async()=>{
  const result=await recommendLeaveDecision(manager,{leaveRequestId:requestId});
  expect(result.kind==='recommendation'&&result.recommendation.verdict).toBe('recommend_approve');
 },60_000);

 it('REVIEW medium: 200 visible approved requests of OTHER people do not make the applicant\'s own-overlap check "missing" (leave-decision.ts:122-125)',async()=>{
  // The colleague (another direct report the manager can see) has 200 approved single days in the past. None
  // overlaps the applicant's request; the applicant has no other leave at all.
  await approvedLeave(colleague.employmentId,pastWeekdays(todayInKualaLumpur(),200));
  const started=Date.now();
  const result=await recommendLeaveDecision(manager,{leaveRequestId:requestId});
  expect(Date.now()-started).toBeLessThan(20_000);
  expect(result.kind).toBe('recommendation');if(result.kind!=='recommendation')return;
  expect(result.recommendation.checks.find(check=>check.check==='own_overlap')?.result).toBe('pass');
  expect(result.recommendation.verdict).toBe('recommend_approve');
 },60_000);
});

describe('large tenant (2000 employments)',()=>{
 it('REVIEW medium: the inbox digest for an administrator stays within a bounded time on 2000 employments (daily-digest.ts:54-80)',async()=>{
  const people=await owner.db.insert(schema.person).values(Array.from({length:2000},(_,i)=>({tenantId:b.tenantId,fullName:`Fictional Bulk Person ${i}`,primaryEmail:`${randomUUID()}@fixture.test`})))
   .returning({id:schema.person.id});
  const employments=await owner.db.insert(schema.employment).values(people.map(row=>({tenantId:b.tenantId,personId:row.id,companyId:b.companyId,hiredOn:'2020-01-01'})))
   .returning({id:schema.employment.id});
  expect(employments).toHaveLength(2000);
  // A pending request for every 10th person, so the administrator's queue is non-trivial.
  await owner.db.insert(schema.leaveRequest).values(employments.filter((_,i)=>i%10===0).map(row=>({tenantId:b.tenantId,employmentId:row.id,leaveTypeId:b.annualLeaveTypeId,
   startDate:date,endDate:date,days:'1',status:'pending' as const})));
  const started=Date.now();
  const digest=await digestPreview(hr);
  const elapsed=Date.now()-started;
  expect(digest.kind).toBe('teras.daily_digest');
  // The inbox computes this on every render (app/assistant/centre/inbox.tsx:52), next to its own listPendingTasks.
  expect(elapsed,`digestPreview took ${elapsed} ms`).toBeLessThan(10_000);
 },60_000);

 it('REVIEW low: teras_outcome_record has an index for the grantor and agent-identity lookups the inbox and registry run on every render',async()=>{
  // Plans are checked with sequential scans disabled, so the answer depends on index availability, not table size.
  const plan=async(query:ReturnType<typeof sql>)=>{
   const rows=await owner.db.transaction(async tx=>{await tx.execute(sql`set local enable_seqscan=off`);return tx.execute(sql`explain (format json) ${query}`);});
   return JSON.stringify(rows);
  };
  const grantor=await plan(sql`select id from public.teras_outcome_record where tenant_id=${b.tenantId}::uuid and grantor_user_id=${manager.userId}::uuid and outcome_kind='prepared' order by started_at desc limit 1`);
  expect(grantor,'latestDailyDigest needs an index on (tenant_id, grantor_user_id, started_at)').toMatch(/"Index Cond":"[^"]*grantor_user_id/);
  const identity=await plan(sql`select max(started_at) from public.teras_outcome_record where tenant_id=${b.tenantId}::uuid and agent_identity='worker.approver_recommendation'`);
  expect(identity,'lastRunTx needs an index on (tenant_id, agent_identity, started_at)').toMatch(/"Index Cond":"[^"]*agent_identity/);
 },60_000);
});
