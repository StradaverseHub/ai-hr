import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import {hireEmployee} from '../core/org';
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
