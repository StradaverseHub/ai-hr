import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {hireEmployee} from '../core/org';
import {setMandateStopSwitch} from '../core/mandates/mandates';
import {assertAiCentreRunningTx,withAiCentreActivity,aiCentreControlState,aiCentreReadAllowed} from '../core/ai-centre-control';
import {setAiCentreReadControl} from '../core/ai-centre-inventory';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,resetDb,seedBase,type Base} from './harness';

let b:Base,group:SessionContext;
async function login(base:Base,role:'hr_admin'|'employee'='hr_admin'){
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional AI Control User',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 return{...await entitledCtx(base,[role]),userId:await createAppUser(base.tenantId,hired.personId,role),personId:hired.personId,roles:[role],grants:[{role,companyId:null}]} as SessionContext;
}
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();group=await login(b);});
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
 it('invalidates an in-flight activity even after stop then resume',async()=>{
  await withAiCentreActivity(group,async()=>{
   await setMandateStopSwitch(group,true);await setMandateStopSwitch(group,false);
   await expect(generation()).rejects.toMatchObject({reason:'paused'});
   await expect(withAiCentreActivity(group,()=>generation())).rejects.toMatchObject({reason:'paused'});
  });
  expect(await generation()).toBe(2);
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
 it('can disable one explanation without disabling another, and stop-all takes precedence',async()=>{
  await setAiCentreReadControl(group,'read:explain_pay_difference',false);
  expect(await aiCentreReadAllowed(group,'explain_pay_difference')).toBe(false);
  expect(await aiCentreReadAllowed(group,'explain_leave_entitlement')).toBe(true);
  await setAiCentreReadControl(group,'read:explain_pay_difference',true);
  expect(await aiCentreReadAllowed(group,'explain_pay_difference')).toBe(true);
  await setMandateStopSwitch(group,true);
  expect(await aiCentreReadAllowed(group,'explain_pay_difference')).toBe(false);
 });
 it('rejects unknown controls and employee writes, including the SQL port',async()=>{
  const employee=await login(b,'employee');
  await expect(setAiCentreReadControl(group,'read:invented',false)).rejects.toThrow('Unknown AI function');
  await expect(setAiCentreReadControl(employee,'read:explain_pay_difference',false)).rejects.toThrow();
  await expect(withTenant(employee,tx=>tx.execute(sql`select app.ai_centre_read_set('read:explain_pay_difference',false)`))).rejects.toBeTruthy();
 });
});
