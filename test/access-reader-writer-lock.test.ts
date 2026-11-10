/**
 * Reader/writer Access lock, central wave. Real PostgreSQL through the repository harness.
 *
 * These are concurrency facts, so each case holds real transactions open on separate connections and
 * observes what PostgreSQL actually grants. No mocks: the lock modes, the row guard and the deferred
 * recovery check are the things being tested.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql as dsql} from 'drizzle-orm';
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import {withTenant} from '../db/client';
import {appUser,employment,person,roleAssignment} from '../db/schema';
import {lockAccessAdministratorSetTx,lockAccessConfigurationReadTx,lockAccessConfigurationTx,lockAccessConfigurationWriteTx,tryLockAccessConfigurationTx} from '../core/access-configuration-lock';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {hireEmployee} from '../core/org';
import {revokeRole} from '../core/admin';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';

const barrier=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const lockKey=(tenantId:string)=>`hashtextextended('access-configuration:${tenantId}',0)`;
async function settled<T>(promise:Promise<T>,ms=4000):Promise<'timeout'|{value:T}>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise.then(value=>({value})),new Promise<'timeout'>(resolve=>{timer=setTimeout(()=>resolve('timeout'),ms);})]);}
 finally{if(timer)clearTimeout(timer);}
}
const sqlState=(reason:unknown)=>{
 let current=reason as {code?:unknown;cause?:unknown}|undefined;
 for(let depth=0;current&&depth<6;depth++){if(typeof current.code==='string')return current.code;current=current.cause as typeof current;}
 return undefined;
};

let b:Base;
let raw:postgres.Sql;
beforeAll(async()=>{await migrateTestDb();raw=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:56,onnotice:()=>{}});});
beforeEach(async()=>{await resetDb();b=await seedBase();});
afterAll(async()=>{await raw.end({timeout:5});await closeAll();});

/** Owner connection acting inside the tenant, the way the deferred recovery check expects. */
const asTenant=(tx:postgres.TransactionSql,tenantId:string,strict=false)=>tx.unsafe(`select set_config('app.tenant_id','${tenantId}',true)${strict?`,set_config('app.access_lock_strict','on',true)`:''}`);
const admin=()=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});

describe('E1: reader/writer fairness on the Access key',()=>{
 it('overlaps readers, queues the editor behind them, and queues later readers behind the editor',async()=>{
  const key=lockKey(b.tenantId),held=barrier(),release=barrier();
  const holder=raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock_shared(${key})`);held.resolve();await release.promise;});
  await held.promise;
  await expect(settled(raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock_shared(${key})`);}))).resolves.not.toBe('timeout');
  const order:string[]=[];
  const editor=raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock(${key})`);order.push('editor');});
  await pause(200);
  const [tryShared]=await raw`select pg_try_advisory_xact_lock_shared(${raw.unsafe(key)}) ok`.catch(()=>[{ok:'unsupported'}]);
  const queued=raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock_shared(${key})`);order.push('reader-after-editor');});
  await pause(200);
  expect(order).toEqual([]);
  expect(tryShared).toBeDefined();
  release.resolve();await holder;await editor;await queued;
  expect(order).toEqual(['editor','reader-after-editor']);
 },20000);
 it('holds an editor out while any writer has the shared lock through the real SQL barrier',async()=>{
  const entered=barrier(),release=barrier();
  const writer=withTenant(adminCtx(b),async tx=>{await lockAccessConfigurationTx(tx,b.tenantId);entered.resolve();await release.promise;});
  await entered.promise;
  const editorTook=raw.begin(async tx=>{const [row]=await tx.unsafe(`select pg_try_advisory_xact_lock(${lockKey(b.tenantId)}) acquired`);return row.acquired;});
  expect(await editorTook).toBe(false);
  const blocking=withTenant(adminCtx(b),async tx=>{await lockAccessConfigurationWriteTx(tx,b.tenantId);return 'editor-done';});
  expect(await settled(blocking,300)).toBe('timeout');
  release.resolve();await writer;
  await expect(blocking).resolves.toBe('editor-done');
 },20000);
 it('lets two ordinary writers overlap through the public TypeScript API',async()=>{
  const entered=[barrier(),barrier()],release=barrier();
  const writers=entered.map(entry=>withTenant(adminCtx(b),async tx=>{await lockAccessConfigurationTx(tx,b.tenantId);entry.resolve();await release.promise;}));
  await expect(settled(Promise.all(entered.map(entry=>entry.promise)))).resolves.not.toBe('timeout');
  release.resolve();await Promise.all(writers);
 });
 it('reports the mode a session holds',async()=>{
  await withTenant(adminCtx(b),async tx=>{
   await lockAccessConfigurationReadTx(tx,b.tenantId);
   const [shared]=await tx.execute<{mode:string}>(dsql`select app.access_lock_mode_held(${b.tenantId}::uuid) as mode`);expect(shared.mode).toBe('S');
  });
  await withTenant(adminCtx(b),async tx=>{
   await lockAccessConfigurationWriteTx(tx,b.tenantId);
   const [exclusive]=await tx.execute<{mode:string}>(dsql`select app.access_lock_mode_held(${b.tenantId}::uuid) as mode`);expect(exclusive.mode).toBe('X');
  });
  await withTenant(adminCtx(b),async tx=>{
   expect(await tryLockAccessConfigurationTx(tx,b.tenantId)).toBe(true);
  });
 });
});

describe('workforce barrier SQL',()=>{
 it('takes the shared lock in access_workforce_write_lock and the exclusive lock in access_configuration_write_lock',async()=>{
  const ctx=adminCtx(b);
  await withTenant(ctx,async tx=>{
   await tx.execute(dsql`select app.access_workforce_write_lock()`);
   const [row]=await tx.execute<{mode:string}>(dsql`select app.access_lock_mode_held(${b.tenantId}::uuid) as mode`);expect(row.mode).toBe('S');
  });
  await withTenant(ctx,async tx=>{
   await tx.execute(dsql`select app.access_configuration_write_lock()`);
   const [row]=await tx.execute<{mode:string}>(dsql`select app.access_lock_mode_held(${b.tenantId}::uuid) as mode`);expect(row.mode).toBe('X');
  });
 });
 it('still refuses an access configuration editor while workforce writers hold the barrier',async()=>{
  const entered=barrier(),release=barrier();
  const writer=withTenant(adminCtx(b),async tx=>{await tx.execute(dsql`select app.access_workforce_write_lock()`);entered.resolve();await release.promise;});
  await entered.promise;
  const blocked=await raw.begin(async tx=>{const [row]=await tx.unsafe(`select pg_try_advisory_xact_lock(${lockKey(b.tenantId)}) acquired`);return row.acquired;});
  expect(blocked).toBe(false);
  release.resolve();await writer;
 });
});

describe('editor against many writers',()=>{
 it('serialises one exclusive editor against 50 concurrent shared writers with no deadlock and no overlap',async()=>{
  const key=lockKey(b.tenantId);
  const intervals:{kind:'S'|'X';at:number;end:number}[]=[];
  const started=barrier();let begun=0;const total=50;
  const writers=Array.from({length:total},async(_,index)=>raw.begin(async tx=>{
   await tx.unsafe(`select pg_advisory_xact_lock_shared(${key})`);
   const at=Date.now();
   if(++begun===25)started.resolve();
   await tx.unsafe(`select pg_sleep(${0.01+(index%5)*0.01})`);
   intervals.push({kind:'S',at,end:Date.now()});
  }));
  await started.promise;
  const editor=raw.begin(async tx=>{
   await tx.unsafe(`select pg_advisory_xact_lock(${key})`);
   const at=Date.now();
   await tx.unsafe(`select pg_sleep(0.05)`);
   intervals.push({kind:'X',at,end:Date.now()});
  });
  await Promise.all([...writers,editor]);
  expect(intervals.filter(interval=>interval.kind==='S')).toHaveLength(total);
  const exclusive=intervals.find(interval=>interval.kind==='X')!;
  for(const reader of intervals.filter(interval=>interval.kind==='S'))
   expect(reader.end<=exclusive.at+5||reader.at>=exclusive.end-5).toBe(true);
 },60000);
});

describe('legacy employment writers under the shared barrier',()=>{
 const newPerson=async(label:string)=>{const [row]=await owner.db.insert(person).values({tenantId:b.tenantId,fullName:`Fictional ${label}`,primaryEmail:`${label}-${randomUUID()}@example.invalid`}).returning({id:person.id});return row.id;};
 const employmentValues=(personId:string,code:string)=>({personId,code});
 const insertEmployment=(tx:postgres.TransactionSql,row:{personId:string;code:string})=>tx.unsafe(`insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) values('${b.tenantId}','${row.personId}','${b.companyId}','${row.code}','${todayInKualaLumpur()}')`);
 it('lets two concurrent hires hold the barrier and insert without a FOR SHARE to UPDATE deadlock',async()=>{
  const [p1,p2]=await Promise.all([newPerson('a'),newPerson('b')]);
  await owner.db.execute(dsql`update access_configuration set initialized=true where tenant_id=${b.tenantId}::uuid`);
  const entered=[barrier(),barrier()],go=barrier();
  const hires=[p1,p2].map((personId,index)=>raw.begin(async tx=>{
   await asTenant(tx,b.tenantId);
   await tx.unsafe(`select app.access_workforce_write_lock()`);
   entered[index].resolve();await go.promise;
   await insertEmployment(tx,employmentValues(personId,`RW-${index}-${randomUUID().slice(0,8)}`));
  }));
  await Promise.all(entered.map(entry=>entry.promise));
  go.resolve();
  const results=await settled(Promise.allSettled(hires),15000);
  expect(results).not.toBe('timeout');
  const outcomes=(results as {value:PromiseSettledResult<unknown>[]}).value;
  expect(outcomes.map(outcome=>outcome.status==='rejected'?sqlState(outcome.reason):'ok')).toEqual(['ok','ok']);
 },30000);
 it('does not advance the shared revision for a hire without a login',async()=>{
  const personId=await newPerson('no-login');
  await owner.db.execute(dsql`update access_configuration set initialized=true where tenant_id=${b.tenantId}::uuid`);
  const [before]=await owner.db.execute<{revision:string;epoch:string}>(dsql`select c.revision,g.epoch::text from access_configuration c join app.access_administrator_guard g on g.tenant_id=c.tenant_id where c.tenant_id=${b.tenantId}::uuid`);
  await raw.begin(async tx=>{await asTenant(tx,b.tenantId);await insertEmployment(tx,employmentValues(personId,`RW-${randomUUID().slice(0,8)}`));});
  const [after]=await owner.db.execute<{revision:string;epoch:string}>(dsql`select c.revision,g.epoch::text from access_configuration c join app.access_administrator_guard g on g.tenant_id=c.tenant_id where c.tenant_id=${b.tenantId}::uuid`);
  expect(after).toEqual(before);
 });
 it('takes the administrator guard for a person with a login, without advancing the revision under the shared lock',async()=>{
  const personId=await newPerson('with-login');
  await createAppUser(b.tenantId,personId,'employee');
  await owner.db.execute(dsql`update access_configuration set initialized=true where tenant_id=${b.tenantId}::uuid`);
  const [before]=await owner.db.execute<{revision:string;epoch:string}>(dsql`select c.revision,g.epoch::text from access_configuration c join app.access_administrator_guard g on g.tenant_id=c.tenant_id where c.tenant_id=${b.tenantId}::uuid`);
  await raw.begin(async tx=>{await asTenant(tx,b.tenantId);await insertEmployment(tx,employmentValues(personId,`RW-${randomUUID().slice(0,8)}`));});
  const [after]=await owner.db.execute<{revision:string;epoch:string}>(dsql`select c.revision,g.epoch::text from access_configuration c join app.access_administrator_guard g on g.tenant_id=c.tenant_id where c.tenant_id=${b.tenantId}::uuid`);
  expect(after.revision).toBe(before.revision);
  expect(Number(after.epoch)).toBe(Number(before.epoch)+1);
 });
});

describe('E2: last administrator under the shared lock',()=>{
 /** Two real administrators whose logins depend on the employments being ended. */
 async function twoAdministrators(){
  await withTenant(admin(),tx=>accessConfigurationStore.loadCurrent(tx,admin()));
  const today=todayInKualaLumpur();
  // One after the other: this fixture is not the concurrency under test.
  const people:{employmentId:string;personId:string;userId:string}[]=[];
  for(const label of ['one','two']){
   const hired=await hireEmployee(admin(),{person:{fullName:`Fictional administrator ${label}`,primaryEmail:`fictional-admin-${label}-${randomUUID()}@example.invalid`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:today});
   const userId=await createAppUser(b.tenantId,hired.personId,'hr_admin');
   people.push({employmentId:hired.employmentId,personId:hired.personId,userId});
  }
  // Only these two remain administrators.
  const [grant]=await owner.db.select({id:roleAssignment.id}).from(roleAssignment).where(dsql`${roleAssignment.tenantId}=${b.tenantId}::uuid and ${roleAssignment.appUserId}=${b.adminUserId}::uuid and ${roleAssignment.role}='hr_admin'`);
  await revokeRole(admin(),{roleAssignmentId:grant.id});
  return people;
 }
 const yesterday=()=>{const d=new Date(`${todayInKualaLumpur()}T00:00:00Z`);d.setUTCDate(d.getUTCDate()-1);return d.toISOString().slice(0,10);};
 const endEmployment=(tx:postgres.TransactionSql,employmentId:string)=>tx.unsafe(`update employment set terminated_on='${yesterday()}' where id='${employmentId}'`);
 const admins=async()=>(await owner.db.select({id:roleAssignment.id,user:roleAssignment.appUserId}).from(roleAssignment).innerJoin(appUser,eq(appUser.id,roleAssignment.appUserId)).innerJoin(employment,eq(employment.personId,appUser.personId)).where(dsql`${roleAssignment.tenantId}=${b.tenantId}::uuid and ${roleAssignment.role}='hr_admin' and ${employment.terminatedOn} is null`)).length;

 async function race(isolation:'read committed'|'repeatable read'){
  const [one,two]=await twoAdministrators();
  {
   const firstHeld=barrier(),releaseFirst=barrier();
   const first=raw.begin(`isolation level ${isolation}`,async tx=>{
    await asTenant(tx,b.tenantId);await tx.unsafe(`select app.access_workforce_write_lock()`);
    await endEmployment(tx,one.employmentId);firstHeld.resolve();await releaseFirst.promise;
   });
   await firstHeld.promise;
   const second=raw.begin(`isolation level ${isolation}`,async tx=>{
    await asTenant(tx,b.tenantId);await tx.unsafe(`select app.access_workforce_write_lock()`);
    if(isolation==='repeatable read')await tx.unsafe(`select count(*) from role_assignment`);
    await endEmployment(tx,two.employmentId);
   });
   await pause(250);releaseFirst.resolve();
   const results=await Promise.allSettled([first,second]);
   return results.map(result=>result.status==='fulfilled'?'committed':sqlState(result.reason));
  }
 }
 it('E2b: under READ COMMITTED the second removal is refused by the recovery check',async()=>{
  expect(await race('read committed')).toEqual(['committed','23514']);
  expect(await admins()).toBe(1);
 },30000);
 it('E2c: under REPEATABLE READ the second removal fails serialization',async()=>{
  expect(await race('repeatable read')).toEqual(['committed','40001']);
  expect(await admins()).toBe(1);
 },30000);
 it('exposes the guard through the service helper',async()=>{
  const [before]=await owner.db.execute<{epoch:string}>(dsql`select epoch::text from app.access_administrator_guard where tenant_id=${b.tenantId}::uuid`);
  await withTenant(adminCtx(b),tx=>lockAccessAdministratorSetTx(tx,b.tenantId));
  const [after]=await owner.db.execute<{epoch:string}>(dsql`select epoch::text from app.access_administrator_guard where tenant_id=${b.tenantId}::uuid`);
  expect(Number(after.epoch)).toBe(Number(before.epoch)+1);
 });
});

describe('E2 model: why the administrator guard exists',()=>{
 const schema=`e2_model_${randomUUID().replace(/-/g,'').slice(0,12)}`;
 beforeAll(async()=>{await raw.unsafe(`
  create schema ${schema};
  create table ${schema}.admin_member(tenant int,user_id int,active boolean not null default true,primary key(tenant,user_id));
  create table ${schema}.admin_guard(tenant int primary key,epoch bigint not null default 0);
  create function ${schema}.assert_admin() returns trigger language plpgsql as $f$
  begin
   if not exists(select 1 from ${schema}.admin_member where tenant=coalesce(new.tenant,old.tenant) and active) then
    raise exception 'access last administrator' using errcode='23514';
   end if;
   return null;
  end $f$;
  create constraint trigger admin_assert after insert or update or delete on ${schema}.admin_member deferrable initially deferred for each row execute function ${schema}.assert_admin();
  insert into ${schema}.admin_guard values(1);
 `);});
 afterAll(async()=>{await raw.unsafe(`drop schema if exists ${schema} cascade`);});
 const reset=()=>raw.unsafe(`delete from ${schema}.admin_member;insert into ${schema}.admin_member values(1,1,true),(1,2,true)`);
 const removal=(tx:postgres.TransactionSql,user:number,guard:boolean)=>tx.unsafe(`${guard?`update ${schema}.admin_guard set epoch=epoch+1 where tenant=1;`:''}update ${schema}.admin_member set active=false where tenant=1 and user_id=${user}`);
 const left=async()=>{const [row]=await raw.unsafe(`select count(*)::int n from ${schema}.admin_member where active`);return row.n as number;};
 async function modelRace(guard:boolean,isolation:'read committed'|'repeatable read'){
  await reset();
  const firstDone=barrier(),releaseFirst=barrier();
  // Without the guard the write skew needs both recovery checks to run before either commit, so the control
  // runs them explicitly. With the guard the second removal waits on the guard row, so a commit is enough.
  const first=raw.begin(`isolation level ${isolation}`,async tx=>{await removal(tx,1,guard);if(!guard)await tx.unsafe('set constraints all immediate');firstDone.resolve();await releaseFirst.promise;});
  await firstDone.promise;
  const second=raw.begin(`isolation level ${isolation}`,async tx=>{if(isolation==='repeatable read')await tx.unsafe(`select count(*) from ${schema}.admin_member`);await removal(tx,2,guard);if(!guard){await tx.unsafe('set constraints all immediate');releaseFirst.resolve();}});
  if(guard){await pause(250);releaseFirst.resolve();}
  return (await Promise.allSettled([first,second])).map(result=>result.status==='fulfilled'?'committed':sqlState(result.reason));
 }
 it('without the guard both removals commit and no administrator remains',async()=>{
  expect(await modelRace(false,'read committed')).toEqual(['committed','committed']);expect(await left()).toBe(0);
 });
 it('with the guard row the second removal is refused under READ COMMITTED',async()=>{
  expect(await modelRace(true,'read committed')).toEqual(['committed','23514']);expect(await left()).toBe(1);
 });
 it('with the guard row the second removal fails serialization under REPEATABLE READ',async()=>{
  expect(await modelRace(true,'repeatable read')).toEqual(['committed','40001']);expect(await left()).toBe(1);
 });
});

describe('authority writers never block in a trigger',()=>{
 const insertRole=(tx:postgres.TransactionSql,userId:string)=>tx.unsafe(`insert into role_assignment(tenant_id,app_user_id,role,company_id) values('${b.tenantId}','${userId}','manager',null)`);
 it('refuses at once when a shared holder blocks the exclusive try, instead of waiting',async()=>{
  const entered=barrier(),release=barrier();
  const reader=raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock_shared(${lockKey(b.tenantId)})`);entered.resolve();await release.promise;});
  await entered.promise;
  const started=Date.now();
  await expect(raw.begin(async tx=>{await insertRole(tx,b.adminUserId);})).rejects.toMatchObject({code:'55P03'});
  expect(Date.now()-started).toBeLessThan(2000);
  release.resolve();await reader;
 });
 it('passes once the caller already holds the exclusive lock',async()=>{
  await raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock(${lockKey(b.tenantId)})`);await insertRole(tx,b.adminUserId);});
 });
});

describe('strict lock mode',()=>{
 const insertRole=(tx:postgres.TransactionSql,userId:string)=>tx.unsafe(`insert into role_assignment(tenant_id,app_user_id,role,company_id) values('${b.tenantId}','${userId}','manager',null)`);
 it('catches a site that writes an authority row without the exclusive lock, even with no contention',async()=>{
  await expect(raw.begin(async tx=>{await asTenant(tx,b.tenantId,true);await insertRole(tx,b.adminUserId);})).rejects.toMatchObject({code:'AL001'});
 });
 it('catches a site that holds only the shared lock before an authority write',async()=>{
  await expect(raw.begin(async tx=>{await asTenant(tx,b.tenantId,true);await tx.unsafe(`select pg_advisory_xact_lock_shared(${lockKey(b.tenantId)})`);await insertRole(tx,b.adminUserId);})).rejects.toMatchObject({code:'AL001'});
 });
 it('accepts the same write when the exclusive lock was taken first',async()=>{
  await raw.begin(async tx=>{await asTenant(tx,b.tenantId,true);await tx.unsafe(`select pg_advisory_xact_lock(${lockKey(b.tenantId)})`);await insertRole(tx,b.adminUserId);});
 });
 it('accepts an employment write under the statement-level shared lock',async()=>{
  const [row]=await owner.db.insert(person).values({tenantId:b.tenantId,fullName:'Fictional strict hire',primaryEmail:`strict-${randomUUID()}@example.invalid`}).returning({id:person.id});
  await raw.begin(async tx=>{await asTenant(tx,b.tenantId,true);await tx.unsafe(`insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) values('${b.tenantId}','${row.id}','${b.companyId}','STRICT-${randomUUID().slice(0,8)}','${todayInKualaLumpur()}')`);});
 });
 it('is off unless the session opts in',async()=>{
  await raw.begin(async tx=>{await asTenant(tx,b.tenantId);await insertRole(tx,b.adminUserId);});
 });
});
