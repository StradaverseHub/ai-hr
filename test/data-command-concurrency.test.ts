/** Native request writers must overlap before audit append; access writers remain exclusive. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withDataCommand} from '../core/data-command';
import {lockLeaveDependencyConfigurationTx} from '../core/leave-dependency-lock';
import {withTenant} from '../db/client';
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

function barrier(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
it('holds real native account revocation out until the shared command commits, then refuses the archived carrier',async()=>{
 await resetDb();const b=await seedBase(),userId=await createAppUser(b.tenantId,null,'employee');
 const ctx:SessionContext={tenantId:b.tenantId,userId,roles:['employee']},entered=barrier(),release=barrier();
 const holder=withDataCommand(ctx,async tx=>{
  const [row]=await tx.execute<{shared:boolean}>(sql`select exists(select 1 from pg_locks where pid=pg_backend_pid() and locktype='advisory' and mode='ShareLock' and granted) as shared`);
  expect(row.shared).toBe(true);entered.resolve();await release.promise;
 });
 let revoker:Promise<unknown>|undefined,pid:number|undefined,waiting=false;
 try{
  await entered.promise;
  revoker=owner.client.begin(async connection=>{const [row]=await connection`select pg_backend_pid() as pid`;pid=row.pid;await connection`update app_user set archived_at=now() where id=${userId}::uuid`;});
  const outcome=revoker.then(()=>({ok:true}),error=>({ok:false,error}));
  const until=Date.now()+300;
  while(Date.now()<until){if(pid){const [row]=await owner.client`select exists(select 1 from pg_locks where pid=${pid} and locktype='advisory' and not granted) as waiting`;if(row.waiting){waiting=true;break;}}await delay(3);}
  release.resolve();await holder;expect(await outcome).toEqual({ok:true});
 }finally{release.resolve();await Promise.allSettled([holder,...(revoker?[revoker]:[])]);}
 expect(waiting,'native user authority trigger still waits for the ordinary command').toBe(true);
 await expect(withDataCommand(ctx,async()=>true)).rejects.toThrow('Current command principal required');
});
it('rolls back the entire shared attempt before exactly one exclusive configuration replay',async()=>{
 await resetDb();const b=await seedBase(),name='Fictional replay '+randomUUID();let attempts=0;
 await withDataCommand(adminCtx(b),async tx=>{
  attempts++;await tx.insert(s.person).values({tenantId:b.tenantId,fullName:name});
  await lockLeaveDependencyConfigurationTx(tx,b.tenantId);
 });
 expect(attempts).toBe(2);
 expect(await owner.db.select({id:s.person.id}).from(s.person).where(eq(s.person.fullName,name))).toHaveLength(1);
 let failures=0;
 await expect(withDataCommand(adminCtx(b),async tx=>{failures++;await tx.insert(s.person).values({tenantId:b.tenantId,fullName:name+' refused'});throw new Error('Fictional business refusal');})).rejects.toThrow('Fictional business refusal');
 expect(failures).toBe(1);
 expect(await owner.db.select({id:s.person.id}).from(s.person).where(eq(s.person.fullName,name+' refused'))).toHaveLength(0);
});
it('does not turn a real read-only snapshot into an ordinary write transaction',async()=>{
 await resetDb();const b=await seedBase();
 const {beginDataCommandAuthorityTx}=await import('../core/access-configuration-lock');
 await expect(withTenant(adminCtx(b),tx=>beginDataCommandAuthorityTx(tx,b.tenantId),{readOnlySnapshot:true})).rejects.toThrow('Writable current tenant transaction required');
});
