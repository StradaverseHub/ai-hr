/** Pure private-digest semantics; no resolver, session, database or permission mocking. */
import {describe,expect,it} from 'vitest';
import type {EntitlementSnapshot} from '../core/entitlement-types';
import {canonicalEntitlementsForDigest as canonical} from '../lib/assistant-actions/canonical-entitlements';
const snapshot=():EntitlementSnapshot=>({tenantId:'fictional-tenant',enabledModules:['leave','employees','leave'],scopedModules:{payroll:['company-b','company-a','company-b'],lifecycle:['company-c']},settings:{z:false,nested:{z:null,a:{z:0,a:''}},ordered:[{z:2,a:1},'last','last']},tenantStatus:'active'});
const wire=(value:EntitlementSnapshot|undefined)=>JSON.stringify(canonical(value));
describe('canonical commercial snapshot for private review digests only',()=>{
 it('makes equivalent module/company sets and nested object key order serialize identically',()=>{
  const left=snapshot(),right:EntitlementSnapshot={tenantStatus:'active',settings:{ordered:[{a:1,z:2},'last','last'],nested:{a:{a:'',z:0},z:null},z:false},scopedModules:{lifecycle:['company-c'],payroll:['company-a','company-b']},enabledModules:['employees','leave'],tenantId:'fictional-tenant'};
  expect(wire(left)).toBe(wire(right));expect(canonical(left)).toEqual({...left,enabledModules:['employees','leave'],scopedModules:{lifecycle:['company-c'],payroll:['company-a','company-b']}});
 });
 it('does not mutate input and returns detached nested arrays and objects',()=>{
  const input=snapshot(),original=structuredClone(input),result=canonical(input)!;expect(input).toEqual(original);expect(result).not.toBe(input);result.enabledModules.push('new-module');result.scopedModules.payroll.push('new-company');(result.settings.nested as {a:{z:number}}).a.z=42;(result.settings.ordered as unknown[]).reverse();expect(input).toEqual(original);
 });
 it('preserves ordered setting arrays and duplicate values while still ordering objects inside them',()=>{
  const input=snapshot(),result=canonical(input)!;expect(result.settings.ordered).toEqual([{a:1,z:2},'last','last']);const reversed=structuredClone(input);(reversed.settings.ordered as unknown[]).reverse();expect(wire(reversed)).not.toBe(wire(input));
 });
 it.each(['tenant','status','module','scope','scalar','nested','array'] as const)('retains a real %s change in the private digest input',kind=>{
  const left=snapshot(),right=structuredClone(left);if(kind==='tenant')right.tenantId='another-tenant';if(kind==='status')right.tenantStatus='suspended';if(kind==='module')right.enabledModules.push('lifecycle');if(kind==='scope')right.scopedModules.payroll.push('company-d');if(kind==='scalar')right.settings.z=true;if(kind==='nested')(right.settings.nested as {a:{z:number}}).a.z=1;if(kind==='array')(right.settings.ordered as unknown[]).push('another');expect(wire(right)).not.toBe(wire(left));
 });
 it('preserves null, false, zero, empty strings, undefined snapshots and missing versus explicit-null settings',()=>{
  const input=snapshot();expect(canonical(input)?.settings.nested).toEqual({a:{a:'',z:0},z:null});expect(canonical(input)?.settings.z).toBe(false);expect(canonical(undefined)).toBeUndefined();const explicit=structuredClone(input);explicit.settings.extra=null;expect(wire(explicit)).not.toBe(wire(input));
 });
});
