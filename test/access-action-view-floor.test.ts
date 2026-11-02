import {describe,expect,it} from 'vitest';
import {assertAccessGrantCeiling,resolveAccessCapability,type AccessSnapshot,type AccessCapability} from '../lib/access-permission-model';
const tenant='tenant',user='user',group='group',company='company';
const catalog:AccessCapability[]=['workforce.view','workforce.maintain','workforce.add','workforce.edit','workforce.delete','letters.view','letters.issue'].map(id=>({id,scope:'company',supported:true,bindings:[{owner:'fixture-bound-owner',operation:'fixture'}]}));
const evidence={tenantId:tenant,knownCompanyIds:new Set([company]),covers:()=>false};
const snapshot=(ids:string[]):AccessSnapshot=>({tenantId:tenant,revision:'r',users:[{id:user,active:true}],groups:[{id:group,name:'Fictional group',retired:false,systemAdministrator:false,grants:ids.map(capabilityId=>({capabilityId,companyId:null}))}],memberships:[{userId:user,groupId:group,companyId:null}],overrides:[]});
const target={tenantId:tenant,companyId:company};
describe('canonical action View floor',()=>{
 it.each(['add','edit','delete'])('%s never grants View implicitly in the canonical algebra',action=>{
  expect(resolveAccessCapability(snapshot(['workforce.'+action]),catalog,user,'workforce.'+action,target,evidence).allowed).toBe(false);
  expect(resolveAccessCapability(snapshot(['workforce.view','workforce.'+action]),catalog,user,'workforce.'+action,target,evidence).allowed).toBe(true);
 });
 it('a View deny and retained legacy maintenance deny both override independent write grants',()=>{
  for(const capabilityId of ['workforce.view','workforce.maintain']){const state=snapshot(['workforce.view','workforce.edit']);state.overrides=[{userId:user,capabilityId,companyId:company,effect:'deny'}];expect(resolveAccessCapability(state,catalog,user,'workforce.edit',target,evidence).reason).toBe('denied');}
 });
 it('requires global View before delegating global action authority',()=>{
  expect(()=>assertAccessGrantCeiling(snapshot(['workforce.add']),catalog,user,[{capabilityId:'workforce.add',companyId:null}],evidence)).toThrow();
  expect(()=>assertAccessGrantCeiling(snapshot(['workforce.view','workforce.add']),catalog,user,[{capabilityId:'workforce.add',companyId:null}],evidence)).not.toThrow();
 });
 it('the same floor applies to domain-specific native actions such as letter issue',()=>{
  expect(resolveAccessCapability(snapshot(['letters.issue']),catalog,user,'letters.issue',target,evidence).allowed).toBe(false);
  expect(resolveAccessCapability(snapshot(['letters.view','letters.issue']),catalog,user,'letters.issue',target,evidence).allowed).toBe(true);
 });
});
