/** Native request writers must overlap before audit append; access writers remain exclusive. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase} from './harness';
import {hireEmployee,setReportingLine} from '../core/org';
import {requestLeave} from '../packs/leave/service';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
beforeAll(migrateTestDb);afterAll(closeAll);
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
it('commits a different employee request while the first real request is paused before its insert and audit append',async()=>{
 await resetDb();const b=await seedBase(),today=todayInKualaLumpur();
 const worker=async(name:string)=>{
  const hired=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:today});
  const ctx:SessionContext={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,hired.personId,'employee'),personId:hired.personId,roles:['employee'],entitlements:harnessSnapshot(b.tenantId)};
  return {...hired,ctx};
 };
 const a=await worker('Fictional concurrency A'),c=await worker('Fictional concurrency B'),manager=await worker('Fictional concurrency manager');
 for(const employee of [a,c]){
  await setReportingLine(adminCtx(b),{subordinateEmploymentId:employee.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:today});
  await owner.db.insert(s.leaveLedger).values({tenantId:b.tenantId,employmentId:employee.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'20.00',effectiveOn:today.slice(0,4)+'-01-01'});
 }
 let date=new Date(Date.parse(today+'T12:00:00Z')+3*86400000).toISOString().slice(0,10);
 while([0,6].includes(new Date(date+'T12:00:00Z').getUTCDay()))date=new Date(Date.parse(date+'T12:00:00Z')+86400000).toISOString().slice(0,10);
 const gate='test-data-command:'+randomUUID(),connection=await owner.client.reserve();
 await owner.client.unsafe(`create function public.perf_request_pause() returns trigger language plpgsql as $body$ begin if new.employment_id='${a.employmentId}'::uuid then perform pg_advisory_xact_lock(hashtextextended('${gate}',0)); end if; return new; end $body$; create trigger a_perf_request_pause before insert on leave_request for each row execute function public.perf_request_pause()`);
 const submit=(employee:typeof a)=>requestLeave(employee.ctx,{employmentId:employee.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date});
 type Outcome={ok:true;id:string}|{ok:false;error:unknown};
 const settle=(promise:ReturnType<typeof submit>):Promise<Outcome>=>promise.then(result=>({ok:true,id:result.leaveRequestId}),error=>({ok:false,error}));
 let first:Promise<Outcome>|undefined,second:Promise<Outcome>|undefined,overlapped=false,reached=false;
 try{
  await connection`select pg_advisory_lock(hashtextextended(${gate},0))`;
  first=settle(submit(a));
  const until=Date.now()+2000;
  while(Date.now()<until){
   const [row]=await owner.client`select exists(select 1 from pg_locks where locktype='advisory' and not granted and classid=((hashtextextended(${gate},0)>>32)&4294967295)::oid and objid=(hashtextextended(${gate},0)&4294967295)::oid) as waiting`;
   if(row.waiting){reached=true;break;}await delay(3);
  }
  if(reached){second=settle(submit(c));overlapped=await Promise.race([second.then(result=>result.ok),delay(200).then(()=>false)]);}
 }finally{
  await connection`select pg_advisory_unlock(hashtextextended(${gate},0))`;connection.release();
 }
 const outcomes=await Promise.all([...(first?[first]:[]),...(second?[second]:[])]);
 await owner.client.unsafe('drop trigger a_perf_request_pause on leave_request; drop function public.perf_request_pause()');
 expect(reached,'first real request reaches native pre-insert pause').toBe(true);
 expect(outcomes,'both original native requests remain valid').toEqual([expect.objectContaining({ok:true}),expect.objectContaining({ok:true})]);
 const [persisted]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from leave_request where tenant_id=${b.tenantId}::uuid and employment_id in (${a.employmentId}::uuid,${c.employmentId}::uuid)`);
 expect(persisted.n).toBe(2);
 expect(overlapped,'unrelated employee B commits before A releases its pre-insert gate').toBe(true);
});
