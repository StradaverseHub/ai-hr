/** Orchestration unit contracts only. Real SQL locking, RLS and rollback require separate DB journeys. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext,Tx} from '../db/client';
import type {AccessCapability,AccessSnapshot,CompanyScopeEvidence} from '../lib/access-permission-model';
const observed=vi.hoisted(()=>({calls:[] as string[],events:[] as unknown[],auditFailure:false}));
vi.mock('../db/client',()=>({withTenant:async(_ctx:unknown,run:(tx:unknown)=>Promise<unknown>)=>{
  observed.calls.push('transaction');return run({execute:async()=>{observed.calls.push('lock');}});
}}));
vi.mock('../db/events',()=>({actorOf:(ctx:SessionContext)=>({type:'user',id:ctx.userId}),appendEvent:async(_tx:unknown,event:unknown)=>{
  observed.calls.push('audit');if(observed.auditFailure)throw new Error('Fictional audit refusal');observed.events.push(event);
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
beforeEach(()=>{observed.calls.length=0;observed.events.length=0;observed.auditFailure=false;});

describe('one fresh locked access transition for preview and commit',()=>{
 it('previews real losses, then re-reads before saving and appends only bounded audit data',async()=>{
  const state=fixture(),preview=await previewAccessConfiguration(ctx,edit,state.owner);
  expect(preview.changes).toMatchObject([{userId:worker,capabilityId:'workforce.view',companyId:company,before:{allowed:true},after:{allowed:false,reason:'denied'}}]);
  expect(state.owner.persist).not.toHaveBeenCalled();expect(observed.events).toEqual([]);
  const result=await saveAccessConfiguration(ctx,{...edit,previewFingerprint:preview.fingerprint},state.owner);
  expect(result.revision).not.toBe('revision-one');expect(state.snapshot.revision).toBe(result.revision);
  expect(observed.calls).toEqual(['transaction','lock','fresh-owner','transaction','lock','fresh-owner','persist','audit']);
  expect(observed.events).toMatchObject([{tenantId:tenant,eventType:'access-configuration.changed',payload:{kind:'setOverride',userId:worker,capabilityId:'workforce.view',beforeEffect:null,afterEffect:'deny'}}]);
  expect(JSON.stringify(observed.events)).not.toContain('Fictional private group name');
 });
 it('does not trust roles in an old SessionContext when the current login lost configuration authority',async()=>{
  const state=fixture(),preview=await previewAccessConfiguration(ctx,edit,state.owner);
  state.snapshot={...state.snapshot,users:state.snapshot.users.map(user=>user.id===admin?{...user,active:false}:user)};
  await expect(saveAccessConfiguration(ctx,{...edit,previewFingerprint:preview.fingerprint},state.owner)).rejects.toMatchObject({code:'ceiling'});
  expect(state.owner.persist).not.toHaveBeenCalled();expect(observed.events).toEqual([]);
 });
 it('refuses changed organisation evidence and command substitution before any persistence call',async()=>{
  const state=fixture(),preview=await previewAccessConfiguration(ctx,edit,state.owner);
  state.scopeFingerprint='b'.repeat(64);
  await expect(saveAccessConfiguration(ctx,{...edit,previewFingerprint:preview.fingerprint},state.owner)).rejects.toMatchObject({code:'changed'});
  state.scopeFingerprint='a'.repeat(64);
  await expect(saveAccessConfiguration(ctx,{...edit,command:{...edit.command,effect:'allow'},previewFingerprint:preview.fingerprint},state.owner)).rejects.toMatchObject({code:'changed'});
  expect(state.owner.persist).not.toHaveBeenCalled();expect(observed.events).toEqual([]);
 });
 it('refuses replay after the first save advanced the revision',async()=>{
  const state=fixture(),preview=await previewAccessConfiguration(ctx,edit,state.owner),save={...edit,previewFingerprint:preview.fingerprint};
  await saveAccessConfiguration(ctx,save,state.owner);
  await expect(saveAccessConfiguration(ctx,save,state.owner)).rejects.toMatchObject({code:'changed'});
  expect(state.owner.persist).toHaveBeenCalledTimes(1);expect(observed.events).toHaveLength(1);
 });
 it('does not audit a failed storage CAS and propagates an audit failure to the enclosing transaction',async()=>{
  const state=fixture(),preview=await previewAccessConfiguration(ctx,edit,state.owner);
  const refused={...state.owner,persist:vi.fn(async()=>false)};
  await expect(saveAccessConfiguration(ctx,{...edit,previewFingerprint:preview.fingerprint},refused)).rejects.toMatchObject({code:'changed'});
  expect(observed.events).toEqual([]);
  observed.auditFailure=true;
  await expect(saveAccessConfiguration(ctx,{...edit,previewFingerprint:preview.fingerprint},state.owner)).rejects.toThrow('Fictional audit refusal');
  // A mock transaction does not prove SQL rollback. That remains an explicit database acceptance item.
 });
 it('refuses an owner returning foreign-tenant data even if the submitted revision and roles look valid',async()=>{
  const state=fixture();state.snapshot={...state.snapshot,tenantId:id(99)};
  await expect(previewAccessConfiguration(ctx,edit,state.owner)).rejects.toMatchObject({code:'invalid'});
  expect(state.owner.persist).not.toHaveBeenCalled();
 });
});
