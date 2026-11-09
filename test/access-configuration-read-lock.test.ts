import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {hireEmployee} from '../core/org';
import {listEmployees,listEmployeesPage,listWorkforcePickOptions,countEmployeesByStatus,employeeDetail,personnelListPage,searchWorkforceEmployees,searchWorkforceEmployeesTx} from '../core/read';
import {workforceCompanies,workforceEmploymentAccess,workforceCommandAccess} from '../core/workforce-access';
import {workforceRecord} from '../core/workforce-record';
import {withPersonnelRead} from '../core/personnel-read-bounds';
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
it.each(['companies','employment','command'] as const)('lets standalone %s metadata complete while an exclusive writer is active',async kind=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional metadata subject',primaryEmail:'metadata@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const entered=barrier(),release=barrier();
 const holder=withTenant(ctx,async tx=>{await lockAccessConfigurationTx(tx,b.tenantId);entered.resolve();await release.promise;});
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

it.each(['list','picker','counts','page','personnel','switcher','record','detail'] as const)('lets a complete standalone Workforce %s projection finish while an exclusive writer is active',async kind=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional projection subject',primaryEmail:'projection@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const entered=barrier(),release=barrier();
 const holder=withTenant(ctx,async tx=>{await lockAccessConfigurationTx(tx,b.tenantId);entered.resolve();await release.promise;});
 let read:Promise<unknown>|undefined;
 try{
  await bounded(entered.promise);
  read=kind==='list'?listEmployees(ctx,[b.companyId],'workforce'):kind==='picker'?listWorkforcePickOptions(ctx,[b.companyId]):kind==='counts'?countEmployeesByStatus(ctx,{companyIds:[b.companyId]},'workforce'):kind==='page'?listEmployeesPage(ctx,{companyIds:[b.companyId],limit:25,offset:0},'workforce'):kind==='personnel'?personnelListPage(ctx,{companyIds:[b.companyId],limit:25,offset:0},{companyIds:[b.companyId]}):kind==='switcher'?searchWorkforceEmployees(ctx,[b.companyId],'Fictional projection subject'):kind==='record'?workforceRecord(ctx,hired.employmentId):employeeDetail(ctx,hired.employmentId,'workforce');
  const value=await bounded(read);
  if(kind==='list'||kind==='picker'||kind==='switcher')expect(value).toEqual([expect.objectContaining({employmentId:hired.employmentId})]);
  else if(kind==='counts'||kind==='page'||kind==='personnel')expect(value).toMatchObject({total:1});
  else if(kind==='record')expect(value).toMatchObject({employment:{employmentId:hired.employmentId}});
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

it('lets an admitted record finish while revocation is uncommitted, then rejects a new read after commit',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b),entered=barrier(),release=barrier();
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional protected record',primaryEmail:'protected-record@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const writer=owner.client.begin(async tx=>{
  await tx`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
  await tx`update app_user set archived_at=now() where id=${b.adminUserId}::uuid`;
  entered.resolve();await release.promise;
 });
 try{
  await bounded(entered.promise);
  expect(await bounded(workforceRecord(ctx,hired.employmentId))).toMatchObject({employment:{employmentId:hired.employmentId}});
  release.resolve();await writer;
  expect(await workforceRecord(ctx,hired.employmentId)).toBeNull();
  expect(await searchWorkforceEmployees(ctx,[b.companyId],'Fictional protected record')).toEqual([]);
  expect(await workforceCompanies(ctx)).toEqual([]);
  expect(await listEmployeesPage(ctx,{companyIds:[b.companyId],limit:25,offset:0},'workforce')).toEqual({rows:[],total:0});
 }finally{
  release.resolve();await Promise.allSettled([writer]);
  await owner.client`update app_user set archived_at=null where id=${b.adminUserId}::uuid`;
 }
});

it('keeps permission and fields on one snapshot across a committed data change and login revocation',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional snapshot before',primaryEmail:'snapshot@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 try{
  await withPersonnelRead(ctx,async tx=>{
   const [state]=await tx.execute<{isolation:string;read_only:string}>(sql`select current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as read_only`);
   expect(state).toEqual({isolation:'repeatable read',read_only:'on'});
   const read=async()=>{const [row]=await tx.execute<{record:{profile:{fullName:string}}|null}>(sql`select app.access_workforce_record(${hired.employmentId}::uuid) as record`);return row.record;};
   expect(await read()).toMatchObject({profile:{fullName:'Fictional snapshot before'}});
   await owner.client.begin(async writer=>{
    await writer`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
    await writer`update person set full_name='Fictional snapshot after' where id=${hired.personId}::uuid`;
    await writer`update app_user set archived_at=now() where id=${b.adminUserId}::uuid`;
   });
   expect(await read()).toMatchObject({profile:{fullName:'Fictional snapshot before'}});
  });
  expect(await workforceRecord(ctx,hired.employmentId)).toBeNull();
 }finally{await owner.client`update app_user set archived_at=null where id=${b.adminUserId}::uuid`;}
 expect(await workforceRecord(ctx,hired.employmentId)).toMatchObject({profile:{fullName:'Fictional snapshot after'}});
});

it('enforces read-only on standalone Personnel callbacks instead of trusting caller discipline',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 let caught:unknown;
 try {await withPersonnelRead(ctx,tx=>tx.execute(sql`update person set full_name=full_name where false`));} catch(error){caught=error;}
 const codes:string[]=[];
 for(let cause=caught;cause instanceof Error;cause=cause.cause){
  if('code' in cause)codes.push(String(cause.code));
  if(cause.cause===cause)break;
 }
 expect(codes).toContain('25006');
});
