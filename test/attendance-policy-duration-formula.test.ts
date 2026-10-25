import {describe,expect,it} from 'vitest';
import {attendancePolicyDurationFormulaProjection,type PolicyFormulaInput} from '../packs/attendance/policy-formula-source';
import {prepareOvertimeStarter} from '../lib/overtime-pattern-starters';

function fixture():Extract<PolicyFormulaInput,{state:'known'}>{
 return {authority:'sourceOnly',state:'known',references:[{state:'known',date:'2026-10-23',dayClass:'normal',moneyDay:'workday',
  versionId:'00000000-0000-4000-8000-000000000004',definition:prepareOvertimeStarter('ot15','day','latest'),definitionDigest:'a'.repeat(64),
  activeState:{id:'00000000-0000-4000-8000-000000000007',sequence:2,effectiveFrom:'2026-10-22'},
  earningReferences:[{id:'fictional-cash-mapping',privateMarker:'cash-only'}]}]};
}

describe('price-independent policy formula source contract',()=>{
 it('retains exact frozen formula identity and direction without cash definition or earning references',()=>{
  const source=fixture(),result=attendancePolicyDurationFormulaProjection(source);
  expect(result).toEqual({authority:'durationSourceOnly',state:'known',references:[{state:'known',date:'2026-10-23',dayClass:'normal',moneyDay:'workday',
   versionId:'00000000-0000-4000-8000-000000000004',definitionDigest:'a'.repeat(64),durationAllocation:'latest',
   activeState:{id:'00000000-0000-4000-8000-000000000007',sequence:2,effectiveFrom:'2026-10-22'}}]});
  expect(JSON.stringify(result)).not.toContain('cash-only');
  expect(Object.hasOwn(result,'transferable')).toBe(false);
 });
 it('cannot mutate the canonical active-state reference through a derived projection',()=>{
  const source=fixture(),before=structuredClone(source),result=attendancePolicyDurationFormulaProjection(source);
  if(result.state!=='known'||result.references[0].state!=='known')throw Error('Expected prepared reference');
  result.references[0].activeState.sequence=99;
  expect(source).toEqual(before);
 });
 it('preserves complete refusal and disabled states without manufacturing a formula',()=>{
  expect(attendancePolicyDurationFormulaProjection({authority:'sourceOnly',state:'unavailable',reason:'policyChanged'}))
   .toEqual({authority:'durationSourceOnly',state:'unavailable',reason:'policyChanged'});
  expect(attendancePolicyDurationFormulaProjection({authority:'sourceOnly',state:'disabled',references:[]}))
   .toEqual({authority:'durationSourceOnly',state:'disabled',references:[]});
 });
 it('does not promote an unavailable cash source into a known duration source',()=>{
  const result=attendancePolicyDurationFormulaProjection({authority:'sourceOnly',state:'known',references:[{date:'2026-10-23',state:'unavailable',reason:'mappingUnavailable'}]});
  expect(result).toEqual({authority:'durationSourceOnly',state:'known',references:[{date:'2026-10-23',state:'unavailable',reason:'mappingUnavailable'}]});
 });
});
