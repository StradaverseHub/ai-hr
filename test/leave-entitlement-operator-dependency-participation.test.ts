/** Authored UNRUN: actual maintained CLI source owners on isolated fictional tenants. No CLI/env
 * bypass, no service/process handling, no inferred universal writer or deployment proof. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {createDb,withTenant} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {lockLeaveDependenciesTx} from '../packs/leave/service';
import {backfillCountryModules} from '../scripts/backfill-country-modules';
import {reconcileEntitlementParityTenant,type EntitlementParityTenantOptions} from '../scripts/reconcile-entitlement-parity';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
const url=process.env.TEST_MIGRATION_DATABASE_URL!;
/** The CLI owns/ends its client. createDb caches by exact URL, so NEVER hand it the reusable
 * harness-owner URL. A distinct application_name retains the SAME physical DB/owner credentials
 * while making each real CLI invocation own a separate pool, just as a separate CLI process does. */
function operatorUrl(){const dedicated=new URL(url);dedicated.searchParams.set('application_name','fictional-entitlement-operator-'+randomUUID());return dedicated.toString();}
function backfill(){return backfillCountryModules(operatorUrl());}
async function parity(input:EntitlementParityTenantOptions){const dedicated=createDb(operatorUrl());try{return await dedicated.db.transaction(tx=>reconcileEntitlementParityTenant(tx,b.tenantId,input));}finally{await dedicated.client.end();}}

beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
async function subject(){return hireEmployee(adminCtx(b),{person:{fullName:'Fictional Operator Subject',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});}
async function state(){return{modules:await owner.db.select().from(s.tenantModule).where(eq(s.tenantModule.tenantId,b.tenantId)).orderBy(s.tenantModule.id),settings:await owner.db.select().from(s.tenantSetting).where(eq(s.tenantSetting.tenantId,b.tenantId)).orderBy(s.tenantSetting.key),events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id)};}
async function held(employee:string,work:()=>Promise<void>){let ready!:()=>void,fail!:(e:unknown)=>void,release!:()=>void;const start=new Promise<void>((yes,no)=>{ready=yes;fail=no;}),finish=new Promise<void>(yes=>{release=yes;});const timer=setTimeout(()=>{fail(Error('entitlement operator interval timeout'));release();},10000);const holder=withTenant(adminCtx(b),async tx=>{await lockLeaveDependenciesTx(tx,b.tenantId,[employee]);ready();await finish;});void holder.catch(fail);try{await start;await work();}finally{release();clearTimeout(timer);await holder;}}
const options=(apply=true):EntitlementParityTenantOptions=>({apply,modules:['notifications'],settings:[{key:'payroll.reset_enabled',value:true}],createdBeforeAt:new Date('2100-01-01T00:00:00Z')});
describe('maintained entitlement operator ownership',()=>{
 it('country backfill refuses before grants while an actual employee interval is held, then grants exactly once',async()=>{
  const employee=await subject(),before=await state();await held(employee.employmentId,async()=>{await expect(backfill()).rejects.toThrow('Tenant catalogs are busy or unavailable');expect(await state()).toEqual(before);});
  expect((await backfill()).granted).toBe(1);const after=await state();expect(after.modules.filter(row=>row.moduleCode==='country-my')).toHaveLength(1);expect((await backfill()).granted).toBe(0);expect(await state()).toEqual(after);
 });
 it('parity refuses whole tenant without effects, then publishes its original module/setting decisions after release',async()=>{
  const employee=await subject(),before=await state();await held(employee.employmentId,async()=>{await expect(parity(options())).rejects.toThrow('Tenant catalogs are busy or unavailable');expect(await state()).toEqual(before);});
  const result=await parity(options());expect(result).toMatchObject({moduleGrants:1,settingGrants:1,outOfScope:0});const after=await state();expect(after.modules.some(row=>row.moduleCode==='notifications'&&row.status==='active')).toBe(true);expect(after.settings.find(row=>row.key==='payroll.reset_enabled')?.value).toBe(true);expect((await parity(options())).moduleGrants).toBe(0);expect(await state()).toEqual(after);
 });
 it('dry-run remains nonadmitting and preserves post-flip and deliberate disabled/false rows',async()=>{
  const employee=await subject(),before=await state();await held(employee.employmentId,async()=>{expect((await parity(options(false))).moduleGrants).toBe(1);});expect(await state()).toEqual(before);
  expect((await parity({...options(),createdBeforeAt:new Date('1900-01-01T00:00:00Z')})).outOfScope).toBe(1);expect(await state()).toEqual(before);
  await owner.db.insert(s.tenantModule).values({tenantId:b.tenantId,moduleCode:'notifications',companyId:b.companyId,status:'disabled'});await owner.db.insert(s.tenantSetting).values({tenantId:b.tenantId,key:'payroll.reset_enabled',value:false,source:'platform'});const deliberate=await state();const result=await parity(options());expect(result).toMatchObject({moduleGrants:0,settingGrants:0,skipped:1});expect(await state()).toEqual(deliberate);
 });
 it('retains the apply boundary and actual physical-owner requirement without app impersonation',async()=>{
  const before=await state();await expect(parity({...options(),createdBeforeAt:null})).rejects.toThrow('A valid flip boundary is required');await expect(withTenant(adminCtx(b),tx=>reconcileEntitlementParityTenant(tx,b.tenantId,options()))).rejects.toThrow('Tenant catalogs are busy or unavailable');expect(await state()).toEqual(before);
 });
 it('rolls back an earlier module insert when a later same-tenant setting insert fails',async()=>{
  const before=await state();await owner.db.execute(sql.raw(`create function public.aip_parity_refuse_setting() returns trigger language plpgsql as $$begin if NEW.tenant_id='${b.tenantId}'::uuid and NEW.key='payroll.reset_enabled' then raise exception 'fictional parity failure';end if;return NEW;end$$`));await owner.db.execute(sql`create trigger aip_parity_refuse_setting before insert on public.tenant_setting for each row execute function public.aip_parity_refuse_setting()`);
  try{await expect(parity(options())).rejects.toThrow();expect(await state()).toEqual(before);}finally{await owner.db.execute(sql`drop trigger aip_parity_refuse_setting on public.tenant_setting`);await owner.db.execute(sql`drop function public.aip_parity_refuse_setting()`);}
 });
});
