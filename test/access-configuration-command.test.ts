import {describe,expect,it} from 'vitest';
import {applyAccessConfigurationCommand,isAccessConfigurationCommand} from '../lib/access-configuration-command';
import {accessPreviewFingerprint,assertAccessPreviewCurrent,type AccessPreviewBinding} from '../lib/access-preview-fingerprint';
import type {AccessCapability,AccessSnapshot,CompanyScopeEvidence} from '../lib/access-permission-model';

const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const tenant=id(1),admin=id(2),worker=id(3),system=id(4),team=id(5),parent=id(6),child=id(7),unrelated=id(8),delegate=id(9);
const catalog:AccessCapability[]=[
 {id:'access.system_admin',scope:'tenant',supported:true,bindings:[{owner:'fixture',operation:'recovery'}]},
 {id:'access.configure',scope:'tenant',supported:true,bindings:[{owner:'fixture',operation:'configure'}]},
 {id:'workforce.view',scope:'company',supported:true,bindings:[{owner:'fixture',operation:'read'}]},
];
const evidence:CompanyScopeEvidence={tenantId:tenant,knownCompanyIds:new Set([parent,child,unrelated]),covers:(a,c)=>a===parent&&c===child};
const snapshot=():AccessSnapshot=>({tenantId:tenant,revision:'revision-one',users:[{id:admin,active:true},{id:worker,active:true},{id:delegate,active:true}],groups:[
 {id:system,name:'System administrator',retired:false,systemAdministrator:true,grants:catalog.map(capability=>({capabilityId:capability.id,companyId:null}))},
 {id:team,name:'Workforce readers',retired:false,systemAdministrator:false,grants:[{capabilityId:'workforce.view',companyId:null}]},
],memberships:[{userId:admin,groupId:system,companyId:null}],overrides:[{userId:delegate,capabilityId:'access.configure',companyId:null,effect:'allow'},{userId:delegate,capabilityId:'workforce.view',companyId:parent,effect:'allow'}]});
const apply=(before:AccessSnapshot,value:unknown,actor=admin)=>applyAccessConfigurationCommand(before,catalog,actor,before.revision,value,evidence);

describe('bounded configuration commands against a fresh trusted snapshot',()=>{
 it('refuses hidden protected flags, foreign snapshot payloads, malformed ids and duplicate grants',()=>{
  for(const command of [
   {kind:'createGroup',groupId:id(20),name:'Readers',systemAdministrator:true},
   {kind:'createGroup',groupId:'unknown',name:'Readers'},
   {kind:'createGroup',groupId:id(20),name:'  Readers'},
   {kind:'replaceGroupGrants',groupId:team,grants:[{capabilityId:'workforce.view',companyId:null},{capabilityId:'workforce.view',companyId:null}]},
   {kind:'setOverride',userId:worker,capabilityId:'operator',companyId:null,effect:'allow'},
  ])expect(isAccessConfigurationCommand(command)).toBe(false);
 });
 it('accepts existing canonical PostgreSQL UUID identities without inventing a version or variant restriction',()=>{
  expect(isAccessConfigurationCommand({kind:'setMembership',groupId:team,userId:'22222222-2222-2222-2222-222222222222',companyId:'11111111-1111-1111-1111-111111111111',enabled:true})).toBe(true);
 });
 it('creates an empty ordinary group without changing the trusted before snapshot',()=>{
  const before=snapshot(),after=apply(before,{kind:'createGroup',groupId:id(20),name:'Readers'});
  expect(before.groups).toHaveLength(2);expect(after.groups).toHaveLength(3);
  expect(after.groups.find(g=>g.id===id(20))).toMatchObject({systemAdministrator:false,retired:false,grants:[]});
 });
 it('refuses stale revisions, inactive actors and configuration by a data reader alone',()=>{
  expect(()=>applyAccessConfigurationCommand(snapshot(),catalog,admin,'old',{kind:'retireGroup',groupId:team},evidence)).toThrow(/changed/);
  expect(()=>apply(snapshot(),{kind:'retireGroup',groupId:team},worker)).toThrow(/ceiling/);
  const before=snapshot();before.users=before.users.map(u=>u.id===admin?{...u,active:false}:u);
  expect(()=>apply(before,{kind:'retireGroup',groupId:team})).toThrow(/ceiling/);
 });
 it('permits a scoped membership only within the actor ceiling, without broadening the default group',()=>{
  const before=snapshot(),after=apply(before,{kind:'setMembership',userId:worker,groupId:team,companyId:parent,enabled:true},delegate);
  expect(after.memberships).toContainEqual({userId:worker,groupId:team,companyId:parent});
  for(const companyId of [null,unrelated])expect(()=>apply(before,{kind:'setMembership',userId:worker,groupId:team,companyId,enabled:true},delegate)).toThrow(/ceiling/);
 });
 it('does not pretend to remove a membership still supplied by the canonical role owner',()=>{
  const before=snapshot();before.memberships=[...before.memberships,{userId:worker,groupId:team,companyId:parent,derived:true}];
  for(const enabled of [true,false])expect(()=>apply(before,{kind:'setMembership',userId:worker,groupId:team,companyId:parent,enabled})).toThrow(/invalid/);
 });
 it('refuses foreign or inactive subjects and unknown companies before they enter the configuration',()=>{
  const before=snapshot();
  for(const patch of [{userId:id(99),companyId:parent},{userId:worker,companyId:id(98)}])expect(()=>apply(before,{kind:'setMembership',groupId:team,enabled:true,...patch})).toThrow(/invalid/);
  before.users=before.users.map(u=>u.id===worker?{...u,active:false}:u);
  expect(()=>apply(before,{kind:'setMembership',groupId:team,userId:worker,companyId:parent,enabled:true})).toThrow(/invalid/);
 });
 it('treats deny removal as a grant and refuses broad inheritance beyond a delegated scope',()=>{
  const before=snapshot();before.memberships=[...before.memberships,{userId:worker,groupId:team,companyId:null}];
  before.overrides=[...before.overrides,{userId:worker,capabilityId:'workforce.view',companyId:null,effect:'deny'}];
  expect(()=>apply(before,{kind:'setOverride',userId:worker,capabilityId:'workforce.view',companyId:null,effect:null},delegate)).toThrow(/ceiling/);
 });
 it('protects the final system administrator, including a direct deny and membership removal',()=>{
  for(const command of [
   {kind:'retireGroup',groupId:system},
   {kind:'setOverride',userId:admin,capabilityId:'access.system_admin',companyId:null,effect:'deny'},
   {kind:'setOverride',userId:admin,capabilityId:'access.configure',companyId:null,effect:'deny'},
  ])expect(()=>apply(snapshot(),command)).toThrow(/lastAdministrator/);
 });
 it('keeps protected System Administrator enrollment with the existing role owner',()=>{
  for(const command of [
   {kind:'setMembership',groupId:system,userId:worker,companyId:null,enabled:true},
   {kind:'setMembership',groupId:system,userId:admin,companyId:null,enabled:false},
   {kind:'setOverride',userId:worker,capabilityId:'access.system_admin',companyId:null,effect:'allow'},
   {kind:'replaceGroupGrants',groupId:team,grants:[{capabilityId:'access.system_admin',companyId:null}]},
  ])expect(()=>apply(snapshot(),command)).toThrow(/invalid/);
 });
 it('does not expose unsupported capabilities and does not rename into an existing group identity',()=>{
  expect(()=>apply(snapshot(),{kind:'replaceGroupGrants',groupId:team,grants:[{capabilityId:'installation.operator',companyId:null}]})).toThrow(/unsupported/);
  expect(()=>apply(snapshot(),{kind:'renameGroup',groupId:team,name:'SYSTEM ADMINISTRATOR'})).toThrow(/invalid/);
 });
});

describe('preview binding covers the actual authority and target state',()=>{
 const binding=():AccessPreviewBinding=>({actorUserId:admin,snapshot:snapshot(),catalog,command:{kind:'renameGroup',groupId:team,name:'Readers'},scopeFingerprint:'a'.repeat(64)});
 it('is independent of database row order while binding scope changes, actor, command, availability and revision',()=>{
  const value=binding(),token=accessPreviewFingerprint(value);
  const reordered={...value,snapshot:{...value.snapshot,users:[...value.snapshot.users].reverse(),groups:[...value.snapshot.groups].reverse(),overrides:[...value.snapshot.overrides].reverse()}};
  expect(accessPreviewFingerprint(reordered)).toBe(token);
  for(const next of [
   {...value,actorUserId:delegate},{...value,scopeFingerprint:'b'.repeat(64)},
   {...value,command:{...value.command,kind:'renameGroup' as const,groupId:team,name:'Other readers'}},
   {...value,snapshot:{...value.snapshot,revision:'revision-two'}},
   {...value,snapshot:{...value.snapshot,users:value.snapshot.users.map(u=>u.id===admin?{...u,active:false}:u)}},
  ])expect(()=>assertAccessPreviewCurrent(next,token)).toThrow(/changed/);
 });
 it('binds the supported consumer catalogue and refuses a token copied from another pending edit',()=>{
  const value=binding(),token=accessPreviewFingerprint(value);
  expect(()=>assertAccessPreviewCurrent(value,token)).not.toThrow();
  expect(()=>assertAccessPreviewCurrent({...value,catalog:catalog.map(c=>({...c,bindings:[]}))},token)).toThrow(/changed/);
  expect(()=>assertAccessPreviewCurrent(value,'not-a-preview')).toThrow(/changed/);
 });
});
