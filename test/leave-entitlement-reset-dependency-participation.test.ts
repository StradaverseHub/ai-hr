/** Maintained owner reset roots, authored UNRUN. Uses only fictional isolated test data; does not
 * execute the CLI, delete canonical requests/debits, weaken refusals or run a destructive demo seed. */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as s from '../db/schema';
import { hireEmployee } from '../core/org';
import { createEligibilityRule, createEntitlementTemplate } from '../core/entitlement-template';
import { lockLeaveDependenciesTx } from '../packs/leave/service';
import { runEntitlementReset, type ResetOptions, type Stage } from '../scripts/reset-entitlement-configuration';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b: Base;
const url=process.env.TEST_MIGRATION_DATABASE_URL!;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
async function fixture(){
  const subject=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Entitlement Reset Subject',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  const template=await createEntitlementTemplate(adminCtx(b),{leaveTypeId:b.annualLeaveTypeId,name:'Fictional Annual Table',serviceBands:[{fromYears:0,toYears:null,days:14}],validFrom:'2020-01-01'});
  await createEligibilityRule(adminCtx(b),{name:'Fictional everyone',templateLineageId:template.lineageId,criteria:{},validFrom:'2020-01-01'});
  await owner.db.insert(s.leaveLedger).values([
    {tenantId:b.tenantId,employmentId:subject.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'5',effectiveOn:'2026-01-01',reason:'Fictional accrual'},
    {tenantId:b.tenantId,employmentId:subject.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'adjustment',days:'7',effectiveOn:'2026-01-01',reason:'Fictional human adjustment'},
  ]);return subject;
}
async function state(){return{
  templates:await owner.db.select().from(s.entitlementTemplate).where(eq(s.entitlementTemplate.tenantId,b.tenantId)).orderBy(s.entitlementTemplate.id),
  rules:await owner.db.select().from(s.entitlementEligibilityRule).where(eq(s.entitlementEligibilityRule.tenantId,b.tenantId)).orderBy(s.entitlementEligibilityRule.id),
  ledger:await owner.db.select().from(s.leaveLedger).where(eq(s.leaveLedger.tenantId,b.tenantId)).orderBy(s.leaveLedger.id),
  configArchive:await owner.db.select().from(s.entitlementResetArchive).where(eq(s.entitlementResetArchive.tenantId,b.tenantId)).orderBy(s.entitlementResetArchive.id),
  ledgerArchive:await owner.db.select().from(s.leaveLedgerResetArchive).where(eq(s.leaveLedgerResetArchive.tenantId,b.tenantId)).orderBy(s.leaveLedgerResetArchive.id),
  events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id),
};}
async function held(subject:string,work:()=>Promise<void>){
 let ready!:()=>void,fail!:(e:unknown)=>void,release!:()=>void;
 const start=new Promise<void>((yes,no)=>{ready=yes;fail=no;}),finish=new Promise<void>(yes=>{release=yes;});
 const timer=setTimeout(()=>{fail(Error('entitlement reset interval timed out'));release();},10000);
 const holder=withTenant(adminCtx(b),async tx=>{await lockLeaveDependenciesTx(tx,b.tenantId,[subject]);ready();await finish;});void holder.catch(fail);
 try{await start;await work();}finally{release();clearTimeout(timer);await holder;}
}
describe('maintained archive-first entitlement reset owner interval',()=>{
 it.each(['config','accruals'] as const)('%s refuses before census/archive/delete/event while a real employee interval is held, then performs the original stage',async stage=>{
  const subject=await fixture(),opts={tenantId:b.tenantId,stage,apply:true,tag:'fictional-'+randomUUID()};const before=await state();
  await held(subject.employmentId,async()=>{await expect(runEntitlementReset(url,opts)).rejects.toThrow('Tenant catalogs are busy or unavailable');expect(await state()).toEqual(before);});
  const report=await runEntitlementReset(url,opts);expect(report.refusals).toEqual([]);expect(report.archived).not.toBeNull();
  const after=await state();
  if(stage==='config'){expect(after.templates).toHaveLength(0);expect(after.rules).toHaveLength(0);expect(after.ledger).toEqual(before.ledger);expect(after.configArchive.length).toBeGreaterThan(0);}
  else{expect(after.templates).toEqual(before.templates);expect(after.rules).toEqual(before.rules);expect(after.ledger.map(row=>row.entryType)).toEqual(['adjustment']);expect(after.ledger[0].days).toBe('7.00');expect(after.ledgerArchive.length).toBeGreaterThan(0);}
 });
 it.each(['config','accruals'] as const)('%s archive failure rolls back its full admitted transaction',async stage=>{
  await fixture();const before=await state(),injected=Error('fictional archive failure');
  await expect(runEntitlementReset(url,{tenantId:b.tenantId,stage,apply:true,tag:'fictional-'+randomUUID(),testHooks:{afterArchive:async()=>{throw injected;}}})).rejects.toBe(injected);
  expect(await state()).toEqual(before);
 });
 it('keeps dry-run independent of configuration admission and without archive/delete/event effects',async()=>{
  const subject=await fixture(),before=await state();
  await held(subject.employmentId,async()=>{for(const stage of ['config','accruals'] as Stage[]){const report=await runEntitlementReset(url,{tenantId:b.tenantId,stage,apply:false,tag:'fictional-'+randomUUID()});expect(report.archived).toBeNull();expect(report.deleted).toBeNull();}});
  expect(await state()).toEqual(before);
 });
 it('takes the fresh authoritative census after an observed Access wait and keeps the captured stage/tenant/tag/hook',async()=>{
  const subject=await fixture();let ready!:(pid:number)=>void,fail!:(e:unknown)=>void,release!:()=>void;
  const start=new Promise<number>((yes,no)=>{ready=yes;fail=no;}),finish=new Promise<void>(yes=>{release=yes;});
  const timer=setTimeout(()=>{fail(Error('reset Access wait timed out'));release();},10000);
  const holder=withTenant(adminCtx(b),async tx=>{await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`);const [row]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);ready(row.pid);await finish;});void holder.catch(fail);
  let command:ReturnType<typeof runEntitlementReset>|undefined;
  try{const pid=await start,tag='fictional-'+randomUUID(),opts:ResetOptions={tenantId:b.tenantId,stage:'accruals',apply:true,tag,testHooks:{}};command=runEntitlementReset(url,opts);void command.catch(()=>undefined);
   let waiting=false;for(let i=0;i<100;i++){const [row]=await owner.db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_stat_activity a where a.datname=current_database() and a.wait_event_type='Lock' and a.wait_event='advisory' and ${pid}=any(pg_blocking_pids(a.pid))) as waiting`);if(row.waiting){waiting=true;break;}await new Promise(yes=>setTimeout(yes,10));}expect(waiting).toBe(true);
   await owner.db.insert(s.leaveLedger).values({tenantId:b.tenantId,employmentId:subject.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'2',effectiveOn:'2026-02-01',reason:'Fictional later census row'});
   opts.stage='config';opts.tenantId=randomUUID();opts.tag='retargeted';opts.testHooks!.afterArchive=async()=>{throw Error('retargeted hook must never run');};
   release();await holder;const report=await command;expect(report.stage).toBe('accruals');expect(report.tenantId).toBe(b.tenantId);expect(report.tag).toBe(tag);expect(report.totals.accrualRows).toBe(2);expect(report.deleted).toMatchObject({ledger:2});
   const after=await state();expect(after.templates).toHaveLength(1);expect(after.ledger.map(row=>row.entryType)).toEqual(['adjustment']);
  }finally{release();clearTimeout(timer);await holder;if(command)await command.catch(()=>undefined);}
 });
});
