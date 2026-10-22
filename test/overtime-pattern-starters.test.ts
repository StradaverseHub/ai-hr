import {describe,expect,it} from 'vitest';
import {OVERTIME_STARTERS,overtimeStarter,prepareOvertimeStarter,overtimeStarterSeed,readOvertimeStarterSeed} from '../lib/overtime-pattern-starters';
import {validateOvertimePattern,validateOvertimePatternDraft} from '../lib/overtime-pattern-schema';

describe('standard overtime starting configurations',()=>{
 it('exposes all four multipliers with stable identities, including explicit zero',()=>{
  expect(OVERTIME_STARTERS.map(item=>[item.name,item.multiplier])).toEqual([
   ['OT 1.5','1.5'],['OT 2.0','2'],['OT 3.0','3'],['OT 0.0','0'],
  ]);
  expect(new Set(OVERTIME_STARTERS.map(item=>item.key)).size).toBe(4);
  expect(overtimeStarter('unknown')).toBeNull();
 });
 it.each(OVERTIME_STARTERS)('$name is editable draft data but cannot activate as a ready policy',starter=>{
  const draft=prepareOvertimeStarter(starter.key,'session','latest');
  expect(validateOvertimePatternDraft(draft)).toEqual(draft);
  expect(()=>validateOvertimePattern(draft)).toThrow();
  expect(draft.eligibilityBasis).toBe('session');
  expect(draft.durationAllocation).toBe('latest');
  expect(draft.currency.code).toBe('');
  expect(draft.rates[0].tiers[0].mapping).toEqual({earningItemId:'',currency:''});
  expect(draft.eligibility).toEqual({id:'eligibility',type:'group',logic:'and',children:[]});
 });
 it.each(OVERTIME_STARTERS)('$name persists as a non-executable starting document with no invented duration policy',starter=>{
  const seed=overtimeStarterSeed(starter.key);
  expect(readOvertimeStarterSeed(seed)).toBe(starter.key);
  expect(Object.keys(seed).sort()).toEqual(['draftKind','starterKey','v']);
  expect(()=>validateOvertimePatternDraft(seed)).toThrow();
  expect(()=>validateOvertimePattern(seed)).toThrow();
 });
 it('does not mistake malformed or executable documents for a standard starter',()=>{
  for(const raw of [null,[],{v:1,draftKind:'standardOvertimeStarter',starterKey:'missing'},
   {...overtimeStarterSeed('ot15'),rates:[]},{...overtimeStarterSeed('ot15'),v:2},
   prepareOvertimeStarter('ot15','day','earliest')])expect(readOvertimeStarterSeed(raw)).toBeNull();
  const getter=Object.defineProperty({...overtimeStarterSeed('ot15')},'starterKey',{get(){throw Error('Never execute a getter');}});
  expect(readOvertimeStarterSeed(getter)).toBeNull();
  expect(readOvertimeStarterSeed({...overtimeStarterSeed('ot15'),[Symbol('extra')]:true})).toBeNull();
 });
 it('does not share mutable formula state between companies or calls',()=>{
  const first=prepareOvertimeStarter('ot15','day','earliest');
  first.currency.code='MYR';first.rates[0].tiers[0].mapping.earningItemId='changed';
  const second=prepareOvertimeStarter('ot15','day','earliest');
  expect(second.currency.code).toBe('');
  expect(second.rates[0].tiers[0].mapping.earningItemId).toBe('');
 });
 it('requires actual duration policy choices even from untyped callers',()=>{
  expect(()=>prepareOvertimeStarter('ot15','' as never,'earliest')).toThrow();
  expect(()=>prepareOvertimeStarter('ot15','day','' as never)).toThrow();
  expect(()=>prepareOvertimeStarter('invalid' as never,'day','earliest')).toThrow();
 });
});
