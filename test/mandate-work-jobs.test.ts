/** ADR-0170 §3.10 step 5a — work-job mandates on fictional data (migration 0890, core/mandates).
 *
 *  1. Off by default, two keys: nothing runs or can be granted until a group administrator enables the job
 *     type, and the person then delegates within its ceilings. The stop switch closes both.
 *  2. Never-delegable categories and decision jobs are refused in code, and the database list is closed.
 *  3. "Every Monday, summarise who on my team is away this week" runs end to end as the agent principal,
 *     for the grantor, and writes an outcome record with rule versions and the two new fields.
 *  4. A revoked or expired mandate stops; revocation is final; renewal stays within the ceiling.
 *  5. Authority is the intersection of the grantor's CURRENT authority and the mandate, re-checked each run.
 *  6. One agent identity per mandate; a record must name the mandate's own identity and current version. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as schema from '../db/schema';
import {terasMandate,terasMandateJobTypeEnablement,terasOutcomeRecord} from '../db/teras-schema';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee,setReportingLine} from '../core/org';
import {agentContext,ensureAgentPrincipal} from '../core/agent-principal';
import {MandateRefused,assertWorkJobDefinition,delegableJobType} from '../core/mandates/job-types';
import {grantMandate,listMandates,renewMandate,revokeMandate,setJobTypeEnablement,setMandateStopSwitch} from '../core/mandates/mandates';
import {runMandate} from '../core/mandates/run';
import {listOutcomeRecords} from '../core/outcome-record/record';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base,manager:SessionContext,hr:SessionContext,report:{employmentId:string;personId:string;ctx:SessionContext},outsider:{employmentId:string},principalId:string;
const today=todayInKualaLumpur();
const JOB='team_absence_weekly_summary';
const grantInput={jobType:JOB,scope:{team:'direct'},limits:{maxRunsPerDay:1,maxPeople:50},schedule:{weekday:1},notify:'daily_summary',validDays:30};
async function login(name:string,role:'employee'|'manager'|'hr_admin'){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,role);
 return{...hired,ctx:{...await entitledCtx(b,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]} as SessionContext};
}
const refused=async(promise:Promise<unknown>,reason:string)=>{const error=await promise.then(()=>null,(e:unknown)=>e);expect(error).toBeInstanceOf(MandateRefused);expect((error as MandateRefused).reason).toBe(reason);};
const pgText=(error:unknown)=>{const parts:string[]=[];for(let cur=error as Record<string,unknown>|undefined,n=0;cur&&typeof cur==='object'&&n<5;cur=cur.cause as never,n++)
 for(const key of ['message','detail'])if(typeof cur[key]==='string')parts.push(cur[key] as string);return parts.join(' | ');};
const dbRefused=async(promise:Promise<unknown>,pattern:RegExp)=>{const error=await promise.then(()=>null,(e:unknown)=>e);expect(error,'expected a refusal').not.toBeNull();expect(pgText(error)).toMatch(pattern);};
const run=async(mandateId:string,now?:Date)=>runMandate({tenantId:b.tenantId,principalId,entitlements:(await entitledCtx(b)).entitlements!,mandateId,now});

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 const boss=await login('Fictional Team Manager','manager');manager=boss.ctx;
 hr=(await login('Fictional Group Administrator','hr_admin')).ctx;
 const r=await login('Fictional Direct Report','employee');report={employmentId:r.employmentId,personId:r.personId,ctx:r.ctx};
 outsider=await login('Fictional Outsider','employee');
 await setReportingLine(adminCtx(b),{subordinateEmploymentId:report.employmentId,managerEmploymentId:boss.employmentId,lineType:'administrative',validFrom:'2024-01-01'});
 // Approved annual leave today for the report, and for someone outside the team.
 for(const employmentId of [report.employmentId,outsider.employmentId]){
  const [request]=await owner.db.insert(schema.leaveRequest).values({tenantId:b.tenantId,employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:today,endDate:today,days:'1',status:'approved'}).returning({id:schema.leaveRequest.id});
  await owner.db.insert(schema.leaveRequestDate).values({tenantId:b.tenantId,leaveRequestId:request.id,subjectEmploymentId:employmentId,leaveDate:today,days:'1',status:'approved'});
 }
 principalId=await ensureAgentPrincipal(owner.db,b.tenantId);
});

describe('work-job mandates',()=>{
 it('is off by default and needs both keys; the stop switch closes granting and running',async()=>{
  await refused(grantMandate(manager,grantInput),'not_enabled');
  await dbRefused(withTenant(manager,tx=>tx.insert(terasMandate).values({tenantId:b.tenantId,jobType:JOB,grantorUserId:manager.userId!,grantorPersonId:manager.personId!,
   scope:{team:'direct'},limits:{maxRunsPerDay:1,maxPeople:5},schedule:{weekday:1},notify:'daily_summary',validFrom:new Date(),validUntil:new Date(Date.now()+86400000)})),/row-level security/i);
  // Key 1 belongs to a group administrator only, in code and in the database.
  await refused(setJobTypeEnablement(manager,{jobType:JOB,enabled:true}),'not_administrator');
  await dbRefused(withTenant(manager,tx=>tx.insert(terasMandateJobTypeEnablement).values({tenantId:b.tenantId,jobType:JOB,enabled:true,changedByUserId:manager.userId!})),/row-level security/i);
  const key=await setJobTypeEnablement(hr,{jobType:JOB,enabled:true,maxValidityDays:60,maxRunsPerDay:2});expect(key).toMatchObject({enabled:true,version:1});
  await refused(grantMandate(manager,{...grantInput,validDays:61}),'over_ceiling');
  await refused(grantMandate(manager,{...grantInput,limits:{maxRunsPerDay:3,maxPeople:5}}),'over_ceiling');
  // Key 2: a person without the job's authority cannot delegate it.
  await refused(grantMandate(report.ctx,grantInput),'no_authority');
  const mandate=await grantMandate(manager,grantInput);expect(mandate).toMatchObject({version:1,grantorUserId:manager.userId,revokedAt:null});
  await setMandateStopSwitch(hr,true);
  await refused(grantMandate(manager,grantInput),'stopped');
  const stopped=await run(mandate.id);expect(stopped).toMatchObject({status:'stopped',failed:['stop_switch']});
  await setMandateStopSwitch(hr,false);
  // Disabling key 1 stops existing mandates too.
  await setJobTypeEnablement(hr,{jobType:JOB,enabled:false});
  expect(await run(mandate.id)).toMatchObject({status:'stopped',failed:expect.arrayContaining(['job_type_enabled'])});
 });

 it('refuses never-delegable categories and decision jobs in code, and the database list is closed',async()=>{
  for(const [job,reason] of [['payroll.close','never_delegable'],['payroll.reprocess','never_delegable'],['pay.amount.change','never_delegable'],['employment.terminate','never_delegable'],
   ['employment.hire','never_delegable'],['access.role.grant','never_delegable'],['records.delete','never_delegable'],['leave.approve.own','never_delegable'],
   ['leave.approve','decision_job'],['anything.else','unknown_job_type']] as const){
   expect(()=>delegableJobType(job),job).toThrow(MandateRefused);
   try{delegableJobType(job);}catch(error){expect((error as MandateRefused).reason,job).toBe(reason);}
   await refused(grantMandate(manager,{...grantInput,jobType:job}),reason);
   await refused(setJobTypeEnablement(hr,{jobType:job,enabled:true}),reason);
  }
  for(const category of ['pay','payroll_close','employment_status','access','irreversible','own_request_decision'])
   expect(()=>assertWorkJobDefinition({kind:'work',effect:'summarise',categories:['leave',category]}),category).toThrow(MandateRefused);
  expect(()=>assertWorkJobDefinition({kind:'decision',effect:'summarise',categories:['leave']})).toThrow(MandateRefused);
  expect(()=>assertWorkJobDefinition({kind:'work',effect:'complete',categories:['leave']})).toThrow(MandateRefused);
  await dbRefused(owner.db.insert(terasMandateJobTypeEnablement).values({tenantId:b.tenantId,jobType:'payroll_close' as never,enabled:true,changedByUserId:hr.userId!}),/check constraint/i);
 });

 it('runs the Monday team summary as the agent principal, for the grantor, and records the run',async()=>{
  await setJobTypeEnablement(hr,{jobType:JOB,enabled:true});
  const mandate=await grantMandate(manager,grantInput);
  const result=await run(mandate.id);
  expect(result.status).toBe('prepared');if(result.status!=='prepared')return;
  expect(result.summary.people).toBe(1);
  expect(result.summary.absent).toEqual([{employmentId:report.employmentId,name:'Fictional Direct Report',leaveType:expect.any(String),dates:[today]}]);
  expect(result.summary.text).toContain('Fictional Direct Report');expect(result.summary.text).not.toContain('Fictional Outsider');
  const [record]=await listOutcomeRecords(manager);
  expect(record).toMatchObject({id:result.recordId,runId:result.runId,runKind:'mandate_run',authorityKind:'mandate',askedByUserId:null,mandateId:mandate.id,mandateVersion:1,
   grantorUserId:manager.userId,agentIdentity:`mandate-agent:${mandate.agentIdentityId}`,outcomeKind:'prepared',humanInvolvement:'none',notice:'not_given'});
  expect(record.agentIdentity).not.toContain(manager.userId!);
  expect(record.checks.filter(check=>check.owner==='core/mandates/run.ts#runMandate').map(check=>[check.check,check.result])).toEqual([
   ['stop_switch','pass'],['job_type_delegable','pass'],['job_type_enabled','pass'],['mandate_in_force','pass'],['run_limit','pass'],['grantor_authority','pass']]);
  expect(record.checks).toContainEqual({check:'leave_policy',owner:'core/leave.ts#myTeamLeaveProjection',ruleVersion:`leave_type:${b.annualLeaveTypeId}@v1`,result:'pass'});
  expect(record.checks.find(check=>check.check==='mandate_in_force')?.ruleVersion).toBe(`teras_mandate:${mandate.id}@v1`);
  expect(record.reads[0]).toEqual({tool:'core/my-team-scope.ts#resolveMyTeamScope',status:'ok',refs:[report.employmentId]});
  expect(record.reads[1].refs).toHaveLength(1);
  expect(record.outcome).toMatchObject({jobType:JOB,people:1,absentPeople:1,requests:1,truncated:false});
  expect(JSON.stringify(record)).not.toContain('Fictional Direct Report');
  // Readers: the grantor and group administrators; the people summarised do not see the grantor's record.
  expect(await listOutcomeRecords(hr)).toHaveLength(1);expect(await listOutcomeRecords(report.ctx)).toHaveLength(0);
  // The run limit is per day: a second run today stops and is recorded too.
  expect(await run(mandate.id)).toMatchObject({status:'stopped',failed:['run_limit']});
  expect(await listOutcomeRecords(manager,{mandateId:mandate.id})).toHaveLength(2);
 });

 it('stops a revoked or expired mandate; revocation is final and renewal stays within the ceiling',async()=>{
  await setJobTypeEnablement(hr,{jobType:JOB,enabled:true,maxValidityDays:30,maxRunsPerDay:5});
  const a=await grantMandate(manager,{...grantInput,limits:{maxRunsPerDay:5,maxPeople:50}});
  const renewed=await renewMandate(manager,{mandateId:a.id,validDays:20});expect(renewed.version).toBe(2);
  await refused(renewMandate(manager,{mandateId:a.id,validDays:31}),'over_ceiling');
  await refused(renewMandate(hr,{mandateId:a.id,validDays:10}),'not_grantor');
  expect((await run(a.id)).status).toBe('prepared');
  await refused(revokeMandate(report.ctx,a.id),'not_found');
  const revoked=await revokeMandate(manager,a.id);expect(revoked).toMatchObject({revokedBy:'grantor',revokedByUserId:manager.userId,version:3});
  await refused(revokeMandate(manager,a.id),'revoked');
  const stopped=await run(a.id);expect(stopped).toMatchObject({status:'stopped',failed:['mandate_in_force']});
  const latest=(await listOutcomeRecords(manager,{mandateId:a.id}))[0];expect(latest).toMatchObject({outcomeKind:'stopped',mandateVersion:3,reads:[]});
  await dbRefused(owner.db.update(terasMandate).set({revokedAt:null,revokedByUserId:null,revokedBy:null}).where(eq(terasMandate.id,a.id)),/final/i);
  await dbRefused(withTenant(manager,tx=>tx.delete(terasMandate).where(eq(terasMandate.id,a.id))),/permission denied/i);
  await dbRefused(owner.db.delete(terasMandate).where(eq(terasMandate.id,a.id)),/never deleted/i);
  // Scope cannot be widened after grant, even by the grantor.
  const b2=await grantMandate(manager,{...grantInput,limits:{maxRunsPerDay:5,maxPeople:50}});
  await dbRefused(withTenant(manager,tx=>tx.update(terasMandate).set({limits:{maxRunsPerDay:24,maxPeople:200}}).where(eq(terasMandate.id,b2.id))),/only revocation and renewal/i);
  // An administrator revokes anyone's mandate, recorded as an administrator.
  expect(await revokeMandate(hr,b2.id)).toMatchObject({revokedBy:'administrator',revokedByUserId:hr.userId});
  // Expiry: a one-day mandate run two days later stops.
  const c=await grantMandate(manager,{...grantInput,validDays:1,limits:{maxRunsPerDay:5,maxPeople:50}});
  expect(await run(c.id,new Date(Date.now()+2*86400000))).toMatchObject({status:'stopped',failed:['mandate_in_force']});
  await refused(renewMandate(manager,{mandateId:c.id,validDays:5},new Date(Date.now()+2*86400000)),'expired');
  expect((await listMandates(manager)).map(row=>row.id).sort()).toEqual([a.id,b2.id,c.id].sort());
 });

 it('narrows to the grantor\'s current authority at every run',async()=>{
  await setJobTypeEnablement(hr,{jobType:JOB,enabled:true,maxRunsPerDay:10});
  const mandate=await grantMandate(manager,{...grantInput,limits:{maxRunsPerDay:10,maxPeople:50}});
  expect(await run(mandate.id)).toMatchObject({status:'prepared',summary:{people:1}});
  // The report moves to another manager: the summary no longer includes them.
  await owner.db.update(schema.reportingLine).set({validTo:today}).where(eq(schema.reportingLine.subordinateEmploymentId,report.employmentId));
  expect(await run(mandate.id)).toMatchObject({status:'prepared',summary:{people:0,absent:[]}});
  // The grantor loses the manager role: the mandate stops.
  await owner.db.delete(schema.roleAssignment).where(and(eq(schema.roleAssignment.appUserId,manager.userId!),eq(schema.roleAssignment.role,'manager')));
  expect(await run(mandate.id)).toMatchObject({status:'stopped',failed:['grantor_authority']});
  // Restored, then archived: stops again.
  await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:manager.userId!,companyId:null,role:'manager'});
  expect((await run(mandate.id)).status).toBe('prepared');
  await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,manager.userId!));
  expect(await run(mandate.id)).toMatchObject({status:'stopped',failed:['grantor_authority']});
 });

 it('gives each mandate its own agent identity, and a record must name it and the current version',async()=>{
  await setJobTypeEnablement(hr,{jobType:JOB,enabled:true,maxRunsPerDay:5});
  const one=await grantMandate(manager,{...grantInput,limits:{maxRunsPerDay:5,maxPeople:50}});
  const two=await grantMandate(manager,{...grantInput,limits:{maxRunsPerDay:5,maxPeople:50}});
  expect(one.agentIdentityId).not.toBe(two.agentIdentityId);
  const agent=agentContext(b.tenantId,principalId,(await entitledCtx(b)).entitlements!);
  const row=(identity:string,version:number)=>({tenantId:b.tenantId,runId:randomUUID(),runKind:'mandate_run' as const,startedAt:new Date(),finishedAt:new Date(),
   authorityKind:'mandate' as const,mandateId:one.id,mandateVersion:version,grantorUserId:manager.userId!,agentIdentity:identity,reads:[],checks:[],
   replay:{model:null,provider:null,instructionSet:null,specVersion:null,specDigest:null,toolCatalogue:null},outcomeKind:'prepared' as const,outcome:{},
   humanInvolvement:'none' as const,notice:'not_given' as const});
  await dbRefused(withTenant(agent,tx=>tx.insert(terasOutcomeRecord).values(row(`mandate-agent:${two.agentIdentityId}`,1))),/row-level security/i);
  await dbRefused(withTenant(agent,tx=>tx.insert(terasOutcomeRecord).values(row(`mandate-agent:${one.agentIdentityId}`,2))),/row-level security/i);
  // A person cannot write a mandate run, even the grantor.
  await dbRefused(withTenant(manager,tx=>tx.insert(terasOutcomeRecord).values(row(`mandate-agent:${one.agentIdentityId}`,1))),/row-level security/i);
  await withTenant(agent,tx=>tx.insert(terasOutcomeRecord).values(row(`mandate-agent:${one.agentIdentityId}`,1)));
  // The agent reads mandate runs only, never a person's turn records, and no task memory.
  expect((await withTenant(agent,tx=>tx.select().from(terasOutcomeRecord))).every(item=>item.authorityKind==='mandate')).toBe(true);
 });
});
