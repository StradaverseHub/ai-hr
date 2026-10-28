/** Real profile setting owners and actual Access lock interleavings; no model/provider.
 * Failed event/interleaving fixture repairs are source-only and await their targeted rerun. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as schema from '../db/schema';
import {saveProfileEditPolicy,saveProfileVisibilityPolicy,saveOwnPhotoSubmissionSetting,readProfilePresentationPolicy} from '../core/profile-edit-policy';
import {saveProfileRoutingPolicy} from '../core/profile-routing';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {hireEmployee} from '../core/org';
import {essVisibleFields} from '../lib/personnel-ess-contract';
import {EMPTY_PROFILE_ROUTING,PROFILE_ROUTING_KEY,type ProfileRouteRule} from '../lib/profile-routing-policy';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base;
// seedBase installs this actual group-wide assignment; flattened roles alone are not group authority.
const groupCtx=():SessionContext=>({...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]});
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();base=await seedBase();
 const [authority]=await withTenant(groupCtx(),tx=>tx.execute<{allowed:boolean}>(sql`select app.is_group_admin() as allowed`));
 expect(authority?.allowed).toBe(true);
});afterAll(closeAll);
const state=async()=>({settings:await owner.db.select().from(schema.tenantSetting).where(eq(schema.tenantSetting.tenantId,base.tenantId)).orderBy(schema.tenantSetting.key),requests:await owner.db.select().from(schema.profileChangeRequest).where(eq(schema.profileChangeRequest.tenantId,base.tenantId)).orderBy(schema.profileChangeRequest.id),events:await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId,base.tenantId)).orderBy(schema.domainEvent.id)});
const policy=()=>({version:3 as const,fields:Object.fromEntries(essVisibleFields().map(field=>[field.id,'viewOnly' as 'viewOnly'|'editable'|'hide'])),primaryOnly:[] as string[]});
function command(kind:'edit'|'visibility'|'photo'|'routing',ctx:SessionContext){
 if(kind==='edit'){
  const input={keys:['profile.personal_details.firstname'],withdrawnReason:'Fictional policy update'};
  return{run:()=>saveProfileEditPolicy(ctx,input),mutate:()=>{input.keys.push('profile.personal_details.lastname');input.withdrawnReason='retargeted';},key:'ess.profile_change_fields',expected:{version:2,fields:['profile.personal_details.firstname']}};
 }
 if(kind==='visibility'){
  const input={policy:policy(),withdrawnReason:'Fictional visibility update'},expected=structuredClone(input.policy);
  return{run:()=>saveProfileVisibilityPolicy(ctx,input),mutate:()=>{input.policy.fields['profile.personal_details.firstname']='hide';input.policy.primaryOnly.push('profile.personal_details.firstname');},key:'ess.profile_change_fields',expected};
 }
 if(kind==='photo'){
  const input={enabled:false,withdrawnReason:'Fictional photo update'};
  return{run:()=>saveOwnPhotoSubmissionSetting(ctx,input),mutate:()=>{input.enabled=true;input.withdrawnReason='retargeted';},key:'ess.profile_photo_edit',expected:false};
 }
 const input={expectedRevision:EMPTY_PROFILE_ROUTING.revision,enabled:false,rules:[] as ProfileRouteRule[]};
 return{run:()=>saveProfileRoutingPolicy(ctx,input),mutate:()=>{input.enabled=true;input.expectedRevision=randomUUID();input.rules.push({id:randomUUID(),name:'Retargeted',approverEmploymentId:randomUUID(),employmentIds:[],criteria:{companyIds:[randomUUID()]}});},key:PROFILE_ROUTING_KEY,expected:{version:1,enabled:false,rules:[]}};
}
async function heldAccess(revokeWithinOwnedTransaction=false){
 let ready!:()=>void,failed!:(error:unknown)=>void,release!:()=>void;
 const started=new Promise<void>((yes,no)=>{ready=yes;failed=no;}),finish=new Promise<void>(yes=>{release=yes;});
 const watchdog=setTimeout(()=>{failed(Error('owned profile policy handshake timed out'));release();},10000);
 let revokeActualAuthority:()=>Promise<void>=async()=>{throw Error('Revocation requires the owned owner transaction');};
 const hold=async(tx:Tx)=>{
  await lockAccessConfigurationTx(tx,base.tenantId);
  if(revokeWithinOwnedTransaction)revokeActualAuthority=async()=>{
   // role_assignment is the actual app.principal owner. Its BEFORE DELETE trigger joins Access;
   // perform this fixture revocation in the SAME owned holder transaction, never a blocked peer.
   await tx.delete(schema.roleAssignment).where(and(eq(schema.roleAssignment.tenantId,base.tenantId),eq(schema.roleAssignment.appUserId,base.adminUserId)));
   const principal=await tx.execute<{grants:unknown}>(sql`select grants from app.principal(${base.adminUserId}::uuid) where tenant_id=${base.tenantId}::uuid`);
   expect(principal).toHaveLength(1);expect(principal[0].grants).toEqual([]);
  };
  ready();await finish;
 };
 // Owner connection is fixture authority only, without a synthetic application actor or role GUC.
 const holder=revokeWithinOwnedTransaction?owner.db.transaction(tx=>hold(tx as unknown as Tx)):withTenant(groupCtx(),hold);
 void holder.catch(failed);
 await started;return{revokeActualAuthority:()=>revokeActualAuthority(),async close(){release();clearTimeout(watchdog);await holder;}};
}
async function observeWait(failed:()=>unknown){
 const deadline=Date.now()+4000;let waiting=false;
 while(Date.now()<deadline){if(failed())throw failed();const [row]=await owner.db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_locks l
  where l.locktype='advisory' and not l.granted and l.objsubid=1 and l.database=(select oid from pg_database where datname=current_database())
   and ((l.classid::bigint << 32) | l.objid::bigint)=hashtextextended(${'access-configuration:'+base.tenantId},0)) as waiting`);
  if(row?.waiting){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
 expect(waiting,'actual administrative policy owner must wait for Access before its policy lock').toBe(true);
}
describe('fresh calling authority before administrative profile-policy facts',()=>{
 it.each(['edit','visibility','photo','routing'] as const)('%s refuses revoked actual group authority without policy/request/event changes',async kind=>{
  const ctx=groupCtx(),operation=command(kind,ctx),before=await state();
  await owner.db.delete(schema.roleAssignment).where(and(eq(schema.roleAssignment.tenantId,base.tenantId),eq(schema.roleAssignment.appUserId,base.adminUserId)));
  await expect(operation.run()).rejects.toMatchObject(kind==='routing'?{code:'unauthorized'}:{reason:'not_group_admin'});
  expect(await state()).toEqual(before);
 });
 it.each(['edit','visibility','photo','routing'] as const)('%s owns Access before effect and does not retarget retained nested inputs or actor',async kind=>{
  const ctx=groupCtx(),operation=command(kind,ctx),before=await state(),holder=await heldAccess();let failure:unknown;
  const writing=operation.run();void writing.catch(error=>{failure=error;});
  try{await observeWait(()=>failure);expect(await state()).toEqual(before);operation.mutate();ctx.userId=randomUUID();ctx.roles!.splice(0,ctx.roles!.length,'employee');}
  finally{await holder.close();await writing;}
  const after=await state(),saved=after.settings.find(row=>row.key===operation.key);
  if(typeof operation.expected==='boolean')expect(saved?.value).toBe(operation.expected);else expect(saved?.value).toMatchObject(operation.expected);
  expect(after.requests).toEqual(before.requests);expect(after.events).toHaveLength(before.events.length+1);
  const previousIds=new Set(before.events.map(event=>event.id)),created=after.events.filter(event=>!previousIds.has(event.id));
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({actorId:base.adminUserId,eventType:'tenant-setting.changed',payload:{key:operation.key,value:operation.expected}});
 });
 it('refuses authority revoked while waiting, before touching profile policy or withdrawing requests',async()=>{
  const ctx=groupCtx(),operation=command('visibility',ctx),before=await state(),holder=await heldAccess(true);let failure:unknown;
  const writing=operation.run();void writing.catch(error=>{failure=error;});
  try{await observeWait(()=>failure);await holder.revokeActualAuthority();}
  finally{await holder.close();}
  await expect(writing).rejects.toMatchObject({reason:'not_group_admin'});expect(await state()).toEqual(before);
 });
 it('does not add a group-admin requirement to ordinary employee profile presentation reads',async()=>{
  const hired=await hireEmployee(groupCtx(),{person:{fullName:'Fictional Profile Reader',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  const userId=await createAppUser(base.tenantId,hired.personId,'employee');
  const ctx:SessionContext={...groupCtx(),userId,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  const result=await readProfilePresentationPolicy(ctx);expect(result.ctx.userId).toBe(userId);expect(result.visible.size).toBeGreaterThan(0);
 });
});
