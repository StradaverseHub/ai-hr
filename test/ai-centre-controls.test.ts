import {proposeOwnModuleReadPlan} from '../core/module-agent-releases';
import {draftPayFormula} from '../core/pay-formula-ai';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import * as schema from '../db/schema';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {appendEvent,appendEvents,actorOf} from '../db/events';
import {hireEmployee} from '../core/org';
import {withPerformanceTenant} from '../core/module-gate';
import {setMandateStopSwitch} from '../core/mandates/mandates';
import {assertAiCentreRunningTx,withAiCentreActivity,withAiCentreFunction,aiCentreControlState,aiCentreReadAllowed} from '../core/ai-centre-control';
import {setAiCentreReadControl,aiCentreReadKeys} from '../core/ai-centre-inventory';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,resetDb,seedBase,setModule,owner,type Base} from './harness';

let b:Base,group:SessionContext;
async function login(base:Base,role:'hr_admin'|'employee'='hr_admin'){
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional AI Control User',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 return{...await entitledCtx(base,[role]),userId:await createAppUser(base.tenantId,hired.personId,role),personId:hired.personId,roles:[role],grants:[{role,companyId:null}]} as SessionContext;
}
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');group=await login(b);});
const generation=(ctx=group)=>withTenant(ctx,tx=>assertAiCentreRunningTx(tx,ctx));

describe('AI centre stop barrier',()=>{
 it('defaults to running, stops every fresh admission and preserves manual audit work',async()=>{
  expect(await aiCentreControlState(group)).toEqual({stopped:false,generation:0,pending:0});
  await setMandateStopSwitch(group,true,{expectedGeneration:0,reason:'Fixture stop'});
  await expect(generation()).rejects.toMatchObject({reason:'paused'});
  expect(await aiCentreControlState(group)).toEqual({stopped:true,generation:1,pending:0});
  await withTenant(group,tx=>appendEvent(tx,{tenantId:group.tenantId,aggregateType:'fixture',aggregateId:group.tenantId,eventType:'fixture.manual-review',actor:actorOf(group)}));
  await setMandateStopSwitch(group,false,{expectedGeneration:1});
  expect(await generation()).toBe(2);
 });
 it('enforces stop at both the model admission and template-only SQL ports',async()=>{
  await setMandateStopSwitch(group,true);
  const [model]=await withTenant(group,tx=>tx.execute<{allowed:boolean;blocked_reason:string}>(sql`select * from app.ai_admit('hr_assistant','conversation','fixture','not-sent',1)`));
  expect(model).toMatchObject({allowed:false,blocked_reason:'paused'});
  const [action]=await withTenant(group,tx=>tx.execute<{allowed:boolean}>(sql`select app.ai_agent_action_unpaused('approvals.claim.chase') as allowed`));
  expect(action.allowed).toBe(false);
 });
 it('blocks the private delivery start even when a delivery was leased before the stop',async()=>{
  const eventId=randomUUID();
  await withAiCentreActivity(group,()=>withTenant(group,tx=>appendEvent(tx,{id:eventId,tenantId:group.tenantId,aggregateType:'fixture',aggregateId:group.tenantId,eventType:'readiness.nudge-raised',actor:actorOf(group)})));
  const [employment]=await owner.db.select({id:schema.employment.id}).from(schema.employment).where(eq(schema.employment.personId,group.personId!));
  const [notice]=await owner.db.insert(schema.notification).values({tenantId:group.tenantId,recipientEmploymentId:employment.id,kind:'readiness.nudge',title:'Fixture reminder',body:'Fixture only',sourceEventId:eventId}).returning();
  const [delivery]=await owner.db.insert(schema.notificationDelivery).values({tenantId:group.tenantId,notificationId:notice.id,recipientUserId:group.userId,sourceEventId:eventId,kind:'readiness.nudge',category:'readiness',channel:'email',leaseToken:randomUUID(),leaseUntil:new Date(Date.now()+60000)}).returning();
  await setMandateStopSwitch(group,true);
  // The same table write used by the privileged delivery service has no application session to rely on.
  await expect(owner.db.update(schema.notificationDelivery).set({startedAt:new Date()}).where(eq(schema.notificationDelivery.id,delivery.id))).rejects.toBeTruthy();
  await setMandateStopSwitch(group,false);
  await expect(owner.db.update(schema.notificationDelivery).set({startedAt:new Date()}).where(eq(schema.notificationDelivery.id,delivery.id))).rejects.toBeTruthy();
  const [after]=await owner.db.select().from(schema.notificationDelivery).where(eq(schema.notificationDelivery.id,delivery.id));
  expect(after.startedAt).toBeNull();expect(after.status).toBe('pending');
 });
 it('invalidates an in-flight activity even after stop then resume',async()=>{
  await expect(withAiCentreActivity(group,async()=>{
   await setMandateStopSwitch(group,true);await setMandateStopSwitch(group,false);
   await expect(generation()).rejects.toMatchObject({reason:'paused'});
   await expect(withAiCentreActivity(group,()=>generation())).rejects.toMatchObject({reason:'paused'});
  })).rejects.toMatchObject({reason:'paused'});
  expect(await generation()).toBe(2);
 });
 it('blocks native Performance draft transactions after stopping while preserving manual work',async()=>{
  await setModule(b.tenantId,'performance','active');
  const performance={...group,entitlements:(await entitledCtx(b,['hr_admin'])).entitlements};
  let entered=false;
  await expect(withAiCentreActivity(performance,async()=>{
   await setMandateStopSwitch(group,true);
   await withPerformanceTenant(performance,async tx=>{entered=true;await tx.execute(sql`select 1`);});
  })).rejects.toMatchObject({reason:'paused'});
  expect(entered).toBe(false);
  await withPerformanceTenant(performance,tx=>appendEvent(tx,{tenantId:group.tenantId,aggregateType:'fixture',aggregateId:group.tenantId,eventType:'fixture.manual-performance',actor:actorOf(group)}));
 });
 it('stops standalone module planning before any proposal or provider work',async()=>{
  await setMandateStopSwitch(group,true);
  await expect(proposeOwnModuleReadPlan(group,{permit:'not-issued',question:'fixture',locale:'en',consent:{questionOnly:true,oneRequest:true,sourceDigest:'fixture'}})).rejects.toMatchObject({reason:'paused'});
 });
 it('refuses a stale resume without overwriting a more recent stop',async()=>{
  await setMandateStopSwitch(group,true);
  await expect(setMandateStopSwitch(group,false,{expectedGeneration:0})).rejects.toMatchObject({reason:'invalid'});
  expect((await aiCentreControlState(group)).stopped).toBe(true);
 });
 it('does not affect another tenant, and rejects unprivileged control writes',async()=>{
  const other=await seedBase(),otherGroup=await login(other),employee=await login(b,'employee');
  await setMandateStopSwitch(group,true);
  expect(await generation(otherGroup)).toBe(0);
  await expect(setMandateStopSwitch(employee,false)).rejects.toMatchObject({reason:'not_administrator'});
  await expect(aiCentreControlState(employee)).rejects.toBeTruthy();
 });
 it('serialises stop after an already-authorised effect and blocks the next effect',async()=>{
  let release!:()=>void,entered!:()=>void;
  const effectEntered=new Promise<void>(resolve=>{entered=resolve;}),effectRelease=new Promise<void>(resolve=>{release=resolve;});
  const effect=withTenant(group,async tx=>{await assertAiCentreRunningTx(tx,group);entered();await effectRelease;});
  await effectEntered;
  let stopFinished=false;
  const stop=setMandateStopSwitch(group,true).then(()=>{stopFinished=true;});
  try{
   // Separate backend proves that the stop waits on the effect's advisory lock, not on timing alone.
   const blocked=await withTenant(group,async tx=>{
    const [row]=await tx.execute<{available:boolean}>(sql`select pg_try_advisory_xact_lock(hashtext('ai-control'),hashtext(${group.tenantId}::text)) as available`);
    return row.available;
   });
   expect(blocked).toBe(false);expect(stopFinished).toBe(false);
  }finally{release();await effect;await stop;}
  await expect(generation()).rejects.toMatchObject({reason:'paused'});
 });
 it('applies the same stop boundary to bulk AI events',async()=>{
  await setMandateStopSwitch(group,true);
  await expect(withTenant(group,tx=>appendEvents(tx,[{tenantId:group.tenantId,aggregateType:'fixture',aggregateId:group.tenantId,eventType:'readiness.nudge-raised',actor:actorOf(group)}]))).rejects.toThrow('AI activity stopped');
 });
 it('does not allow a prior event to be restamped after resume',async()=>{
  const id=randomUUID();
  await withTenant(group,tx=>appendEvent(tx,{id,tenantId:group.tenantId,aggregateType:'fixture',aggregateId:group.tenantId,eventType:'readiness.nudge-raised',actor:actorOf(group),payload:{fixture:true}}));
  await setMandateStopSwitch(group,true);await setMandateStopSwitch(group,false);
  await expect(withTenant(group,tx=>tx.execute(sql`select app.ai_centre_stamp_event(${id}::uuid,2)`))).rejects.toBeTruthy();
  const [event]=await owner.db.select({payload:schema.domainEvent.payload}).from(schema.domainEvent).where(eq(schema.domainEvent.id,id));
  expect(event.payload).toEqual({fixture:true});
 });
 it('invalidates unsent AI notifications after stopping, while manual notifications remain eligible',async()=>{
  const ai=randomUUID(),manual=randomUUID();
  await withAiCentreActivity(group,()=>withTenant(group,async tx=>{
   await appendEvent(tx,{id:ai,tenantId:group.tenantId,aggregateType:'fixture',aggregateId:group.tenantId,eventType:'readiness.nudge-raised',actor:actorOf(group)});
   await appendEvent(tx,{id:manual,tenantId:group.tenantId,aggregateType:'fixture',aggregateId:group.tenantId,eventType:'fixture.manual',actor:actorOf(group)});
  }));
  const allowed=(id:string)=>withTenant(group,async tx=>(await tx.execute<{allowed:boolean}>(sql`select app.ai_centre_event_allowed(${id}::uuid) as allowed`))[0].allowed);
  expect(await allowed(ai)).toBe(true);
  await setMandateStopSwitch(group,true);
  expect(await allowed(ai)).toBe(false);expect(await allowed(manual)).toBe(true);
  await setMandateStopSwitch(group,false);
  expect(await allowed(ai)).toBe(false);
 });
});

describe('individual AI read controls',()=>{
 it('registers every current read and module, and fails closed for future unknown functions',async()=>{
  const rows=await owner.db.execute<{function_key:string}>(sql`select function_key from app.ai_centre_function_kind order by function_key collate "C"`);
  expect(Array.from(rows).map(row=>row.function_key)).toEqual([...aiCentreReadKeys()].sort());
  expect(await aiCentreReadAllowed(group,'read:future_unknown_function')).toBe(false);
  await expect(withTenant(group,tx=>tx.execute(sql`select app.ai_centre_read_set('read:future_unknown_function',true)`))).rejects.toBeTruthy();
 });
 it('can disable one explanation without disabling another, and stop-all takes precedence',async()=>{
  await setAiCentreReadControl(group,'read:explain_pay_difference',false);
  expect(await aiCentreReadAllowed(group,'explain_pay_difference')).toBe(false);
  expect(await aiCentreReadAllowed(group,'explain_leave_entitlement')).toBe(true);
  await setAiCentreReadControl(group,'read:explain_pay_difference',true);
  expect(await aiCentreReadAllowed(group,'explain_pay_difference')).toBe(true);
  await setMandateStopSwitch(group,true);
  expect(await aiCentreReadAllowed(group,'explain_pay_difference')).toBe(false);
 });
 it('independently stops a standalone draft operation before its source or provider can run',async()=>{
  await setAiCentreReadControl(group,'read:operation_pay_formula_draft',false);
  await expect(draftPayFormula(group,{})).rejects.toMatchObject({reason:'paused'});
  expect(await aiCentreReadAllowed(group,'read:operation_pay_rule_draft')).toBe(true);
 });
 it('rechecks a function inside the native effect transaction when it is switched off mid-operation',async()=>{
  await expect(withAiCentreFunction(group,'read:explain_pay_difference',async()=>{
   await setAiCentreReadControl(group,'read:explain_pay_difference',false);
   await withTenant(group,tx=>appendEvent(tx,{tenantId:group.tenantId,aggregateType:'fixture',aggregateId:group.tenantId,eventType:'fixture.ai-effect',actor:actorOf(group)}));
  })).rejects.toThrow('AI function stopped');
  const [row]=await withTenant(group,tx=>tx.execute<{n:number}>(sql`select count(*)::integer as n from public.domain_event where tenant_id=app.current_tenant_id() and event_type='fixture.ai-effect'`));
  expect(row.n).toBe(0);
 });
 it('rejects unknown controls and employee writes, including the SQL port',async()=>{
  const employee=await login(b,'employee');
  await expect(setAiCentreReadControl(group,'read:invented',false)).rejects.toThrow('Unknown AI function');
  await expect(setAiCentreReadControl(employee,'read:explain_pay_difference',false)).rejects.toThrow();
  await expect(withTenant(employee,tx=>tx.execute(sql`select app.ai_centre_read_set('read:explain_pay_difference',false)`))).rejects.toBeTruthy();
 });
});
