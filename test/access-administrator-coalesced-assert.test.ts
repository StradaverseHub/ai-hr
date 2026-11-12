/**
 * Last-administrator rule asserted once per transaction (draft migration 5080). Real PostgreSQL through the
 * repository harness: real transactions on separate connections, the real row triggers, the real administrator guard.
 *
 * Counting, never timing. This file installs one observer trigger on the private queue table through the owner
 * connection. Every assertion the coalesced path runs is one queue row: the row triggers insert it (counter
 * `queued`) and the run deletes it immediately before it asserts (counter `ran`). Both counters are sequences,
 * which a rollback never rewinds, so a refused transaction is counted too.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql as dsql} from 'drizzle-orm';
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import {withTenant} from '../db/client';
import {appUser,employment,person,roleAssignment} from '../db/schema';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {hireEmployee} from '../core/org';
import {revokeRole} from '../core/admin';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';

const barrier=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const pgError=(reason:unknown)=>{
 let current=reason as {code?:unknown;message?:unknown;cause?:unknown}|undefined;
 for(let depth=0;current&&depth<6;depth++){if(typeof current.code==='string')return {code:current.code,message:String(current.message)};current=current.cause as typeof current;}
 return undefined;
};
const LAST_ADMINISTRATOR={code:'23514',message:'access last administrator'};

const probe=`admin_assert_probe_${randomUUID().replace(/-/g,'').slice(0,12)}`;
let b:Base;
let raw:postgres.Sql;
beforeAll(async()=>{
 await migrateTestDb();
 raw=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:8,onnotice:()=>{}});
 await raw.unsafe(`
  create schema ${probe};
  create sequence ${probe}.queued;
  create sequence ${probe}.ran;
  create function ${probe}.observe() returns trigger language plpgsql as $f$
  begin
   if tg_op='INSERT' then perform nextval('${probe}.queued'); else perform nextval('${probe}.ran'); end if;
   return null;
  end $f$;
  grant usage on schema ${probe} to public;
  grant usage on all sequences in schema ${probe} to public;
  create trigger ${probe} after insert or delete on app.access_administrator_assert_pending
   for each row execute function ${probe}.observe();
 `);
});
beforeEach(async()=>{await resetDb();b=await seedBase();});
// Dropping the schema drops the observer function and, with it, the trigger on the queue table.
afterAll(async()=>{await raw.unsafe(`drop schema if exists ${probe} cascade`);await raw.end({timeout:5});await closeAll();});

/** Owner connection acting inside the tenant, the way the deferred recovery check expects. */
const asTenant=(tx:postgres.TransactionSql,tenantId:string)=>tx.unsafe(`select set_config('app.tenant_id','${tenantId}',true)`);
/** The shared Access lock as an ordinary writer takes it. The employment row trigger then takes the administrator guard. */
const asWriter=async(tx:postgres.TransactionSql)=>{await asTenant(tx,b.tenantId);await tx.unsafe(`select app.access_workforce_write_lock()`);};
const admin=()=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
const yesterday=()=>{const d=new Date(`${todayInKualaLumpur()}T00:00:00Z`);d.setUTCDate(d.getUTCDate()-1);return d.toISOString().slice(0,10);};
const idList=(ids:string[])=>ids.map(id=>`'${id}'`).join(',');
/** Ending an employment yesterday blocks its person's login: an administrator stops being usable. */
const endEmployments=(tx:postgres.TransactionSql,ids:string[])=>tx.unsafe(`update employment set terminated_on='${yesterday()}' where id in (${idList(ids)})`);
const restoreEmployment=(tx:postgres.TransactionSql,id:string)=>tx.unsafe(`update employment set terminated_on=null where id='${id}'`);

type Counters={queued:number;ran:number;pending:number};
const counters=async():Promise<Counters>=>{
 const [row]=await raw.unsafe(`select
  (select case when is_called then last_value else 0 end from ${probe}.queued)::int as queued,
  (select case when is_called then last_value else 0 end from ${probe}.ran)::int as ran,
  (select count(*) from app.access_administrator_assert_pending)::int as pending`);
 return {queued:Number(row.queued),ran:Number(row.ran),pending:Number(row.pending)};
};
/** Runs one transaction and reports how many assertions it queued and ran, and what it left in the queue. */
async function observed(work:()=>Promise<unknown>){
 const before=await counters();
 const outcome=await work().then(()=>({status:'committed' as const,error:undefined}),(reason:unknown)=>({status:'refused' as const,error:pgError(reason)??{code:'unknown',message:String(reason)}}));
 const after=await counters();
 return {outcome,assertions:{queued:after.queued-before.queued,ran:after.ran-before.ran,pending:after.pending}};
}
const guardEpoch=async()=>{const [row]=await owner.db.execute<{epoch:string}>(dsql`select epoch::text from app.access_administrator_guard where tenant_id=${b.tenantId}::uuid`);return Number(row.epoch);};

/** Two real administrators whose logins depend on the employments being ended; the seeded administrator is revoked. */
async function twoAdministrators(){
 await withTenant(admin(),tx=>accessConfigurationStore.loadCurrent(tx,admin()));
 const today=todayInKualaLumpur();
 const people:{employmentId:string;personId:string;userId:string}[]=[];
 for(const label of ['one','two']){
  const hired=await hireEmployee(admin(),{person:{fullName:`Fictional administrator ${label}`,primaryEmail:`fictional-admin-${label}-${randomUUID()}@example.invalid`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:today});
  const userId=await createAppUser(b.tenantId,hired.personId,'hr_admin');
  people.push({employmentId:hired.employmentId,personId:hired.personId,userId});
 }
 const [grant]=await owner.db.select({id:roleAssignment.id}).from(roleAssignment).where(dsql`${roleAssignment.tenantId}=${b.tenantId}::uuid and ${roleAssignment.appUserId}=${b.adminUserId}::uuid and ${roleAssignment.role}='hr_admin'`);
 await revokeRole(admin(),{roleAssignmentId:grant.id});
 return people;
}
/** Administrators whose employment is not ended. */
const usableAdministrators=async()=>(await owner.db.select({id:roleAssignment.id}).from(roleAssignment).innerJoin(appUser,eq(appUser.id,roleAssignment.appUserId)).innerJoin(employment,eq(employment.personId,appUser.personId)).where(dsql`${roleAssignment.tenantId}=${b.tenantId}::uuid and ${roleAssignment.role}='hr_admin' and ${employment.terminatedOn} is null`)).length;
const newPerson=async(label:string)=>{const [row]=await owner.db.insert(person).values({tenantId:b.tenantId,fullName:`Fictional ${label}`,primaryEmail:`${label}-${randomUUID()}@example.invalid`}).returning({id:person.id});return row.id;};
const newEmployment=async(personId:string)=>{const [row]=await owner.db.insert(employment).values({tenantId:b.tenantId,personId,companyId:b.companyId,employeeCode:`CA-${randomUUID().slice(0,8)}`,hiredOn:todayInKualaLumpur()}).returning({id:employment.id});return row.id;};
/** Ordinary employees who can sign in: each employment write touches a login, so each reaches the assertion path. */
async function staffWithLogins(count:number){
 const ids:string[]=[];
 for(let index=0;index<count;index++){
  const personId=await newPerson(`staff-${index+1}`);
  ids.push(await newEmployment(personId));
  await createAppUser(b.tenantId,personId,'employee');
 }
 return ids;
}
const endedAmong=async(ids:string[])=>{const [row]=await raw.unsafe(`select count(*)::int as n from employment where terminated_on is not null and id in (${idList(ids)})`);return Number(row.n);};

describe('two concurrent removals of different administrators',()=>{
 /** Each transaction ends one administrator's employment under the shared Access lock; the row trigger takes the guard. */
 async function race(isolation:'read committed'|'repeatable read'){
  const [one,two]=await twoAdministrators();
  const firstHeld=barrier(),releaseFirst=barrier();
  const first=raw.begin(`isolation level ${isolation}`,async tx=>{
   await asWriter(tx);await endEmployments(tx,[one.employmentId]);firstHeld.resolve();await releaseFirst.promise;
  });
  await firstHeld.promise;
  const second=raw.begin(`isolation level ${isolation}`,async tx=>{
   await asWriter(tx);
   if(isolation==='repeatable read')await tx.unsafe(`select count(*) from role_assignment`);
   await endEmployments(tx,[two.employmentId]);
  });
  await pause(250);releaseFirst.resolve();
  const results=await Promise.allSettled([first,second]);
  return results.map(result=>result.status==='fulfilled'?'committed':pgError(result.reason));
 }
 it('commits exactly one under READ COMMITTED and refuses the other with the last-administrator error',async()=>{
  expect(await race('read committed')).toEqual(['committed',LAST_ADMINISTRATOR]);
  expect(await usableAdministrators()).toBe(1);
  expect((await counters()).pending).toBe(0);
 },30000);
 it('still fails the second removal on the guard row under REPEATABLE READ',async()=>{
  const outcome=await race('repeatable read');
  expect(outcome[0]).toBe('committed');
  expect(outcome[1]).toMatchObject({code:'40001'});
  expect(await usableAdministrators()).toBe(1);
 },30000);
});

describe('one assertion for many rows',()=>{
 it('asserts once, not twenty times, for a transaction that writes twenty employments of people with logins',async()=>{
  await twoAdministrators();
  const staff=await staffWithLogins(20);
  const epochBefore=await guardEpoch();
  const result=await observed(()=>raw.begin(async tx=>{
   await asWriter(tx);
   for(const id of staff)await endEmployments(tx,[id]);
  }));
  expect(result.outcome).toEqual({status:'committed',error:undefined});
  // Twenty login-bearing rows were written (each took the administrator guard), and they shared one assertion.
  expect(await guardEpoch()-epochBefore).toBe(20);
  expect(result.assertions).toEqual({queued:1,ran:1,pending:0});
  expect(await endedAmong(staff)).toBe(20);
  expect(await usableAdministrators()).toBe(2);
 },60000);
 it('refuses, after that one assertion, when the same writes remove the last administrators',async()=>{
  const [one,two]=await twoAdministrators();
  const staff=await staffWithLogins(20);
  // The administrators sit in the middle and at the end of one twenty-two-row statement.
  const rows=[...staff.slice(0,10),one.employmentId,...staff.slice(10),two.employmentId];
  const result=await observed(()=>raw.begin(async tx=>{await asWriter(tx);await endEmployments(tx,rows);}));
  expect(result.outcome).toEqual({status:'refused',error:LAST_ADMINISTRATOR});
  expect(result.assertions).toEqual({queued:1,ran:1,pending:0});
  expect(await endedAmong(rows)).toBe(0);
  expect(await usableAdministrators()).toBe(2);
 },60000);
});

describe('the assertion sees the final state of the transaction',()=>{
 /** `two` is already ended, so `one` is the last usable administrator. */
 async function lastAdministrator(){
  const [one,two]=await twoAdministrators();
  await raw.begin(async tx=>{await asWriter(tx);await endEmployments(tx,[two.employmentId]);});
  expect(await usableAdministrators()).toBe(1);
  return {one,two};
 }
 it('commits a transaction that removes the last administrator and restores one before commit',async()=>{
  const {one,two}=await lastAdministrator();
  const result=await observed(()=>raw.begin(async tx=>{
   await asWriter(tx);
   await endEmployments(tx,[one.employmentId]);
   await restoreEmployment(tx,two.employmentId);
  }));
  expect(result.outcome).toEqual({status:'committed',error:undefined});
  expect(result.assertions).toEqual({queued:1,ran:1,pending:0});
  expect(await endedAmong([one.employmentId])).toBe(1);
  expect(await endedAmong([two.employmentId])).toBe(0);
  expect(await usableAdministrators()).toBe(1);
 },30000);
 it('refuses a transaction that restores an administrator and then removes the last ones',async()=>{
  const {one,two}=await lastAdministrator();
  const result=await observed(()=>raw.begin(async tx=>{
   await asWriter(tx);
   await restoreEmployment(tx,two.employmentId);
   await endEmployments(tx,[two.employmentId]);
   await endEmployments(tx,[one.employmentId]);
  }));
  expect(result.outcome).toEqual({status:'refused',error:LAST_ADMINISTRATOR});
  expect(result.assertions).toEqual({queued:1,ran:1,pending:0});
  expect(await endedAmong([one.employmentId])).toBe(0);
  expect(await usableAdministrators()).toBe(1);
 },30000);
 it('still refuses at the statement once the transaction has made its constraints immediate',async()=>{
  const [one,two]=await twoAdministrators();
  let reached='nothing';
  const result=await observed(()=>raw.begin(async tx=>{
   await asWriter(tx);
   await endEmployments(tx,[one.employmentId,two.employmentId]);
   reached='removed';
   await tx.unsafe(`set constraints all immediate`);
   reached='past the check';
  }));
  expect(reached).toBe('removed');
  expect(result.outcome).toEqual({status:'refused',error:LAST_ADMINISTRATOR});
  expect(await usableAdministrators()).toBe(2);
 },30000);
});

describe('transactions that owe no assertion',()=>{
 it('runs none for a transaction that touches no login-bearing employment and no role or account row',async()=>{
  await twoAdministrators();
  const hired=await newPerson('no-login-hire');
  const existing=await newEmployment(await newPerson('no-login-leaver'));
  const epochBefore=await guardEpoch();
  const result=await observed(()=>raw.begin(async tx=>{
   await asWriter(tx);
   await tx.unsafe(`insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) values('${b.tenantId}','${hired}','${b.companyId}','CA-${randomUUID().slice(0,8)}','${todayInKualaLumpur()}')`);
   await endEmployments(tx,[existing]);
  }));
  expect(result.outcome).toEqual({status:'committed',error:undefined});
  expect(result.assertions).toEqual({queued:0,ran:0,pending:0});
  expect(await guardEpoch()).toBe(epochBefore);
  expect(await endedAmong([existing])).toBe(1);
 },30000);
 it('keeps the owner session as it was: no tenant in session, no assertion',async()=>{
  const [one,two]=await twoAdministrators();
  const result=await observed(()=>raw.begin(async tx=>{await endEmployments(tx,[one.employmentId,two.employmentId]);}));
  expect(result.outcome).toEqual({status:'committed',error:undefined});
  expect(result.assertions).toEqual({queued:0,ran:0,pending:0});
  expect(await usableAdministrators()).toBe(0);
 },30000);
});

describe('the assertion queue is private',()=>{
 it('has row security, no policy, and nothing the application role can read, write or call',async()=>{
  const [facts]=await raw.unsafe(`select
   (select relrowsecurity from pg_class where oid='app.access_administrator_assert_pending'::regclass) as rls,
   (select count(*) from pg_policies where schemaname='app' and tablename='access_administrator_assert_pending')::int as policies,
   has_table_privilege('ai_hr_app','app.access_administrator_assert_pending','select') as can_read,
   has_table_privilege('ai_hr_app','app.access_administrator_assert_pending','insert') as can_insert,
   has_table_privilege('ai_hr_app','app.access_administrator_assert_pending','delete') as can_delete,
   has_function_privilege('ai_hr_app','app.access_administrator_assert_run()','execute') as can_run,
   has_function_privilege('ai_hr_app','app.access_administrator_constraint()','execute') as can_queue,
   (select count(*) from pg_trigger where tgfoid='app.access_administrator_constraint()'::regprocedure and tgdeferrable and tginitdeferred
     and tgrelid in ('public.role_assignment'::regclass,'public.app_user'::regclass,'public.employment'::regclass))::int as row_triggers`);
  expect(facts).toEqual({rls:true,policies:0,can_read:false,can_insert:false,can_delete:false,can_run:false,can_queue:false,row_triggers:3});
 });
});
