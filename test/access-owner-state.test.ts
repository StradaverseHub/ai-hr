import {describe,expect,it} from 'vitest';
import {parseAccessOwnerState} from '../lib/access-owner-state';
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const tenant=id(1),user=id(2),group=id(3),company=id(4);
const source=()=>({snapshot:{tenantId:tenant,revision:id(5),users:[{id:user,active:true}],groups:[{id:group,name:'Fictional group',retired:false,systemAdministrator:false,grants:[{capabilityId:'workforce.view',companyId:company}]}],memberships:[{userId:user,groupId:group,companyId:company,derived:false}],overrides:[]},catalog:[{id:'workforce.view',scope:'company',supported:true,bindings:[{owner:'fictional-owner',operation:'read'}]}],companyIds:[company],coverage:[],scopeFingerprint:'a'.repeat(64)});
describe('access database state boundary',()=>{
 it('accepts the canonical owner shape and supplies evidence without rebuilding an organization tree in the browser',()=>{
  const parsed=parseAccessOwnerState(source(),tenant);expect(parsed.evidence.knownCompanyIds.has(company)).toBe(true);expect(parsed.snapshot.memberships[0].derived).toBe(false);
 });
 it('refuses foreign tenants, dangling subjects/groups, unknown scope, duplicate identities and incomplete supported bindings',()=>{
  const variants:unknown[]=[null,{...source(),snapshot:{...source().snapshot,tenantId:id(99)}},
   {...source(),snapshot:{...source().snapshot,memberships:[{userId:id(99),groupId:group,companyId:company}]}},
   {...source(),snapshot:{...source().snapshot,memberships:[{userId:user,groupId:id(99),companyId:company}]}},
   {...source(),companyIds:[]},{...source(),snapshot:{...source().snapshot,users:[{id:user,active:true},{id:user,active:false}]}},
   {...source(),catalog:[{...source().catalog[0],bindings:[]}]},
  ];
  for(const value of variants)expect(()=>parseAccessOwnerState(value,tenant)).toThrow(/invalid/);
 });
 it('drops extra owner fields rather than passing an accidentally expanded HR projection to the editor',()=>{
  const raw={...source(),snapshot:{...source().snapshot,users:[{id:user,active:true,privateSalary:'DO-NOT-SERIALIZE'}],privatePayload:'DO-NOT-SERIALIZE'}};
  expect(JSON.stringify(parseAccessOwnerState(raw,tenant))).not.toContain('DO-NOT-SERIALIZE');
 });
});
