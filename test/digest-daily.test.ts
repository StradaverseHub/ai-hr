/** ADR-0170 §3.13 Preparers, step 5 — the daily digest on fictional data.
 *
 *  1. Built from the existing owners as the person: approvals waiting by kind, and for administrators setup
 *     gaps and statutory deadlines. Counts and links only; nobody's name or request.
 *  2. Off by default per tenant: it is the `daily_digest` work-job type, so it needs key 1 (an administrator
 *     enables the type) and key 2 (the person delegates it for themself), and the stop switch halts it.
 *  3. A run is recorded as a mandate run; the prepared digest is rebuilt from that record for its grantor only.
 *  4. The grant shape is the job's own: own items only, once a day. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {hireEmployee,setReportingLine} from '../core/org';
import {requestLeave} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {ensureAgentPrincipal} from '../core/agent-principal';
import {MandateRefused} from '../core/mandates/job-types';
import {grantMandate,revokeMandate,setJobTypeEnablement,setMandateStopSwitch} from '../core/mandates/mandates';
import {listOutcomeRecords} from '../core/outcome-record/record';
import {DIGEST_PAGES,digestPreview,latestDailyDigest,prepareDailyDigest} from '../core/digest/daily-digest';
import {runDailyDigestMandate} from '../core/digest/run';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base,hr:SessionContext,manager:SessionContext,applicant:SessionContext,principalId:string;
const JOB='daily_digest';
const grant={jobType:JOB,scope:{team:'self'},limits:{maxRunsPerDay:1,maxPeople:1},schedule:{daily:true},notify:'daily_summary',validDays:30};
async function login(name:string,role:'employee'|'manager'|'hr_admin'){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,role);
 await owner.db.insert(schema.leaveLedger).values({tenantId:b.tenantId,employmentId:hired.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:todayInKualaLumpur()});
 return{...hired,ctx:{...await entitledCtx(b,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]} as SessionContext};
}
const refused=async(promise:Promise<unknown>,reason:string)=>{const error=await promise.then(()=>null,(e:unknown)=>e);expect(error).toBeInstanceOf(MandateRefused);expect((error as MandateRefused).reason).toBe(reason);};
const run=async(mandateId:string)=>runDailyDigestMandate({tenantId:b.tenantId,principalId,entitlements:(await entitledCtx(b)).entitlements!,mandateId});

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 hr=(await login('Fictional Digest Administrator','hr_admin')).ctx;
 const boss=await login('Fictional Digest Manager','manager');manager=boss.ctx;
 const report=await login('Fictional Digest Applicant','employee');applicant=report.ctx;
 await setReportingLine(adminCtx(b),{subordinateEmploymentId:report.employmentId,managerEmploymentId:boss.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const next=new Date(todayInKualaLumpur()+'T00:00:00Z');do{next.setUTCDate(next.getUTCDate()+1);}while([0,6].includes(next.getUTCDay()));const date=next.toISOString().slice(0,10);
 await requestLeave(applicant,{employmentId:report.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date,durationType:'full_day',reason:'Fictional digest reason'});
 principalId=await ensureAgentPrincipal(owner.db,b.tenantId);
});

describe('daily digest',()=>{
 it('counts what waits for the person, with links and no names',async()=>{
  const digest=await digestPreview(manager);
  expect(digest).toMatchObject({kind:'teras.daily_digest',version:1,asOf:todayInKualaLumpur(),approvals:{total:1,byKind:[{kind:'leave',count:1}],page:DIGEST_PAGES.approvals},setup:null,deadlines:null});
  expect(digest.text).toBe('1 item waits for your decision (leave 1).');
  const text=JSON.stringify(digest);
  for(const leak of ['Fictional Digest Applicant','Fictional digest reason'])expect(text).not.toContain(leak);
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  // The applicant has nothing to decide; their own request is not a task.
  expect((await prepareDailyDigest(applicant)).approvals).toMatchObject({total:0,byKind:[]});
  // An administrator also gets setup gaps and deadlines, as counts.
  // Review H4: a view does not recompute an administrator's setup or deadlines; without a digest prepared today
  // the preview carries the approvals only.
  const viewed=await digestPreview(hr);
  expect(viewed.setup).toBeNull();expect(viewed.deadlines).toBeNull();
  const admin=await prepareDailyDigest(hr);
  expect(admin.setup).toMatchObject({page:DIGEST_PAGES.setup});
  expect(admin.setup!.companies+admin.setup!.unknown).toBeGreaterThanOrEqual(1);expect(typeof admin.setup!.blocked).toBe('number');expect(admin.deadlines).toMatchObject({page:DIGEST_PAGES.deadlines});
  expect(admin.text).toContain('Setup:');
  await expect(prepareDailyDigest({...manager,userId:undefined})).rejects.toThrow();
 });

 it('is off by default, needs both keys, and runs as a mandate for the grantor only',async()=>{
  await refused(grantMandate(manager,grant),'not_enabled');
  await setJobTypeEnablement(hr,{jobType:JOB,enabled:true});
  // The job's own shape: the grantor's own items, once a day.
  await refused(grantMandate(manager,{...grant,scope:{team:'direct'}}),'invalid');
  await refused(grantMandate(manager,{...grant,schedule:{weekday:1}}),'invalid');
  await refused(grantMandate(manager,{...grant,limits:{maxRunsPerDay:1,maxPeople:2}}),'invalid');
  const mandate=await grantMandate(manager,grant);
  expect(mandate).toMatchObject({jobType:JOB,scope:{team:'self'},schedule:{daily:true}});
  const result=await run(mandate.id);
  expect(result.status).toBe('prepared');if(result.status!=='prepared')return;
  expect(result.summary.approvals).toMatchObject({total:1,byKind:[{kind:'leave',count:1}]});
  const [record]=await listOutcomeRecords(manager,{mandateId:mandate.id});
  expect(record).toMatchObject({runKind:'mandate_run',authorityKind:'mandate',grantorUserId:manager.userId,agentIdentity:`mandate-agent:${mandate.agentIdentityId}`,
   outcomeKind:'prepared',humanInvolvement:'none',notice:'not_applicable',outcome:{jobType:JOB,approvalsTotal:1,approvalsByKind:['leave:1'],setupBlocked:null}});
  expect(JSON.stringify(record)).not.toContain('Fictional Digest Applicant');
  // The prepared item, for its grantor and nobody else.
  const latest=await latestDailyDigest(manager);
  expect(latest).toMatchObject({recordId:result.recordId,digest:{approvals:{total:1,byKind:[{kind:'leave',count:1}]},setup:null,deadlines:null,text:result.summary.text}});
  expect(await latestDailyDigest(applicant)).toBeNull();
  // Once a day.
  expect(await run(mandate.id)).toMatchObject({status:'stopped',failed:['run_limit']});
 });

 it('stops with the stop switch, the job type switched off, or revocation',async()=>{
  await setJobTypeEnablement(hr,{jobType:JOB,enabled:true,maxRunsPerDay:5});
  const mandate=await grantMandate(manager,{...grant,limits:{maxRunsPerDay:5,maxPeople:1}});
  await setMandateStopSwitch(hr,true);
  expect(await run(mandate.id)).toMatchObject({status:'stopped',failed:['stop_switch']});
  await setMandateStopSwitch(hr,false);
  await setJobTypeEnablement(hr,{jobType:JOB,enabled:false,maxRunsPerDay:5});
  expect(await run(mandate.id)).toMatchObject({status:'stopped',failed:expect.arrayContaining(['job_type_enabled'])});
  await setJobTypeEnablement(hr,{jobType:JOB,enabled:true,maxRunsPerDay:5});
  await revokeMandate(manager,mandate.id);
  expect(await run(mandate.id)).toMatchObject({status:'stopped',failed:['mandate_in_force']});
  expect(await latestDailyDigest(manager)).toBeNull();
 });
});
