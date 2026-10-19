import {describe,it,expect} from 'vitest';
import {EMPTY_PROFILE_ROUTING,isProfileRoutingPolicy} from '../lib/profile-routing-policy';
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const rule={id,name:'HR for Finance',approverEmploymentId:other,employmentIds:[],criteria:{departmentIds:[id]}};
describe('bounded named HR route transport',()=>{
 it('retains the disabled legacy boundary until explicitly enabled',()=>{expect(isProfileRoutingPolicy(EMPTY_PROFILE_ROUTING)).toBe(true);expect(EMPTY_PROFILE_ROUTING.enabled).toBe(false);});
 it('accepts stable principal employment identities and finite organisation/direct target criteria',()=>{expect(isProfileRoutingPolicy({...EMPTY_PROFILE_ROUTING,enabled:true,rules:[rule]})).toBe(true);});
 it('refuses duplicate route identities, duplicate direct subjects and arbitrary nested criteria payloads',()=>{
  for(const rules of [[rule,rule],[{...rule,employmentIds:[id,id]}],[{...rule,criteria:{departmentIds:{all:true}}}],[{...rule,criteria:{orgDivision:['']}}]])expect(isProfileRoutingPolicy({...EMPTY_PROFILE_ROUTING,rules})).toBe(false);
 });
 it('refuses unknown schema properties, invalid revisions and oversized rule lists',()=>{
  expect(isProfileRoutingPolicy({...EMPTY_PROFILE_ROUTING,arbitraryApproval:true})).toBe(false);
  expect(isProfileRoutingPolicy({...EMPTY_PROFILE_ROUTING,revision:'latest'})).toBe(false);
  expect(isProfileRoutingPolicy({...EMPTY_PROFILE_ROUTING,rules:Array(33).fill(rule)})).toBe(false);
 });
});
