/** REVIEW (stress and concurrency) — work-job mandate runs under overlap. Written as if at test/review/mandate-run-concurrency.test.ts.
 *
 * core/mandates/run.ts counts today's runs in one transaction (stateTx), runs the job outside any transaction,
 * then writes the record in a second transaction whose re-check deliberately ignores `run_limit`
 * (run.ts:97 `item.check!=='run_limit'`). Nothing serialises two runs of the same mandate, so N overlapping
 * runs all pass the limit. A stopped run also writes a record that the next run counts (run.ts:63-64 counts
 * every record regardless of outcome_kind). Fixtures are fictional. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as schema from '../../db/schema';
import {terasOutcomeRecord} from '../../db/teras-schema';
import type {SessionContext} from '../../db/client';
import {hireEmployee,setReportingLine} from '../../core/org';
import {requestLeave} from '../../packs/leave/service';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {ensureAgentPrincipal} from '../../core/agent-principal';
import {grantMandate,setJobTypeEnablement,setMandateStopSwitch} from '../../core/mandates/mandates';
import {runDailyDigestMandate} from '../../core/digest/run';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from '../harness';

let b:Base,hr:SessionContext,manager:SessionContext,principalId:string;
const JOB='daily_digest';
const grant={jobType:JOB,scope:{team:'self'},limits:{maxRunsPerDay:1,maxPeople:1},schedule:{daily:true},notify:'daily_summary',validDays:30};
async function login(name:string,role:'employee'|'manager'|'hr_admin'){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,role);
 await owner.db.insert(schema.leaveLedger).values({tenantId:b.tenantId,employmentId:hired.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:todayInKualaLumpur()});
 return{...hired,ctx:{...await entitledCtx(b,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]} as SessionContext};
}
const run=async(mandateId:string)=>runDailyDigestMandate({tenantId:b.tenantId,principalId,entitlements:(await entitledCtx(b)).entitlements!,mandateId});
const prepared=async(mandateId?:string)=>(await owner.db.select({id:terasOutcomeRecord.id,mandateId:terasOutcomeRecord.mandateId}).from(terasOutcomeRecord)
 .where(and(eq(terasOutcomeRecord.tenantId,b.tenantId),eq(terasOutcomeRecord.outcomeKind,'prepared'),eq(terasOutcomeRecord.runKind,'mandate_run'))))
 .filter(row=>mandateId===undefined||row.mandateId===mandateId);

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 hr=(await login('Fictional Stress Administrator','hr_admin')).ctx;
 const boss=await login('Fictional Stress Manager','manager');manager=boss.ctx;
 const report=await login('Fictional Stress Applicant','employee');
 await setReportingLine(adminCtx(b),{subordinateEmploymentId:report.employmentId,managerEmploymentId:boss.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const next=new Date(todayInKualaLumpur()+'T00:00:00Z');do{next.setUTCDate(next.getUTCDate()+1);}while([0,6].includes(next.getUTCDay()));
 await requestLeave(report.ctx,{employmentId:report.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:next.toISOString().slice(0,10),endDate:next.toISOString().slice(0,10),durationType:'full_day',reason:'Fictional stress reason'});
 principalId=await ensureAgentPrincipal(owner.db,b.tenantId);
 await setJobTypeEnablement(hr,{jobType:JOB,enabled:true,maxValidityDays:60,maxRunsPerDay:1});
});

describe('mandate runs under concurrency',()=>{
 it('REVIEW medium: maxRunsPerDay=1 holds when 8 runs of the same mandate overlap (run.ts:63-71, 97)',async()=>{
  const mandate=await grantMandate(manager,grant);
  const started=Date.now();
  const results=await Promise.all(Array.from({length:8},()=>run(mandate.id)));
  expect(Date.now()-started).toBeLessThan(60_000);
  // Every run writes a record (prepared or stopped); exactly one may be prepared under a ceiling of one per day.
  expect(results).toHaveLength(8);
  expect(results.filter(result=>result.status==='prepared')).toHaveLength(1);
  expect(await prepared(mandate.id)).toHaveLength(1);
 },60_000);

 it('REVIEW medium: a run stopped by the stop switch does not use up the day\'s run allowance (run.ts:63-64 counts stopped records)',async()=>{
  const mandate=await grantMandate(manager,grant);
  await setMandateStopSwitch(hr,true);
  expect(await run(mandate.id)).toMatchObject({status:'stopped',failed:['stop_switch']});
  await setMandateStopSwitch(hr,false);
  // The administrator resumed; nothing has been prepared today, so today's single run is still available.
  const resumed=await run(mandate.id);
  expect(resumed).toMatchObject({status:'prepared'});
 },60_000);

 it('REVIEW low: one person gets at most one prepared daily digest per HR day, however many digest mandates they grant (mandates.ts:107-125)',async()=>{
  const first=await grantMandate(manager,grant);
  // No uniqueness on (tenant, grantor, job_type) for active mandates: a second identical grant is accepted.
  let second:typeof first|null=null;
  try{second=await grantMandate(manager,grant);}catch{second=null;}
  if(second)await Promise.all([run(first.id),run(second.id)]);else await run(first.id);
  const mine=(await prepared()).filter(row=>row.mandateId===first.id||row.mandateId===second?.id);
  expect(mine.length).toBeLessThanOrEqual(1);
 },60_000);
});
