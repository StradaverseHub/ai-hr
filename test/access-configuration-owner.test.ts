/** Orchestration unit contracts only. Real SQL locking, RLS and rollback require separate DB journeys. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext,Tx} from '../db/client';
import type {AccessCapability,AccessSnapshot,CompanyScopeEvidence} from '../lib/access-permission-model';
const observed=vi.hoisted(()=>({calls:[] as string[]}));
vi.mock('../db/client',()=>({withTenant:async(_ctx:unknown,run:(tx:unknown)=>Promise<unknown>)=>{
  observed.calls.push('transaction');return run({execute:async()=>{observed.calls.push('lock');}});
}}));
import {previewAccessConfiguration,saveAccessConfiguration,type AccessConfigurationOwner,type CurrentAccessConfiguration} from '../core/access-configuration';

const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const tenant=id(1),admin=id(2),worker=id(3),system=id(4),team=id(5),company=id(6);
const catalog:AccessCapability[]=[
 {id:'access.system_admin',scope:'tenant',supported:true,bindings:[{owner:'unit-owner',operation:'recovery'}]},
 {id:'access.configure',scope:'tenant',supported:true,bindings:[{owner:'unit-owner',operation:'configure'}]},
 {id:'workforce.view',scope:'company',supported:true,bindings:[{owner:'unit-owner',operation:'read'}]},
];
function fixture(){
 let snapshot:AccessSnapshot={tenantId:tenant,revision:'revision-one',users:[{id:admin,active:true},{id:worker,active:true}],groups:[
  {id:system,name:'System administrator',retired:false,systemAdministrator:true,grants:catalog.map(c=>({capabilityId:c.id,companyId:null}))},
  {id:team,name:'Fictional private group name',retired:false,systemAdministrator:false,grants:[{capabilityId:'workforce.view',companyId:company}]},
 ],memberships:[{userId:admin,groupId:system,companyId:null},{userId:worker,groupId:team,companyId:company}],overrides:[]};
 const evidence:CompanyScopeEvidence={tenantId:tenant,knownCompanyIds:new Set([company]),covers:()=>false};
 let scopeFingerprint='a'.repeat(64);
 const owner:AccessConfigurationOwner={
  loadCurrent:vi.fn(async(_tx:Tx,_ctx:SessionContext):Promise<CurrentAccessConfiguration>=>{
   observed.calls.push('fresh-owner');return {snapshot,catalog,evidence,scopeFingerprint};
  }),
  persist:vi.fn(async(_tx:Tx,_ctx:SessionContext,change)=>{
   observed.calls.push('persist');if(change.before.revision!==snapshot.revision)return false;snapshot=change.after;return true;
  }),
 };
 return {owner,get snapshot(){return snapshot;},set snapshot(value:AccessSnapshot){snapshot=value;},set scopeFingerprint(value:string){scopeFingerprint=value;}};
}
const ctx:SessionContext={tenantId:tenant,userId:admin,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
const edit={expectedRevision:'revision-one',command:{kind:'setOverride',userId:worker,capabilityId:'workforce.view',companyId:company,effect:'deny'}};
beforeEach(()=>{observed.calls.length=0;});

describe('one fresh locked access transition for preview and commit',()=>{
 it('previews real losses, then re-reads before the atomic storage-and-audit seam',async()=>{
  const state=fixture(),preview=await previewAccessConfiguration(ctx,edit,state.owner);
  expect(preview.changes).toMatchObject([{userId:worker,capabilityId:'workforce.view',companyId:company,before:{allowed:true},after:{allowed:false,reason:'denied'}}]);
  expect(state.owner.persist).not.toHaveBeenCalled();
  const result=await saveAccessConfiguration(ctx,{...edit,previewFingerprint:preview.fingerprint},state.owner);
  expect(result.revision).not.toBe('revision-one');expect(state.snapshot.revision).toBe(result.revision);
  expect(observed.calls).toEqual(['transaction','lock','fresh-owner','transaction','lock','fresh-owner','persist']);
  expect(state.owner.persist).toHaveBeenCalledWith(expect.anything(),ctx,expect.objectContaining({scopeFingerprint:'a'.repeat(64),command:edit.command,before:expect.objectContaining({revision:'revision-one'}),after:expect.objectContaining({revision:result.revision})}));
 });
 it('does not trust roles in an old SessionContext when the current login lost configuration authority',async()=>{
  const state=fixture(),preview=await previewAccessConfiguration(ctx,edit,state.owner);
  state.snapshot={...state.snapshot,users:state.snapshot.users.map(user=>user.id===admin?{...user,active:false}:user)};
  await expect(saveAccessConfiguration(ctx,{...edit,previewFingerprint:preview.fingerprint},state.owner)).rejects.toMatchObject({code:'ceiling'});
  expect(state.owner.persist).not.toHaveBeenCalled();
 });
 it('refuses changed organisation evidence and command substitution before any persistence call',async()=>{
  const state=fixture(),preview=await previewAccessConfiguration(ctx,edit,state.owner);
  state.scopeFingerprint='b'.repeat(64);
  await expect(saveAccessConfiguration(ctx,{...edit,previewFingerprint:preview.fingerprint},state.owner)).rejects.toMatchObject({code:'changed'});
  state.scopeFingerprint='a'.repeat(64);
  await expect(saveAccessConfiguration(ctx,{...edit,command:{...edit.command,effect:'allow'},previewFingerprint:preview.fingerprint},state.owner)).rejects.toMatchObject({code:'changed'});
  expect(state.owner.persist).not.toHaveBeenCalled();
 });
 it('refuses replay after the first save advanced the revision',async()=>{
  const state=fixture(),preview=await previewAccessConfiguration(ctx,edit,state.owner),save={...edit,previewFingerprint:preview.fingerprint};
  await saveAccessConfiguration(ctx,save,state.owner);
  await expect(saveAccessConfiguration(ctx,save,state.owner)).rejects.toMatchObject({code:'changed'});
  expect(state.owner.persist).toHaveBeenCalledTimes(1);
 });
 it('propagates a refused CAS or atomic write/audit failure without reporting a successful save',async()=>{
  const state=fixture(),preview=await previewAccessConfiguration(ctx,edit,state.owner);
  await expect(saveAccessConfiguration(ctx,{...edit,previewFingerprint:preview.fingerprint},{...state.owner,persist:vi.fn(async()=>false)})).rejects.toMatchObject({code:'changed'});
  await expect(saveAccessConfiguration(ctx,{...edit,previewFingerprint:preview.fingerprint},{...state.owner,persist:vi.fn(async()=>{throw new Error('Fictional audit refusal');})})).rejects.toThrow('Fictional audit refusal');
  // A mock transaction cannot prove SQL rollback or the contents of the actual domain event.
 });
 it('refuses an owner returning foreign-tenant data even if the submitted revision and roles look valid',async()=>{
  const state=fixture();state.snapshot={...state.snapshot,tenantId:id(99)};
  await expect(previewAccessConfiguration(ctx,edit,state.owner)).rejects.toMatchObject({code:'invalid'});
  expect(state.owner.persist).not.toHaveBeenCalled();
 });
});
