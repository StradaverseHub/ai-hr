/** The movement Revert rehearsal's capture table (migration 5079) against a defect that commits with capture on:
 * row security shows the application role only its own tenant's rows written by its own transaction, and a commit that
 * still holds a capture row is refused. Real PostgreSQL; fictional fixtures. */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base;let employmentId:string;
const division=async()=>(await owner.db.select({d:s.employment.orgDivision}).from(s.employment).where(eq(s.employment.id,employmentId)))[0].d;
const captured=async()=>Number((await owner.client<{n:number}[]>`select count(*)::int n from app.movement_revert_capture`)[0].n);

describe('movement revert capture isolation',()=>{
 beforeAll(migrateTestDb);
 afterAll(closeAll);
 beforeEach(async()=>{
  await resetDb();b=await seedBase();
  employmentId=(await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Capture Employee',primaryEmail:`capture-${randomUUID().slice(0,8)}@example.test`},companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:todayInKualaLumpur(),employeeCode:'CAP001'})).employmentId;
 });

 it('is under row security, readable by the application role only, and its guard is a deferred constraint trigger',async()=>{
  const [table]=await owner.client<{rls:boolean;acl:string}[]>`select relrowsecurity rls,relacl::text acl from pg_class where oid='app.movement_revert_capture'::regclass`;
  expect(table.rls).toBe(true);
  expect(table.acl).toMatch(/ai_hr_app=r\//);expect(table.acl).not.toMatch(/(^|[{,])=/);
  const [guard]=await owner.client<{deferrable:boolean;deferred:boolean}[]>`select tgdeferrable deferrable,tginitdeferred deferred from pg_trigger where tgrelid='app.movement_revert_capture'::regclass and tgname='movement_revert_capture_never_commits'`;
  expect(guard).toEqual({deferrable:true,deferred:true});
 });

 it('shows the application role its own transaction\'s rows of its own tenant, and nothing of another tenant',async()=>{
  await owner.client.begin(async tx=>{
   await tx`select set_config('app.movement_revert_capture','on',true)`;
   await tx`update employment set org_division='Fictional capture division' where id=${employmentId}::uuid`;
   await tx`select set_config('app.movement_revert_capture','off',true)`;
   await tx`set local role ai_hr_app`;
   await tx`select set_config('app.tenant_id',${b.tenantId},true)`;
   const own=await tx<{table_name:string;row_id:string}[]>`select table_name,row_id::text from app.movement_revert_capture`;
   expect(own).toEqual([{table_name:'employment',row_id:employmentId}]);
   // The same transaction, another tenant: nothing.
   await tx`select set_config('app.tenant_id',${randomUUID()},true)`;
   expect(await tx`select 1 from app.movement_revert_capture`).toHaveLength(0);
   await tx`select set_config('app.tenant_id','',true)`;
   expect(await tx`select 1 from app.movement_revert_capture`).toHaveLength(0);
   await tx`reset role`;
   // Rolled back, as the rehearsal's savepoint always is.
   throw new Error('rollback');
  }).catch(error=>{if((error as Error).message!=='rollback')throw error;});
  expect(await captured()).toBe(0);
 });

 it('hides committed rows from every other transaction, whichever tenant they belong to',async()=>{
  // Simulate the defect the guard below exists for: rows of two tenants that did commit.
  const other=randomUUID();
  await owner.client`alter table app.movement_revert_capture disable trigger movement_revert_capture_never_commits`;
  try{
   await owner.client`insert into app.movement_revert_capture(tenant_id,table_name,op,row_id,old_row,new_row)
    values(${b.tenantId}::uuid,'compensation','UPDATE',${randomUUID()}::uuid,'{"basic_salary":"3000.00"}'::jsonb,'{"basic_salary":"9000.00"}'::jsonb),
     (${other}::uuid,'compensation','UPDATE',${randomUUID()}::uuid,'{"basic_salary":"4000.00"}'::jsonb,'{"basic_salary":"8000.00"}'::jsonb)`;
   expect(await captured()).toBe(2);
   for(const tenant of [b.tenantId,other]){
    const seen=await owner.client.begin(async tx=>{
     await tx`set local role ai_hr_app`;await tx`select set_config('app.tenant_id',${tenant},true)`;
     // With and without a transaction id of its own.
     const before=await tx`select tenant_id from app.movement_revert_capture`;
     await tx`select pg_current_xact_id()`;
     return[...before,...await tx`select tenant_id from app.movement_revert_capture`];
    });
    expect(seen,tenant).toEqual([]);
   }
   // The application role cannot write or remove capture rows itself.
   await expect(owner.client.begin(async tx=>{await tx`set local role ai_hr_app`;await tx`delete from app.movement_revert_capture`;})).rejects.toMatchObject({code:'42501'});
   await expect(owner.client.begin(async tx=>{await tx`set local role ai_hr_app`;await tx`insert into app.movement_revert_capture(tenant_id,table_name,op,row_id) values(${b.tenantId}::uuid,'employment','UPDATE',${employmentId}::uuid)`;})).rejects.toMatchObject({code:'42501'});
  }finally{
   await owner.client`delete from app.movement_revert_capture`;
   await owner.client`alter table app.movement_revert_capture enable trigger movement_revert_capture_never_commits`;
  }
 });

 it('refuses to commit a transaction that still holds a capture row, and lets a rolled-back savepoint\'s rows go',async()=>{
  const before=await division();
  // A defect: capture switched on outside the rehearsal's savepoint, and the transaction commits.
  await expect(owner.client.begin(async tx=>{
   await tx`select set_config('app.movement_revert_capture','on',true)`;
   await tx`update employment set org_division='Fictional leaked division' where id=${employmentId}::uuid`;
  })).rejects.toMatchObject({code:'55000',message:expect.stringContaining('movement_revert_capture rows must not be committed')});
  expect(await division()).toBe(before);
  expect(await captured()).toBe(0);
  // The rehearsal's shape: capture inside a savepoint that rolls back; the outer transaction commits its own work.
  await owner.client.begin(async tx=>{
   await tx.savepoint(async sp=>{
    await sp`select set_config('app.movement_revert_capture','on',true)`;
    await sp`update employment set org_division='Fictional rehearsed division' where id=${employmentId}::uuid`;
    expect(await sp`select 1 from app.movement_revert_capture`).toHaveLength(1);
    throw new Error('rehearsal');
   }).catch(error=>{if((error as Error).message!=='rehearsal')throw error;});
   await tx`select set_config('app.movement_revert_capture','off',true)`;
   await tx`update employment set org_division='Fictional committed division' where id=${employmentId}::uuid`;
  });
  expect(await division()).toBe('Fictional committed division');
  expect(await captured()).toBe(0);
 });
});
