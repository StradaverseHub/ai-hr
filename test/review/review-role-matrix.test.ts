/** REVIEW draft (would live at test/review/role-matrix.test.ts). The security role matrix over the Teras services and
 * their RLS, on fictional fixtures: eight actors, each service asserted allowed or refused. Coverage tests: these are
 * expected to PASS on the current code; a failure here is a regression or a wrong expectation in the draft.
 * Static draft: not run locally. */
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant} from '../../db/client';
import * as schema from '../../db/schema';
import {terasMandate,terasTaskMemory,terasWorkerControl} from '../../db/teras-schema';
import {ensureAgentPrincipal} from '../../core/agent-principal';
import {MandateRefused} from '../../core/mandates/job-types';
import {grantMandate,listMandates,revokeMandate,setJobTypeEnablement,setManagerRevocationPolicy,setMandateStopSwitch} from '../../core/mandates/mandates';
import {runMandate} from '../../core/mandates/run';
import {listOutcomeRecords} from '../../core/outcome-record/record';
import {setWorkerSwitch,workerRunGate} from '../../core/agent-registry/controls';
import {listWorkers,workerDetail} from '../../core/agent-registry/views';
import {exportAgentRegistry,outcomeSummary} from '../../core/agent-registry/export';
import {recommendLeaveDecision} from '../../core/recommenders/leave-decision';
import {setupCopilot,SetupCopilotRefused} from '../../core/setup-copilot/copilot';
import {setupReadiness} from '../../core/product-context/setup-readiness';
import {digestPreview} from '../../core/digest/daily-digest';
import {PostgresTaskMemoryStore,TaskMemoryRefused} from '../../core/harness/task-memory-store';
import {TASK_MEMORY_VERSION,type TaskMemory} from '../../core/harness/memory';
import {pendingLeaveTaskMetadata,requestLeave} from '../../packs/leave/service';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb} from '../harness';
import {buildMatrix,nextWorkday,type Actor,type Matrix} from './review-actors';

let m:Matrix;let all:Record<string,Actor>;let requestId:string;
const TEAM={jobType:'team_absence_weekly_summary',scope:{team:'direct'},limits:{maxRunsPerDay:3,maxPeople:50},schedule:{weekday:1},notify:'daily_summary',validDays:30};
const reason=async(promise:Promise<unknown>)=>{const error=await promise.then(()=>null,(e:unknown)=>e);return (error as {reason?:string}|null)?.reason??(error?'thrown':null);};
const others=(...allowed:string[])=>Object.entries(all).filter(([key])=>!allowed.includes(key));

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();m=await buildMatrix();
 all={employee:m.employee,manager:m.manager,delegate:m.delegate,companyAdmin:m.companyAdmin,groupAdmin:m.groupAdmin,payroll:m.payroll,otherCompanyAdmin:m.otherCompanyAdmin,otherTenant:m.otherTenant};
 requestId=(await requestLeave(m.employee.ctx,{employmentId:m.employee.employmentId,leaveTypeId:m.b.annualLeaveTypeId,startDate:nextWorkday(3),endDate:nextWorkday(3),
  durationType:'full_day',reason:'Fictional matrix leave reason'})).leaveRequestId;
});

describe('REVIEW pass: administration of switches, keys and policy is the group administrator\'s alone',()=>{
 it('REVIEW pass: setWorkerSwitch, job-type enablement, stop switch and manager-revocation policy refuse every non-group-admin',async()=>{
  for(const [key,actor] of others('groupAdmin','otherTenant')){
   expect(await reason(setWorkerSwitch(actor.ctx,{workerId:'approver_recommendation',enabled:true})),key).toBe('not_administrator');
   expect(await reason(setJobTypeEnablement(actor.ctx,{jobType:'team_absence_weekly_summary',enabled:true})),key).toBe('not_administrator');
   expect(await reason(setMandateStopSwitch(actor.ctx,true)),key).toBe('not_administrator');
   expect(await reason(setManagerRevocationPolicy(actor.ctx,true)),key).toBe('not_administrator');
   // RLS repeats it: a direct insert of the switch row is refused.
   expect(await reason(withTenant(actor.ctx,tx=>tx.insert(terasWorkerControl).values({tenantId:m.b.tenantId,workerId:'approver_recommendation',enabled:true,changedByUserId:actor.ctx.userId!}))),key).not.toBeNull();
  }
  await setWorkerSwitch(m.groupAdmin.ctx,{workerId:'approver_recommendation',enabled:true});
  expect((await workerRunGate(m.groupAdmin.ctx,'approver_recommendation')).run).toBe(true);
 });
 it('REVIEW pass: another tenant\'s group admin changes only its own tenant',async()=>{
  await setWorkerSwitch(m.otherTenant.ctx,{workerId:'approver_recommendation',enabled:true});
  await setMandateStopSwitch(m.otherTenant.ctx,true);
  const gate=await workerRunGate(m.groupAdmin.ctx,'approver_recommendation');
  expect(gate).toEqual({run:false,reasons:['switched_off']});
  // A forged tenant id in the row is refused by RLS.
  expect(await reason(withTenant(m.otherTenant.ctx,tx=>tx.insert(terasWorkerControl).values({tenantId:m.b.tenantId,workerId:'explainers',enabled:true,changedByUserId:m.otherTenant.ctx.userId!})))).not.toBeNull();
 });
});

describe('REVIEW pass: mandates — grant, visibility, revocation, runs',()=>{
 let mandateId:string,principalId:string;
 beforeEach(async()=>{
  await setJobTypeEnablement(m.groupAdmin.ctx,{jobType:'team_absence_weekly_summary',enabled:true,maxValidityDays:60,maxRunsPerDay:3});
  mandateId=(await grantMandate(m.manager.ctx,TEAM)).id;
  principalId=await ensureAgentPrincipal(owner.db,m.b.tenantId);
 });
 it('REVIEW pass: only a holder of team authority grants the team summary; delegation and payroll roles do not',async()=>{
  for(const key of ['employee','delegate','payroll'])expect(await reason(grantMandate(all[key].ctx,TEAM)),key).toBe('no_authority');
  // Another tenant has key 1 closed: refused before or at the key.
  expect(await reason(grantMandate(m.otherTenant.ctx,TEAM))).toBe('not_enabled');
 });
 it('REVIEW pass: the manager\'s mandate is visible to the manager and group administrators only',async()=>{
  for(const [key,actor] of Object.entries(all)){
   const visible=(await listMandates(actor.ctx)).some(row=>row.id===mandateId);
   expect(visible,key).toBe(key==='manager'||key==='groupAdmin');
  }
 });
 it('REVIEW pass: revocation refuses everyone but the grantor and group administrators (manager policy off)',async()=>{
  for(const [key,actor] of others('manager','groupAdmin')){
   const error=await revokeMandate(actor.ctx,mandateId).then(()=>null,(e:unknown)=>e);
   expect(error,key).toBeInstanceOf(MandateRefused);
   // RLS: a direct UPDATE touches no row.
   const rows=await withTenant(actor.ctx,tx=>tx.update(terasMandate).set({revokedAt:new Date(),revokedByUserId:actor.ctx.userId!,revokedBy:'administrator'}).where(eq(terasMandate.id,mandateId)).returning())
    .catch(()=>[]);
   expect(rows,key).toHaveLength(0);
  }
  expect((await revokeMandate(m.groupAdmin.ctx,mandateId)).revokedBy).toBe('administrator');
 });
 it('REVIEW pass: run records are read by the grantor and group administrators only',async()=>{
  const run=await runMandate({tenantId:m.b.tenantId,principalId,entitlements:(await entitledCtx(m.b)).entitlements!,mandateId});
  expect(run.status).toBe('prepared');
  for(const [key,actor] of Object.entries(all)){
   const seen=(await listOutcomeRecords(actor.ctx)).some(row=>row.id===run.recordId);
   expect(seen,key).toBe(key==='manager'||key==='groupAdmin');
  }
 });
 it('REVIEW pass: a mandate stops when the grantor loses the manager role',async()=>{
  await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,m.manager.ctx.userId!));
  const run=await runMandate({tenantId:m.b.tenantId,principalId,entitlements:(await entitledCtx(m.b)).entitlements!,mandateId});
  expect(run).toMatchObject({status:'stopped',failed:expect.arrayContaining(['grantor_authority'])});
 });
});

describe('REVIEW pass: registry views and exports are group-admin only',()=>{
 it('REVIEW pass: listWorkers, workerDetail, outcomeSummary and exportAgentRegistry refuse every other actor',async()=>{
  for(const [key,actor] of others('groupAdmin','otherTenant')){
   expect(await reason(listWorkers(actor.ctx)),key).toBe('not_administrator');
   expect(await reason(workerDetail(actor.ctx,'daily_digest')),key).toBe('not_administrator');
   expect(await reason(outcomeSummary(actor.ctx)),key).toBe('not_administrator');
   expect(await reason(exportAgentRegistry(actor.ctx)),key).toBe('not_administrator');
  }
  const exported=await exportAgentRegistry(m.otherTenant.ctx);
  expect(exported.tenantId).toBe(m.b2.tenantId);
  expect(JSON.stringify(exported)).not.toContain(m.b.tenantId);
 });
});

describe('REVIEW pass: the approver recommendation follows native assignment',()=>{
 beforeEach(async()=>{await setWorkerSwitch(m.groupAdmin.ctx,{workerId:'approver_recommendation',enabled:true});});
 it('REVIEW pass: a recommendation is returned exactly when the inbox owner says the caller may decide',async()=>{
  for(const [key,actor] of Object.entries(all)){
   const result=await recommendLeaveDecision(actor.ctx,{leaveRequestId:requestId});
   const assigned=await pendingLeaveTaskMetadata(actor.ctx).then(rows=>rows.some(row=>row.id===requestId),()=>false);
   expect(result.kind==='recommendation',key).toBe(assigned);
  }
  // Fixed expectations where the model is unambiguous.
  expect((await recommendLeaveDecision(m.manager.ctx,{leaveRequestId:requestId})).kind).toBe('recommendation');
  for(const key of ['employee','payroll','otherCompanyAdmin','otherTenant'])
   expect((await recommendLeaveDecision(all[key].ctx,{leaveRequestId:requestId})).kind,key).toBe('unavailable');
 });
});

describe('REVIEW pass: setup co-pilot, setup readiness and the digest stay inside the caller\'s scope',()=>{
 it('REVIEW pass: the setup co-pilot refuses non-administrators',async()=>{
  for(const key of ['employee','manager','delegate','payroll']){
   const error=await setupCopilot(all[key].ctx,m.b.companyId).then(()=>null,(e:unknown)=>e);
   expect(error,key).toBeInstanceOf(SetupCopilotRefused);
  }
 });
 it('REVIEW pass: another company\'s administrator learns no employment count for this company',async()=>{
  const readiness=await setupReadiness(m.otherCompanyAdmin.ctx,m.b.companyId);
  // Company 1 has several current employments; RLS must hide all of them from company 2's administrator.
  expect([null,0]).toContain(readiness.modules.attendance?.currentEmployments??null);
 });
 it('REVIEW pass: the digest counts only the caller\'s own inbox and administered companies',async()=>{
  const forEmployee=await digestPreview(m.employee.ctx);
  expect(forEmployee.setup).toBeNull();expect(forEmployee.approvals.total).toBe(0);
  const forCompanyAdmin=await digestPreview(m.companyAdmin.ctx);
  expect(forCompanyAdmin.setup!.companies+forCompanyAdmin.setup!.unknown).toBeLessThanOrEqual(2);// one company, two owner reads
  const forOther=await digestPreview(m.otherTenant.ctx);
  expect(forOther.approvals.total).toBe(0);
  const forManager=await digestPreview(m.manager.ctx);
  expect(forManager.approvals.total).toBeGreaterThanOrEqual(1);
  expect(JSON.stringify(forManager)).not.toContain('Fictional Matrix Employee');
 });
});

describe('REVIEW pass: task memory belongs to one login',()=>{
 it('REVIEW pass: no other actor reads or overwrites the employee\'s task memory, in code or by RLS',async()=>{
  const memory:TaskMemory={version:TASK_MEMORY_VERSION,conversationId:'fictional-conversation',tenantId:m.b.tenantId,userId:m.employee.ctx.userId!,
   authorityKey:'fixture',goal:null,selections:{leave_type:'Annual Leave'},pendingQuestion:null,completedReads:[],openProposals:[],turns:1,updatedAt:new Date().toISOString()};
  await new PostgresTaskMemoryStore(m.employee.ctx).save(memory);
  for(const [key,actor] of others('employee')){
   await expect(new PostgresTaskMemoryStore(actor.ctx).load(m.b.tenantId,m.employee.ctx.userId!,'fictional-conversation'),key).rejects.toBeInstanceOf(TaskMemoryRefused);
   const rows=await withTenant(actor.ctx,tx=>tx.select().from(terasTaskMemory)).catch(()=>[]);
   expect(rows.filter(row=>row.appUserId===m.employee.ctx.userId),key).toHaveLength(0);
  }
  const principalId=await ensureAgentPrincipal(owner.db,m.b.tenantId);
  const {agentContext}=await import('../../core/agent-principal');
  const agent=agentContext(m.b.tenantId,principalId,(await entitledCtx(m.b)).entitlements!);
  expect(await withTenant(agent,tx=>tx.select().from(terasTaskMemory))).toHaveLength(0);
 });
});
