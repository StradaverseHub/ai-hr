/** ADR-0169 §5.1 wiring — the per-tenant Noveri conversation switch on fictional data. The service and the
 * database are the authorities:
 *  1. Off by default; only a group administrator changes it, every change audited and recorded. A company-scoped
 *     HR administrator, a manager and an employee are refused by the service and by row-level security.
 *  2. Tenant A's switch never enables tenant B.
 *  3. The chat takes the harness path only when the switch is on, the tenant is not stopped and the caller holds
 *     the Assistant grant.
 *  4. The direct-provider attestation names the active direct provider only.
 *  5. The staging operator path writes as the owner with an operator label (migration 0901) and its audit event;
 *     the application role can never write an operator row. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import postgres from 'postgres';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {aiProviderConfig,domainEvent} from '../db/schema';
import {terasOutcomeRecord,terasWorkerControl} from '../db/teras-schema';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {grantAssistant} from '../core/assistant-grant';
import {setWorkerSwitch,workerRunGate,WORKER_SWITCH_IDENTITY} from '../core/agent-registry/controls';
import {setMandateStopSwitch} from '../core/mandates/mandates';
import {conversationRoute} from '../core/teras-wiring/switch';
import {encryptSecret} from '../lib/ai/crypto';
import {runSwitch,parseSwitchArguments} from '../scripts/operator/teras-conversation-switch-core';
import {switchDatabase} from '../scripts/operator/teras-conversation-switch';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base,group:SessionContext,companyHr:SessionContext,manager:SessionContext,employee:SessionContext;
async function login(base:Base,name:string,role:'employee'|'manager'|'hr_admin',companyId:string|null=null,grant=true){
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,role);
 if(grant)await grantAssistant(adminCtx(base),{appUserId:userId});
 return{...await entitledCtx(base,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId}]} as SessionContext;
}
const row=(tenantId:string)=>owner.db.select().from(terasWorkerControl).where(and(eq(terasWorkerControl.tenantId,tenantId),eq(terasWorkerControl.workerId,'conversation')));
const audit=(tenantId:string)=>owner.db.select().from(domainEvent).where(and(eq(domainEvent.tenantId,tenantId),eq(domainEvent.aggregateType,'teras-worker'))).orderBy(domainEvent.sequence);
const records=(tenantId:string)=>owner.db.select().from(terasOutcomeRecord).where(and(eq(terasOutcomeRecord.tenantId,tenantId),eq(terasOutcomeRecord.agentIdentity,WORKER_SWITCH_IDENTITY)));
const route=async(ctx:SessionContext)=>(await conversationRoute(ctx)).route;

beforeAll(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-switch-passphrase');await migrateTestDb();});
afterAll(async()=>{await closeAll();vi.unstubAllEnvs();});
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 await setModule(b.tenantId,'assistant','active');
 group=await login(b,'Fictional Group Administrator','hr_admin');
 companyHr=await login(b,'Fictional Company HR Administrator','hr_admin',b.companyId);
 manager=await login(b,'Fictional Conversation Manager','manager');
 employee=await login(b,'Fictional Conversation Employee','employee');
});

describe('the Noveri conversation switch',()=>{
 it('is off by default and turned on and off only by a group administrator, audited and recorded',async()=>{
  expect(await row(b.tenantId)).toEqual([]);
  for(const ctx of [group,companyHr,manager,employee])expect(await route(ctx)).toBe('closed');
  await setWorkerSwitch(group,{workerId:'conversation',enabled:true});
  expect(await workerRunGate(group,'conversation')).toEqual({run:true,reasons:[]});
  for(const ctx of [group,companyHr,manager,employee])expect(await route(ctx),ctx.roles?.join()).toBe('harness');
  await setWorkerSwitch(group,{workerId:'conversation',enabled:false});
  expect(await route(employee)).toBe('closed');
  expect((await row(b.tenantId))[0]).toMatchObject({enabled:false,changedByUserId:group.userId,changedByOperator:null,attestedProvider:null,version:2});
  expect((await audit(b.tenantId)).map(event=>[event.eventType,event.actorType,event.actorId,event.payload])).toEqual([
   ['teras-worker.enabled','user',group.userId,{workerId:'conversation',from:false,to:true,version:1,attestedProvider:null}],
   ['teras-worker.disabled','user',group.userId,{workerId:'conversation',from:true,to:false,version:2,attestedProvider:null}]]);
  expect((await records(b.tenantId)).map(record=>record.outcome).sort((x,y)=>Number(x.version)-Number(y.version))).toEqual([
   {workerId:'conversation',from:false,to:true,version:1,attestedProvider:null},{workerId:'conversation',from:true,to:false,version:2,attestedProvider:null}]);
 });

 it('refuses a company-scoped HR administrator, a manager and an employee in the service and in the database',async()=>{
  for(const ctx of [companyHr,manager,employee]){
   await expect(setWorkerSwitch(ctx,{workerId:'conversation',enabled:true}),ctx.grants?.[0]?.companyId?'company hr':ctx.roles?.join()).rejects.toMatchObject({reason:'not_administrator'});
   const direct=await withTenant(ctx,tx=>tx.insert(terasWorkerControl).values({tenantId:b.tenantId,workerId:'conversation',enabled:true,changedByUserId:ctx.userId!})).then(()=>null,(error:unknown)=>error);
   expect(direct).not.toBeNull();
  }
  expect(await row(b.tenantId)).toEqual([]);expect(await audit(b.tenantId)).toEqual([]);expect(await records(b.tenantId)).toEqual([]);
  expect(await route(employee)).toBe('closed');
 });

 it('never lets tenant A\'s switch enable tenant B',async()=>{
  const other=await seedBase();await setModule(other.tenantId,'assistant','active');
  const otherEmployee=await login(other,'Fictional Other Tenant Employee','employee');
  await setWorkerSwitch(group,{workerId:'conversation',enabled:true});
  expect(await route(employee)).toBe('harness');
  expect(await route(otherEmployee)).toBe('closed');
  expect(await row(other.tenantId)).toEqual([]);
  // A context that claims tenant A while being tenant B's login reads nothing of A.
  expect(await route({...otherEmployee,tenantId:b.tenantId})).toBe('closed');
 });

 it('takes the harness path only with the Assistant grant, the module on and the tenant not stopped',async()=>{
  await setWorkerSwitch(group,{workerId:'conversation',enabled:true});
  const ungranted=await login(b,'Fictional Ungranted Employee','employee',null,false);
  expect(await route(ungranted)).toBe('closed');
  await setMandateStopSwitch(group,true);expect(await route(employee)).toBe('closed');
  await setMandateStopSwitch(group,false);expect(await route(employee)).toBe('harness');
 });

 it('records the direct-provider attestation for the active direct provider only, and clears it without one',async()=>{
  await expect(setWorkerSwitch(group,{workerId:'conversation',enabled:true,attestDirectProvider:true})).rejects.toMatchObject({reason:'attestation_not_applicable'});
  await expect(setWorkerSwitch(group,{workerId:'explainers',enabled:true,attestDirectProvider:true})).rejects.toMatchObject({reason:'attestation_not_applicable'});
  await owner.db.insert(aiProviderConfig).values({tenantId:b.tenantId,provider:'anthropic',model:'fictional-model',apiKeyCiphertext:encryptSecret('fictional-no-network-key',b.tenantId),keyLast4:'-key',isActive:true});
  await setWorkerSwitch(group,{workerId:'conversation',enabled:true,attestDirectProvider:true});
  expect((await row(b.tenantId))[0]).toMatchObject({enabled:true,attestedProvider:'anthropic'});
  expect(await conversationRoute(employee)).toMatchObject({route:'harness',attestedProvider:'anthropic'});
  await setWorkerSwitch(group,{workerId:'conversation',enabled:true});
  expect((await row(b.tenantId))[0]).toMatchObject({enabled:true,attestedProvider:null});
 });
});

describe('the staging operator path',()=>{
 it('switches every tenant on with an operator label and an audit event, and the application role cannot write such a row',async()=>{
  const other=await seedBase();
  const connection=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:1,onnotice:()=>{}});
  try{
   const db=switchDatabase(connection),identity=await db.identity();
   const dry=await runSwitch(db,parseSwitchArguments(['--environment','staging','--operator','ci-fixture']));
   expect(dry.applied).toBe(false);expect(await row(b.tenantId)).toEqual([]);
   expect(dry.tenants.map(tenant=>tenant.tenantId).sort()).toEqual([b.tenantId,other.tenantId].sort());
   await runSwitch(db,parseSwitchArguments(['--environment','staging','--operator','ci-fixture','--apply','--confirm-fictional-data','--expected-database-identity',identity]));
   for(const tenantId of [b.tenantId,other.tenantId]){
    expect((await row(tenantId))[0]).toMatchObject({enabled:true,changedByUserId:null,changedByOperator:'operator:ci-fixture',attestedProvider:null,version:1});
    expect((await audit(tenantId)).map(event=>[event.eventType,event.actorType,event.payload])).toEqual([
     ['teras-worker.enabled','system',{workerId:'conversation',from:false,to:true,version:1,operator:'operator:ci-fixture',environment:'staging',attestedProvider:null}]]);
   }
   expect(await route(employee)).toBe('harness');
   // The application role, even as the group administrator, cannot attribute a row to an operator.
   const forged=await withTenant(group,tx=>tx.update(terasWorkerControl).set({changedByUserId:null,changedByOperator:'operator:forged'})
    .where(eq(terasWorkerControl.workerId,'conversation'))).then(()=>null,(error:unknown)=>error);
   expect(forged).not.toBeNull();
   await expect(owner.db.insert(terasWorkerControl).values({tenantId:b.tenantId,workerId:'explainers',enabled:true,changedByUserId:null,changedByOperator:'operator:ci-fixture'})).rejects.toThrow();
   await runSwitch(db,parseSwitchArguments(['--environment','staging','--operator','ci-fixture','--apply','--off','--expected-database-identity',identity]));
   expect(await route(employee)).toBe('closed');
  }finally{await connection.end({timeout:5});}
 });
});
