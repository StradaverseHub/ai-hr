/** Authored UNRUN. Actual app-role setting/event writes and two-connection Access interleavings.
 * No model, provider, runtime evaluation or module-activation proof is inferred from these cases.
 */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import * as schema from '../db/schema';
import {setTenantSetting,TenantSettingError} from '../core/tenant-settings';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();base=await seedBase();});afterAll(closeAll);
const state=async()=>({settings:await owner.db.select().from(schema.tenantSetting).where(eq(schema.tenantSetting.tenantId,base.tenantId)).orderBy(schema.tenantSetting.key),events:await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId,base.tenantId)).orderBy(schema.domainEvent.id)});
async function heldAccess(){
 let ready!:()=>void,failed!:(error:unknown)=>void,release!:()=>void;
 const started=new Promise<void>((yes,no)=>{ready=yes;failed=no;}),finish=new Promise<void>(yes=>{release=yes;});
 const watchdog=setTimeout(()=>{failed(Error('owned setting Access handshake timed out'));release();},10000);
 const holder=withTenant(adminCtx(base),async tx=>{await lockAccessConfigurationTx(tx,base.tenantId);ready();await finish;});void holder.catch(failed);
 await started;return{async close(){release();clearTimeout(watchdog);await holder;}};
}
async function waitActualAccessWait(failed:()=>unknown){
 const deadline=Date.now()+4000;let waiting=false;
 while(Date.now()<deadline){
  if(failed())throw failed();
  const [row]=await owner.db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_locks l
   where l.locktype='advisory' and not l.granted and l.objsubid=1
    and l.database=(select oid from pg_database where datname=current_database())
    and ((l.classid::bigint << 32) | l.objid::bigint)=hashtextextended(${'access-configuration:'+base.tenantId},0)) as waiting`);
  if(row?.waiting){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,20));
 }
 expect(waiting,'observe the actual canonical setting writer waiting on Access').toBe(true);
}
describe('current actual authority for tenant settings',()=>{
 it.each(['claims.input_triage_enabled','performance.ai_pm_enabled','ess.profile_photo_edit'])('refuses revoked group authority before %s changes or events',async key=>{
  const ctx=adminCtx(base),before=await state();
  await owner.db.delete(schema.roleAssignment).where(and(eq(schema.roleAssignment.tenantId,base.tenantId),eq(schema.roleAssignment.appUserId,base.adminUserId)));
  await expect(setTenantSetting(ctx,{key,value:true})).rejects.toMatchObject({reason:'not_group_admin'});
  expect(await state()).toEqual(before);
 });
 it('refuses a blocked actual login or mismatched actual person despite retained admin claims',async()=>{
  const ctx=adminCtx(base),before=await state();
  await expect(setTenantSetting({...ctx,personId:randomUUID()},{key:'claims.input_triage_enabled',value:true})).rejects.toBeInstanceOf(TenantSettingError);
  await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,base.adminUserId));
  await expect(setTenantSetting(ctx,{key:'claims.input_triage_enabled',value:true})).rejects.toBeInstanceOf(TenantSettingError);
  expect(await state()).toEqual(before);
 });
 it('captures nested values, key and actor before an actual held Access interval',async()=>{
  const ctx=adminCtx(base),input={key:'ess.profile_change_fields',value:['primaryEmail']},before=await state(),holder=await heldAccess();
  let failure:unknown;const writing=setTenantSetting(ctx,input);void writing.catch(error=>{failure=error;});
  try{
   await waitActualAccessWait(()=>failure);expect(await state()).toEqual(before);
   input.key='claims.input_triage_enabled';input.value.push('bankName');ctx.userId=randomUUID();ctx.roles!.splice(0,ctx.roles!.length,'employee');
  }finally{await holder.close();await writing;}
  const after=await state(),saved=after.settings.find(row=>row.key==='ess.profile_change_fields');
  expect(saved?.value).toEqual(['primaryEmail']);expect(saved?.source).toBe('customer');
  expect(after.events).toHaveLength(before.events.length+1);
  expect(after.events.at(-1)).toMatchObject({actorId:base.adminUserId,eventType:'tenant-setting.changed',payload:{key:'ess.profile_change_fields',value:['primaryEmail']}});
  expect(after.settings.find(row=>row.key==='claims.input_triage_enabled')).toEqual(before.settings.find(row=>row.key==='claims.input_triage_enabled'));
 });
 it('freshly refuses an administrator revoked while the actual writer is waiting, with no setting/event effect',async()=>{
  const ctx=adminCtx(base),before=await state(),holder=await heldAccess();let failure:unknown;
  const writing=setTenantSetting(ctx,{key:'performance.ai_pm_enabled',value:false});void writing.catch(error=>{failure=error;});
  try{
   await waitActualAccessWait(()=>failure);expect(await state()).toEqual(before);
   await owner.db.delete(schema.roleAssignment).where(and(eq(schema.roleAssignment.tenantId,base.tenantId),eq(schema.roleAssignment.appUserId,base.adminUserId)));
  }finally{await holder.close();}
  await expect(writing).rejects.toMatchObject({reason:'not_group_admin'});expect(await state()).toEqual(before);
 });
 it('joins an already Access-owned caller transaction and rolls setting/event back with that caller',async()=>{
  const ctx=adminCtx(base),before=await state();
  await expect(withTenant(ctx,async tx=>{
   await lockAccessConfigurationTx(tx,base.tenantId);
   await setTenantSetting(ctx,{key:'claims.input_triage_enabled',value:true},tx);
   const [stored]=await tx.select().from(schema.tenantSetting).where(eq(schema.tenantSetting.key,'claims.input_triage_enabled'));
   expect(stored?.value).toBe(true);throw Error('fixture caller rollback');
  })).rejects.toThrow('fixture caller rollback');
  expect(await state()).toEqual(before);
  await setTenantSetting(ctx,{key:'claims.input_triage_enabled',value:true});
  const after=await state();expect(after.settings.find(row=>row.key==='claims.input_triage_enabled')?.value).toBe(true);
  expect(after.events).toHaveLength(before.events.length+1);
 });
});
