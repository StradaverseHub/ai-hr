/** Maintained repair roots, authored UNRUN. Calls import-safe owners on fictional isolated data,
 * never their CLI/report-file path, never production fixtures, and never erases ledger history. */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as s from '../db/schema';
import { hireEmployee } from '../core/org';
import { lockLeaveDependenciesTx, INELIGIBLE_GRANT_REVERSAL_REASON } from '../packs/leave/service';
import { runIneligibleGrantRepair } from '../scripts/reverse-ineligible-leave-grants';
import { runDuplicateReplacementArchive } from '../scripts/archive-duplicate-replacement-leave-type';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b:Base;const url=process.env.TEST_MIGRATION_DATABASE_URL!;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
async function subject(base=b){return hireEmployee(adminCtx(base),{person:{fullName:'Fictional Operator Repair Subject',primaryEmail:randomUUID()+'@fixture.test',gender:'male'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});}
async function grant(base=b){const employee=await subject(base);await owner.db.update(s.leaveType).set({eligibility:{gender:'female'}}).where(eq(s.leaveType.id,base.annualLeaveTypeId));await owner.db.insert(s.leaveLedger).values({tenantId:base.tenantId,employmentId:employee.employmentId,leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'5',effectiveOn:'2026-01-01'});return employee;}
async function duplicate(){const [keep]=await owner.db.insert(s.leaveType).values({tenantId:b.tenantId,code:'RL',name:'Fictional role owner',country:'MY',role:'replacement',paid:true}).returning({id:s.leaveType.id});const [extra]=await owner.db.insert(s.leaveType).values({tenantId:b.tenantId,code:'REPLACEMENT',name:'Fictional empty duplicate',country:'MY',paid:true}).returning({id:s.leaveType.id});return{keep:keep.id,extra:extra.id};}
async function state(base=b){return{
 types:await owner.db.select().from(s.leaveType).where(eq(s.leaveType.tenantId,base.tenantId)).orderBy(s.leaveType.id),
 ledger:await owner.db.select().from(s.leaveLedger).where(eq(s.leaveLedger.tenantId,base.tenantId)).orderBy(s.leaveLedger.id),
 events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,base.tenantId)).orderBy(s.domainEvent.id),
};}
async function held(base:Base,employee:string,work:()=>Promise<void>){let ready!:()=>void,fail!:(e:unknown)=>void,release!:()=>void;const start=new Promise<void>((yes,no)=>{ready=yes;fail=no;}),finish=new Promise<void>(yes=>{release=yes;});const timer=setTimeout(()=>{fail(Error('operator repair interval timed out'));release();},10000);const holder=withTenant(adminCtx(base),async tx=>{await lockLeaveDependenciesTx(tx,base.tenantId,[employee]);ready();await finish;});void holder.catch(fail);try{await start;await work();}finally{release();clearTimeout(timer);await holder;}}
describe('maintained operator repair source owners',()=>{
 it('refuses grant compensation during an actual interval, then reverses exactly once with the original net guards',async()=>{
  const employee=await grant(),before=await state();await held(b,employee.employmentId,async()=>{await expect(runIneligibleGrantRepair(url,{apply:true})).rejects.toThrow('Tenant catalogs are busy or unavailable');expect(await state()).toEqual(before);});
  expect((await runIneligibleGrantRepair(url,{apply:true})).reversed).toBe(1);const after=await state();expect(after.ledger.filter(row=>row.reason===INELIGIBLE_GRANT_REVERSAL_REASON).map(row=>row.days)).toEqual(['-5.00']);
  expect((await runIneligibleGrantRepair(url,{apply:true})).skippedAlready).toBe(1);expect(await state()).toEqual(after);
 });
 it('keeps earlier ordered tenant commits when a later tenant is busy and safely resumes only the unfinished tenant',async()=>{
  const other=await seedBase(),bases=[b,other].sort((a,z)=>a.tenantId<z.tenantId?-1:1),employees=new Map<string,string>();for(const base of bases)employees.set(base.tenantId,(await grant(base)).employmentId);
  const beforeLast=await state(bases[1]);await held(bases[1],employees.get(bases[1].tenantId)!,async()=>{await expect(runIneligibleGrantRepair(url,{apply:true})).rejects.toThrow('Tenant catalogs are busy or unavailable');expect((await state(bases[0])).ledger.filter(row=>row.reason===INELIGIBLE_GRANT_REVERSAL_REASON)).toHaveLength(1);expect(await state(bases[1])).toEqual(beforeLast);});
  const out=await runIneligibleGrantRepair(url,{apply:true});expect(out.reversed).toBe(1);expect(out.skippedAlready).toBe(1);for(const base of bases)expect((await state(base)).ledger.filter(row=>row.reason===INELIGIBLE_GRANT_REVERSAL_REASON)).toHaveLength(1);
 });
 it('rolls back the entire current tenant if a later compensation insert fails',async()=>{
  await grant();await grant();const before=await state();
  // Controlled fixture UUID only. The second same-transaction compensation observes the first and
  // throws, proving the first row cannot leak out of a failed current-tenant owner transaction.
  await owner.db.execute(sql.raw(`create function public.aip_repair_second_refuse() returns trigger language plpgsql as $$begin if NEW.tenant_id='${b.tenantId}'::uuid and NEW.reason='sys:ineligible_grant_reversal' and exists(select 1 from public.leave_ledger l where l.tenant_id=NEW.tenant_id and l.reason=NEW.reason) then raise exception 'fictional second compensation failure';end if;return NEW;end$$`));
  await owner.db.execute(sql`create trigger aip_repair_second_refuse before insert on public.leave_ledger for each row execute function public.aip_repair_second_refuse()`);
  try{await expect(runIneligibleGrantRepair(url,{apply:true})).rejects.toThrow();expect(await state()).toEqual(before);}finally{await owner.db.execute(sql`drop trigger aip_repair_second_refuse on public.leave_ledger`);await owner.db.execute(sql`drop function public.aip_repair_second_refuse()`);}
 });
 it('refuses duplicate archive during a real interval, then archives only the empty duplicate and keeps the role owner',async()=>{
  const employee=await subject(),ids=await duplicate(),before=await state();await held(b,employee.employmentId,async()=>{await expect(runDuplicateReplacementArchive(url,{apply:true,tenantId:b.tenantId})).rejects.toThrow('Tenant catalogs are busy or unavailable');expect(await state()).toEqual(before);});
  expect((await runDuplicateReplacementArchive(url,{apply:true,tenantId:b.tenantId})).archived).toBe(1);const after=await state();expect(after.types.find(row=>row.id===ids.keep)?.archivedAt).toBeNull();expect(after.types.find(row=>row.id===ids.extra)?.archivedAt).not.toBeNull();expect(after.ledger).toEqual(before.ledger);
 });
 it('retains the in-use archive refusal and explicit apply tenant requirement',async()=>{
  const employee=await subject(),ids=await duplicate();await owner.db.insert(s.leaveLedger).values({tenantId:b.tenantId,employmentId:employee.employmentId,leaveTypeId:ids.extra,entryType:'accrual',days:'2',effectiveOn:'2026-01-01'});const before=await state();
  expect((await runDuplicateReplacementArchive(url,{apply:true,tenantId:b.tenantId})).skipped).toBe(1);expect(await state()).toEqual(before);await expect(runDuplicateReplacementArchive(url,{apply:true})).rejects.toThrow('An explicit tenant is required');
 });
 it('keeps both dry runs nonadmitting while an employee interval is held',async()=>{
  const employee=await grant();await duplicate();const before=await state();await held(b,employee.employmentId,async()=>{expect((await runIneligibleGrantRepair(url,{apply:false})).reversed).toBe(1);expect((await runDuplicateReplacementArchive(url,{apply:false,tenantId:b.tenantId})).archived).toBe(0);});expect(await state()).toEqual(before);
 });
});
