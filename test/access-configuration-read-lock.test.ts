import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {hireEmployee} from '../core/org';
import {listEmployees,listEmployeesPage,listWorkforcePickOptions,countEmployeesByStatus,employeeDetail,personnelListPage,searchWorkforceEmployees,searchWorkforceEmployeesTx} from '../core/read';
import {workforceCompanies,workforceEmploymentAccess,workforceCommandAccess} from '../core/workforce-access';
import {lockAccessConfigurationTx,lockAccessConfigurationReadTx} from '../core/access-configuration-lock';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
function barrier(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function bounded(promise:Promise<unknown>){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Independent metadata readers did not overlap')),2000);})]);}finally{clearTimeout(timer);}}
it('admits simultaneous metadata readers but excludes the existing configuration writer until both finish',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b),key='access-configuration:'+b.tenantId;
 const entered=[barrier(),barrier()],release=[barrier(),barrier()];
 const readers=entered.map((entry,i)=>withTenant(ctx,async tx=>{await lockAccessConfigurationReadTx(tx,b.tenantId);entry.resolve();await release[i].promise;}));
 let writer:Promise<unknown>|undefined;
 const tryWriter=async()=>owner.client.begin(async tx=>{const [row]=await tx`select pg_try_advisory_xact_lock(hashtextextended(${key},0)) as acquired`;return row.acquired;});
 try{
  await bounded(Promise.all(entered.map(value=>value.promise)));
  expect(await tryWriter()).toBe(false);
  writer=withTenant(ctx,async tx=>{await lockAccessConfigurationTx(tx,b.tenantId);return true;});
  release[0].resolve();await readers[0];expect(await tryWriter()).toBe(false);
  release[1].resolve();await readers[1];expect(await bounded(writer)).toBe(true);
  expect(await tryWriter()).toBe(true);
 }finally{release.forEach(value=>value.resolve());await Promise.allSettled([...readers,...(writer?[writer]:[])]);}
});
it('keeps a metadata reader behind a native exclusive writer on the same tenant key',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b),entered=barrier(),release=barrier();
 const writer=withTenant(ctx,async tx=>{await lockAccessConfigurationTx(tx,b.tenantId);entered.resolve();await release.promise;});
 let reader:Promise<unknown>|undefined;
 try{
  await bounded(entered.promise);
  const available=await owner.client.begin(async tx=>{const [row]=await tx`select pg_try_advisory_xact_lock_shared(hashtextextended(${'access-configuration:'+b.tenantId},0)) as acquired`;return row.acquired;});
  expect(available).toBe(false);
  reader=withTenant(ctx,async tx=>{await lockAccessConfigurationReadTx(tx,b.tenantId);return true;});
  release.resolve();await writer;expect(await bounded(reader)).toBe(true);
 }finally{release.resolve();await Promise.allSettled([writer,...(reader?[reader]:[])]);}
});

// Exercise the actual public wrappers while an independent reader holds the same native lock.
it.each(['companies','employment','command'] as const)('lets standalone %s metadata overlap an existing reader',async kind=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional metadata subject',primaryEmail:'metadata@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const entered=barrier(),release=barrier();
 const holder=withTenant(ctx,async tx=>{await lockAccessConfigurationReadTx(tx,b.tenantId);entered.resolve();await release.promise;});
 let read:Promise<unknown>|undefined;
 try{
  await bounded(entered.promise);
  read=kind==='companies'?workforceCompanies(ctx,'maintain'):kind==='employment'?workforceEmploymentAccess(ctx,hired.employmentId,'maintain'):workforceCommandAccess(ctx,hired.employmentId);
  expect(await bounded(read)).toEqual(kind==='companies'?[b.companyId]:true);
 }finally{release.resolve();await Promise.allSettled([holder,...(read?[read]:[])]);}
});
it.each(['view','maintain'] as const)('keeps borrowed %s metadata exclusive for the caller transaction',async operation=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b),key='access-configuration:'+b.tenantId;
 await withTenant(ctx,async tx=>{
  await workforceCompanies(ctx,operation,tx);
  const readerCouldEnter=await owner.client.begin(async observer=>{
   const [row]=await observer`select pg_try_advisory_xact_lock_shared(hashtextextended(${key},0))as acquired`;return row.acquired;
  });
  expect(readerCouldEnter).toBe(false);
 });
 const [released]=await owner.client`select pg_try_advisory_xact_lock_shared(hashtextextended(${key},0))as acquired`;
 expect(released.acquired).toBe(true);
});

it.each(['list','picker','counts','page','personnel','switcher','detail'] as const)('lets a complete standalone Workforce %s projection overlap another native reader',async kind=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional projection subject',primaryEmail:'projection@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const entered=barrier(),release=barrier();
 const holder=withTenant(ctx,async tx=>{await lockAccessConfigurationReadTx(tx,b.tenantId);entered.resolve();await release.promise;});
 let read:Promise<unknown>|undefined;
 try{
  await bounded(entered.promise);
  read=kind==='list'?listEmployees(ctx,[b.companyId],'workforce'):kind==='picker'?listWorkforcePickOptions(ctx,[b.companyId]):kind==='counts'?countEmployeesByStatus(ctx,{companyIds:[b.companyId]},'workforce'):kind==='page'?listEmployeesPage(ctx,{companyIds:[b.companyId],limit:25,offset:0},'workforce'):kind==='personnel'?personnelListPage(ctx,{companyIds:[b.companyId],limit:25,offset:0},{companyIds:[b.companyId]}):kind==='switcher'?searchWorkforceEmployees(ctx,[b.companyId],'Fictional projection subject'):employeeDetail(ctx,hired.employmentId,'workforce');
  const value=await bounded(read);
  if(kind==='list'||kind==='picker'||kind==='switcher')expect(value).toEqual([expect.objectContaining({employmentId:hired.employmentId})]);
  else if(kind==='counts'||kind==='page'||kind==='personnel')expect(value).toMatchObject({total:1});
  else expect(value).toMatchObject({employmentId:hired.employmentId});
 }finally{release.resolve();await Promise.allSettled([holder,...(read?[read]:[])]);}
});
it.each(['list','page','switcher','detail'] as const)('keeps a borrowed Workforce %s projection exclusive for the command-owned transaction',async kind=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b),key='access-configuration:'+b.tenantId;
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional borrowed projection',primaryEmail:'borrowed-projection@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 await withTenant(ctx,async tx=>{
  if(kind==='list')await listEmployees(ctx,[b.companyId],'workforce',tx);
  else if(kind==='page')await listEmployeesPage(ctx,{companyIds:[b.companyId],limit:25,offset:0},'workforce',tx);
  else if(kind==='switcher')await searchWorkforceEmployeesTx(ctx,tx,[b.companyId],'Fictional borrowed projection');
  else await employeeDetail(ctx,hired.employmentId,'workforce',tx);
  const [entry]=await owner.client.begin(async observer=>observer`select pg_try_advisory_xact_lock_shared(hashtextextended(${key},0))as acquired`);
  expect(entry.acquired).toBe(false);
 });
});

it('keeps the standalone Personnel switcher behind an exclusive Access writer',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b),entered=barrier(),release=barrier();
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional protected switcher',primaryEmail:'protected-switcher@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 let writerPid:number|undefined;
 const writer=withTenant(ctx,async tx=>{
  await lockAccessConfigurationTx(tx,b.tenantId);
  const [row]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);
  writerPid=row.pid;entered.resolve();await release.promise;
 });
 let read:ReturnType<typeof searchWorkforceEmployees>|undefined;
 try{
  await bounded(entered.promise);
  read=searchWorkforceEmployees(ctx,[b.companyId],'Fictional protected switcher');
  let waiting=false;
  const stop=Date.now()+2000;
  while(!waiting&&Date.now()<stop){
   const [row]=await owner.client`select exists(select 1 from pg_locks where locktype='advisory' and mode='ShareLock' and not granted and ${writerPid!}::integer=any(pg_blocking_pids(pid))) as waiting`;
   waiting=row.waiting;
   if(!waiting)await new Promise(resolve=>setTimeout(resolve,20));
  }
  expect(waiting,'the actual switcher waits with a shared lock on the writer').toBe(true);
  release.resolve();await writer;
  expect(await bounded(read)).toEqual([expect.objectContaining({employmentId:hired.employmentId})]);
 }finally{release.resolve();await Promise.allSettled([writer,...(read?[read]:[])]);}
});
