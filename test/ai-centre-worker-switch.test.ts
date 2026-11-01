/** AI centre › Workers: the two registry-controlled switches (approver recommendations, explainers) changed
 * from the page, on fictional data. The service is the authority:
 *  1. Only a group administrator changes them; a company-scoped HR administrator, a manager and an employee
 *     are refused, and another tenant's administrator changes only their own tenant.
 *  2. Only the closed list: an unknown or elsewhere-switched worker is refused.
 *  3. The worker's module is checked on every call (approver recommendations → leave, explainers → assistant).
 *  4. Every change writes an audit event (who, when, worker, state before and after) and an outcome record,
 *     and the outcome summary does not count it as a worker run. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {domainEvent} from '../db/schema';
import {terasOutcomeRecord,terasWorkerControl} from '../db/teras-schema';
import type {SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {setWorkerSwitch,workerRunGate,WORKER_SWITCH_IDENTITY} from '../core/agent-registry/controls';
import {outcomeSummary} from '../core/agent-registry/export';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base,group:SessionContext,companyHr:SessionContext,manager:SessionContext,employee:SessionContext;
async function login(base:Base,name:string,role:'employee'|'manager'|'hr_admin',companyId:string|null=null){
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,role);
 return{...await entitledCtx(base,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId}]} as SessionContext;
}
const controlRow=(tenantId:string,workerId:string)=>owner.db.select().from(terasWorkerControl).where(and(eq(terasWorkerControl.tenantId,tenantId),eq(terasWorkerControl.workerId,workerId)));
const auditOf=(tenantId:string)=>owner.db.select().from(domainEvent).where(and(eq(domainEvent.tenantId,tenantId),eq(domainEvent.aggregateType,'teras-worker'))).orderBy(domainEvent.occurredAt);
const recordsOf=(tenantId:string)=>owner.db.select().from(terasOutcomeRecord).where(and(eq(terasOutcomeRecord.tenantId,tenantId),eq(terasOutcomeRecord.agentIdentity,WORKER_SWITCH_IDENTITY)));

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 await setModule(b.tenantId,'assistant','active');
 group=await login(b,'Fictional Group Administrator','hr_admin');
 companyHr=await login(b,'Fictional Company HR Administrator','hr_admin',b.companyId);
 manager=await login(b,'Fictional Switch Manager','manager');
 employee=await login(b,'Fictional Switch Employee','employee');
});

describe('registry worker switches',()=>{
 it('lets a group administrator turn each one on and off, auditing who, when, which worker, and before and after',async()=>{
  const before=new Date(Date.now()-1000);
  expect(await setWorkerSwitch(group,{workerId:'explainers',enabled:true})).toMatchObject({enabled:true,version:1});
  expect(await workerRunGate(group,'explainers')).toEqual({run:true,reasons:[]});
  await setWorkerSwitch(group,{workerId:'explainers',enabled:false});
  await setWorkerSwitch(group,{workerId:'approver_recommendation',enabled:true});
  expect((await controlRow(b.tenantId,'explainers'))[0]).toMatchObject({enabled:false,changedByUserId:group.userId});
  const audit=await auditOf(b.tenantId);
  expect(audit.map(event=>[event.eventType,event.actorType,event.actorId,event.payload])).toEqual([
   ['teras-worker.enabled','user',group.userId,{workerId:'explainers',from:false,to:true,version:1}],
   ['teras-worker.disabled','user',group.userId,{workerId:'explainers',from:true,to:false,version:2}],
   ['teras-worker.enabled','user',group.userId,{workerId:'approver_recommendation',from:false,to:true,version:1}],
  ]);
  for(const event of audit)expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  const records=await recordsOf(b.tenantId);
  expect(records.map(record=>record.outcome).sort((x,y)=>Number(x.version)-Number(y.version)||String(x.workerId).localeCompare(String(y.workerId)))).toEqual([
   {workerId:'approver_recommendation',from:false,to:true,version:1},{workerId:'explainers',from:false,to:true,version:1},{workerId:'explainers',from:true,to:false,version:2}]);
  for(const record of records)expect(record).toMatchObject({authorityKind:'person',askedByUserId:group.userId,outcomeKind:'done',humanInvolvement:'decided',notice:'not_applicable'});
  // A switch change is not a worker run.
  const summary=await outcomeSummary(group);
  expect(summary.records).toBe(0);expect(summary.byWorker).toEqual([]);
 });

 it('refuses a company-scoped HR administrator, a manager and an employee, and writes nothing',async()=>{
  for(const ctx of [companyHr,manager,employee])for(const workerId of ['explainers','approver_recommendation'])
   await expect(setWorkerSwitch(ctx,{workerId,enabled:true}),`${ctx.grants?.[0]?.role} ${workerId}`).rejects.toMatchObject({reason:'not_administrator'});
  expect(await controlRow(b.tenantId,'explainers')).toEqual([]);
  expect(await auditOf(b.tenantId)).toEqual([]);expect(await recordsOf(b.tenantId)).toEqual([]);
 });

 it('lets another tenant\'s administrator change only their own tenant',async()=>{
  const other=await seedBase();await setModule(other.tenantId,'assistant','active');
  const otherAdmin=await login(other,'Fictional Other Tenant Administrator','hr_admin');
  await setWorkerSwitch(otherAdmin,{workerId:'explainers',enabled:true});
  expect(await controlRow(b.tenantId,'explainers')).toEqual([]);
  expect(await auditOf(b.tenantId)).toEqual([]);expect(await recordsOf(b.tenantId)).toEqual([]);
  expect(await workerRunGate(group,'explainers')).toEqual({run:false,reasons:['switched_off']});
  expect((await controlRow(other.tenantId,'explainers'))[0]).toMatchObject({enabled:true,changedByUserId:otherAdmin.userId});
  // A forged tenant id on the caller's context is refused, never applied to this tenant.
  const forged=await setWorkerSwitch({...otherAdmin,tenantId:b.tenantId},{workerId:'explainers',enabled:true}).then(()=>null,(e:unknown)=>e);
  expect(forged).not.toBeNull();
  expect(await controlRow(b.tenantId,'explainers')).toEqual([]);
 });

 it('refuses an unknown worker and every worker switched elsewhere',async()=>{
  for(const workerId of ['invented','approval_chasers','daily_digest','team_absence_weekly_summary','payroll_anomaly_narrator'])
   await expect(setWorkerSwitch(group,{workerId,enabled:true}),workerId).rejects.toMatchObject({reason:'not_switchable_here'});
  for(const input of [{workerId:'explainers',enabled:'true'},{workerId:42,enabled:true}])
   await expect(setWorkerSwitch(group,input as never)).rejects.toMatchObject({reason:'invalid'});
  expect(await auditOf(b.tenantId)).toEqual([]);
 });

 it('checks the worker\'s module on every call',async()=>{
  await setModule(b.tenantId,'assistant','disabled');
  const withoutAssistant=await login(b,'Fictional Administrator Without Assistant','hr_admin');
  await expect(setWorkerSwitch(withoutAssistant,{workerId:'explainers',enabled:true})).rejects.toMatchObject({reason:'module_not_enabled'});
  // Leave is a core module: the approver recommendation switch stays available.
  expect(await setWorkerSwitch(withoutAssistant,{workerId:'approver_recommendation',enabled:true})).toMatchObject({enabled:true});
  expect(await controlRow(b.tenantId,'explainers')).toEqual([]);
 });
});
