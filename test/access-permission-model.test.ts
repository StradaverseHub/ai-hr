import {describe,it,expect} from 'vitest';
import {resolveAccessCapability,assertAccessGrantCeiling,assertSystemAdministratorSurvives,previewEffectiveAccess,type AccessSnapshot,type AccessCapability,type CompanyScopeEvidence} from '../lib/access-permission-model';
const catalog:AccessCapability[]=[{id:'workforce.view',scope:'company',supported:true,bindings:[{owner:'fictional-test-owner',operation:'read'}]},{id:'access.system_admin',scope:'tenant',supported:true,bindings:[{owner:'fictional-test-owner',operation:'recover'}]},{id:'access.configure',scope:'tenant',supported:true,bindings:[{owner:'fictional-test-owner',operation:'configure'}]},{id:'pending.edit',scope:'company',supported:false,bindings:[]}];
const evidence:CompanyScopeEvidence={tenantId:'tenant-a',knownCompanyIds:new Set(['parent','child','unrelated']),covers:(ancestor,company)=>ancestor==='parent'&&company==='child'};
const target={tenantId:'tenant-a',companyId:'child'};
const snapshot=():AccessSnapshot=>({tenantId:'tenant-a',revision:'revision-a',users:[{id:'admin',active:true},{id:'worker',active:true}],groups:[{id:'system',name:'System administrator',retired:false,systemAdministrator:true,grants:[{capabilityId:'access.system_admin',companyId:null},{capabilityId:'access.configure',companyId:null}]},{id:'team-a',name:'Team A',retired:false,systemAdministrator:false,grants:[{capabilityId:'workforce.view',companyId:'parent'}]},{id:'team-b',name:'Team B',retired:false,systemAdministrator:false,grants:[{capabilityId:'workforce.view',companyId:'child'}]}],memberships:[{groupId:'system',userId:'admin',companyId:null},{groupId:'team-a',userId:'worker',companyId:null},{groupId:'team-b',userId:'worker',companyId:null}],overrides:[]});
describe('effective permission algebra for trusted owner snapshots',()=>{
 it('unions groups and explains continued access after one group grant is removed',()=>{
  const before=snapshot(),after={...before,memberships:before.memberships.filter(row=>row.groupId!=='team-a')};
  const changes=previewEffectiveAccess(before,after,catalog,['worker'],[{capabilityId:'workforce.view',target}],evidence);
  expect(changes).toHaveLength(1);expect(changes[0].before.sources).toHaveLength(2);expect(changes[0].after.allowed).toBe(true);expect(changes[0].after.sources).toMatchObject([{kind:'group',id:'team-b'}]);
 });
 it('an explicit individual denial wins over all inherited and direct allows in its scope',()=>{
  const source=snapshot();source.overrides=[{userId:'worker',capabilityId:'workforce.view',companyId:null,effect:'allow'},{userId:'worker',capabilityId:'workforce.view',companyId:'child',effect:'deny'}];
  expect(resolveAccessCapability(source,catalog,'worker','workforce.view',target,evidence)).toMatchObject({allowed:false,reason:'denied'});
  expect(resolveAccessCapability(source,catalog,'worker','workforce.view',{...target,companyId:'unrelated'},evidence).allowed).toBe(true);
 });
 it('does not reinterpret a denial in an unrelated company or a retired group as authority',()=>{
  const source=snapshot();source.overrides=[{userId:'worker',capabilityId:'workforce.view',companyId:'unrelated',effect:'deny'}];
  expect(resolveAccessCapability(source,catalog,'worker','workforce.view',target,evidence).allowed).toBe(true);
  source.groups=source.groups.map(group=>({...group,retired:true}));expect(resolveAccessCapability(source,catalog,'worker','workforce.view',target,evidence).allowed).toBe(false);
 });
 it('fails closed for foreign tenants, unknown companies, inactive users, unsupported capabilities and a missing required company',()=>{
  const source=snapshot();
  for(const next of [{tenantId:'foreign',companyId:'child'},{tenantId:'tenant-a',companyId:'missing'},{tenantId:'tenant-a',companyId:null}])expect(resolveAccessCapability(source,catalog,'worker','workforce.view',next,evidence).allowed).toBe(false);
  expect(resolveAccessCapability(source,catalog,'worker','pending.edit',target,evidence).reason).toBe('unsupported');
  source.users=source.users.map(user=>({...user,active:false}));expect(resolveAccessCapability(source,catalog,'worker','workforce.view',target,evidence).reason).toBe('unavailable');
 });
 it('does not turn permission text or an absent binding into a supported control',()=>{
  expect(resolveAccessCapability(snapshot(),catalog,'worker','operator',target,evidence).reason).toBe('unsupported');
  expect(resolveAccessCapability(snapshot(),[{...catalog[0],bindings:[]}],'worker','workforce.view',target,evidence).reason).toBe('unsupported');
 });
 it('refuses delegation beyond the actor ceiling, including company-to-tenant promotion',()=>{
  expect(()=>assertAccessGrantCeiling(snapshot(),catalog,'worker',[{capabilityId:'workforce.view',companyId:'child'}],evidence)).not.toThrow();
  for(const companyId of [null,'unrelated'])expect(()=>assertAccessGrantCeiling(snapshot(),catalog,'worker',[{capabilityId:'workforce.view',companyId}],evidence)).toThrow();
 });
 it('protects the final active system administrator against removal, explicit denial and inactive-login races',()=>{
  const before=snapshot();expect(()=>assertSystemAdministratorSurvives(before,before,catalog,evidence)).not.toThrow();
  const variants=[{...before,memberships:before.memberships.filter(row=>row.userId!=='admin')},{...before,overrides:[{userId:'admin',capabilityId:'access.system_admin',companyId:null,effect:'deny' as const}]},{...before,users:before.users.map(user=>({...user,active:user.id!=='admin'}))}];
  for(const after of variants)expect(()=>assertSystemAdministratorSurvives(before,after,catalog,evidence)).toThrow(/lastAdministrator/);
 });
 it('never lets an ordinary group self-declare the protected bootstrap identity',()=>{
  const before=snapshot(),after={...before,groups:before.groups.map(group=>({...group,systemAdministrator:true}))};expect(()=>assertSystemAdministratorSurvives(before,after,catalog,evidence)).toThrow(/invalid/);
 });
});

it('only explicit unrestricted authority can delegate an all-company permission, including future companies',()=>{
 const source=snapshot();source.overrides=[{userId:'worker',capabilityId:'workforce.view',companyId:null,effect:'allow'}];
 expect(()=>assertAccessGrantCeiling(source,catalog,'worker',[{capabilityId:'workforce.view',companyId:null}],evidence)).not.toThrow();
 source.overrides=[...source.overrides,{userId:'worker',capabilityId:'workforce.view',companyId:'child',effect:'deny'}];
 expect(()=>assertAccessGrantCeiling(source,catalog,'worker',[{capabilityId:'workforce.view',companyId:null}],evidence)).toThrow(/ceiling/);
});

it('intersects each group permission with the membership scope so a tenant-wide default group cannot widen a company member',()=>{
 const source=snapshot();source.groups=source.groups.map(group=>group.id==='team-a'?{...group,grants:[{capabilityId:'workforce.view',companyId:null}]}:group);
 source.memberships=[{userId:'admin',groupId:'system',companyId:null},{userId:'worker',groupId:'team-a',companyId:'parent'}];
 expect(resolveAccessCapability(source,catalog,'worker','workforce.view',target,evidence)).toMatchObject({allowed:true,sources:[{kind:'group',id:'team-a',companyId:null,membershipCompanyId:'parent'}]});
 expect(resolveAccessCapability(source,catalog,'worker','workforce.view',{...target,companyId:'unrelated'},evidence).allowed).toBe(false);
 expect(()=>assertAccessGrantCeiling(source,catalog,'worker',[{capabilityId:'workforce.view',companyId:null}],evidence)).toThrow(/ceiling/);
});

it('does not delegate an ancestor scope across an explicitly denied child subtree',()=>{
 const source=snapshot();source.overrides=[{userId:'worker',capabilityId:'workforce.view',companyId:'child',effect:'deny'}];
 // The parent itself remains readable, but granting its entire subtree would erase the denial.
 expect(resolveAccessCapability(source,catalog,'worker','workforce.view',{...target,companyId:'parent'},evidence).allowed).toBe(true);
 expect(()=>assertAccessGrantCeiling(source,catalog,'worker',[{capabilityId:'workforce.view',companyId:'parent'}],evidence)).toThrow(/ceiling/);
});

it('retains a recovery administrator who can actually open and save access configuration',()=>{
 const before=snapshot(),after={...before,overrides:[{userId:'admin',capabilityId:'access.configure',companyId:null,effect:'deny' as const}]};
 expect(()=>assertSystemAdministratorSurvives(before,after,catalog,evidence)).toThrow(/lastAdministrator/);
});
