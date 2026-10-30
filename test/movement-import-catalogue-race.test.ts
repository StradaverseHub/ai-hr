import {randomUUID} from 'node:crypto';
import {asc,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {domainEvent,movementEventType} from '../db/schema';
import * as tenantClient from '../db/client';
import {hireEmployee} from '../core/org';
import * as movementOwner from '../core/movement';
import {previewMovementImport,commitMovementImport} from '../core/movement-import';
import {saveMovementEventType,setMovementEventTypeActive,deleteMovementEventType} from '../core/movement-type';
import {todayInKualaLumpur} from '../lib/hr-date';
import {toCsv} from '../lib/csv';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
describe('canonical catalogue mutation versus import final admission',()=>{
 it.each(['remap','deactivate','delete','missing_builtin_overlay'] as const)('serializes %s after the final fingerprint until import commits, preserving actual result agreement',async mode=>{
  const ctx=adminCtx(b),e=await hireEmployee(ctx,{person:{fullName:'Fictional catalogue race',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-60),employeeCode:'B20-RACE'});
  const code=mode==='missing_builtin_overlay'?'transfer':(await saveMovementEventType(ctx,{label:'Fictional coordinated promotion',behaviourKind:'promotion'})).code;
  if(mode==='missing_builtin_overlay')expect(await owner.db.select().from(movementEventType).where(eq(movementEventType.tenantId,b.tenantId))).toEqual([]);
  const csv=toCsv([['employee_code','event_type','effective_date','department_id'],['B20-RACE',code,day(-2),b.deptB]]),preview=await previewMovementImport(ctx,{companyId:b.companyId,csv});expect(preview.valid).toBe(1);
  let release!:()=>void;const released=new Promise<void>(resolve=>{release=resolve;});let paused=false,stateCalls=0,tagNext=false;
  const originalState=movementOwner.movementCurrentStateTx;
  // Two state reads occur in the rollback rehearsal. The third is the real replay, AFTER its fresh CAS.
  const stateSpy=vi.spyOn(movementOwner,'movementCurrentStateTx').mockImplementation(async(...args)=>{const state=await originalState(...args);if(++stateCalls===3){paused=true;await released;}return state;});
  const originalTenant=tenantClient.withTenant,tag='b20-catalogue-'+randomUUID();
  const taggedTenant:typeof originalTenant=async<T>(context:tenantClient.SessionContext,fn:(tx:tenantClient.Tx)=>Promise<T>,options?:{readOnlySnapshot:true})=>{
   const tagged=tagNext;tagNext=false;
   return originalTenant(context,async tx=>{if(tagged)await tx.execute(sql`select set_config('application_name',${tag},true)`);return fn(tx);},options);
  };
  const tenantSpy=vi.spyOn(tenantClient,'withTenant').mockImplementation(taggedTenant);
  const importing=commitMovementImport(ctx,{companyId:b.companyId,csv,selection:preview.selection,inputHash:preview.inputHash,fingerprints:Object.fromEntries(preview.employees.map(employee=>[employee.employeeCode,employee.fingerprint!])),acknowledgeExcluded:false});
  let mutation:Promise<{ok:true}|{ok:false;error:unknown}>|undefined;
  try{
   await vi.waitFor(()=>expect(paused).toBe(true),{timeout:5000,interval:10});tagNext=true;
   const writing=mode==='remap'?saveMovementEventType(ctx,{code,label:'Fictional remapped type',behaviourKind:'secondment'}):mode==='delete'?deleteMovementEventType(ctx,code):setMovementEventTypeActive(ctx,{code,active:false});
   mutation=writing.then(()=>({ok:true as const}),error=>({ok:false as const,error}));
   await vi.waitFor(async()=>{
    const [waiting]=await owner.db.execute<{blocked:boolean}>(sql`select exists(select 1 from pg_catalog.pg_locks l join pg_catalog.pg_stat_activity a on a.pid=l.pid where a.application_name=${tag} and l.locktype='advisory' and not l.granted) as blocked`);
    expect(waiting.blocked).toBe(true);
   },{timeout:5000,interval:10});
   release();const result=await importing,outcome=await mutation;expect(result).toMatchObject({imported:1,failed:0});
   expect(result.employees[0].rows[0].proposed?.departmentId).toBe('Operations');expect((await movementOwner.movementCurrentState(ctx,e.employmentId)).departmentId).toBe(b.deptB);
   const events=await owner.db.select().from(domainEvent).where(eq(domainEvent.subjectEmploymentId,e.employmentId)).orderBy(asc(domainEvent.sequence));
   expect(events).toEqual(expect.arrayContaining([expect.objectContaining({payload:expect.objectContaining({movement:expect.objectContaining({type:code})})})]));
   // 1d58019a Step 2 — once the import commits the type is used, so a queued remap is refused like a delete.
   if(mode==='delete'||mode==='remap'){expect(outcome.ok).toBe(false);if(!outcome.ok)expect(outcome.error).toMatchObject({message:expect.stringContaining('already used')});}
   else expect(outcome.ok).toBe(true);
  }finally{release();await Promise.allSettled([importing,...(mutation?[mutation]:[])]);stateSpy.mockRestore();tenantSpy.mockRestore();}
 });
});
