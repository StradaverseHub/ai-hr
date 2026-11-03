/** AI v2 Phase 2 P2-1 — the autonomy ladder's rules, without a database (core/loops/autonomy.ts).
 *
 *  1. The cap is code: every loop that touches pay, employment status, access, discipline or statutory filing, and the
 *     passports loop, can never be above Prepare, whatever a declaration or a configuration says; the declarations
 *     cannot be changed at run time.
 *  2. The promotion certificate is computed from the evidence exactly: thresholds, strict "under 1%", unknown shares.
 *  3. The demotion rule fires strictly above 1% over the window, never on no actions.
 *  4. Limits are refused, never clamped, outside their closed values.
 * Expected values are written out, never re-derived from the module's own constants. */
import {describe,expect,it} from 'vitest';
import {CAPPED_CATEGORIES,CAPPED_LOOPS,LOOP_AUTONOMY,certificate,levelAllowed,limitsChangeAllowed,maxLevel,parseLimits,promotableTo,sampleSize,shouldDemote,type AutonomyDeclaration} from '../core/loops/autonomy';
import {DEFAULT_LIMITS} from '../core/loops/autonomy-types';
import {LOOP_IDS} from '../core/loops/types';

describe('the cap on automatic action',()=>{
 it('keeps probation, payroll inputs and passports at Prepare, and lets only missed clock-outs and missing employee data above it',()=>{
  expect([...CAPPED_LOOPS].sort()).toEqual(['loop_document_expiry','loop_payroll_inputs','loop_probation_ending']);
  expect(Object.fromEntries(LOOP_IDS.map(id=>[id,[maxLevel(id),promotableTo(id)]]))).toEqual({
   loop_probation_ending:[1,1],loop_payroll_inputs:[1,1],loop_missing_employee_data:[3,3],loop_missed_clock_outs:[3,3],loop_document_expiry:[1,1]});
 });

 it.each(['loop_probation_ending','loop_payroll_inputs','loop_document_expiry'] as const)('%s can never be set above Prepare',id=>{
  expect(levelAllowed(id,0)).toBe(true);expect(levelAllowed(id,1)).toBe(true);
  for(const level of [2,3,4,1.5,-1,Number.NaN])expect(levelAllowed(id,level)).toBe(false);
 });

 it('caps any declaration that touches a capped category, whatever its ceiling or automatic step',()=>{
  expect([...CAPPED_CATEGORIES]).toEqual(['pay','employment_status','access','discipline','statutory_filing']);
  for(const category of ['pay','employment_status','access','discipline','statutory_filing']){
   const raised:AutonomyDeclaration={categories:['attendance',category],ceiling:3,actor:true,criteria:['prepared']};
   expect(maxLevel('loop_missed_clock_outs',raised),category).toBe(1);
   expect(promotableTo('loop_missed_clock_outs',raised),category).toBe(1);
  }
  // A ceiling outside the ladder is bounded too.
  expect(maxLevel('loop_missed_clock_outs',{categories:['attendance'],ceiling:9 as never,actor:true,criteria:[]})).toBe(3);
  expect(maxLevel('loop_missed_clock_outs',{categories:['attendance'],ceiling:-2 as never,actor:true,criteria:[]})).toBe(1);
  // No automatic step: never above Prepare.
  expect(promotableTo('loop_missed_clock_outs',{categories:['attendance'],ceiling:3,actor:false,criteria:[]})).toBe(1);
 });

 it('cannot be raised at run time: the declarations are frozen',()=>{
  expect(Object.isFrozen(LOOP_AUTONOMY)).toBe(true);
  for(const id of LOOP_IDS){
   expect(Object.isFrozen(LOOP_AUTONOMY[id])).toBe(true);expect(Object.isFrozen(LOOP_AUTONOMY[id].categories)).toBe(true);
  }
  expect(()=>{(LOOP_AUTONOMY.loop_payroll_inputs as {ceiling:number}).ceiling=3;}).toThrow(TypeError);
  expect(()=>{(LOOP_AUTONOMY.loop_payroll_inputs.categories as string[]).length=0;}).toThrow(TypeError);
  expect(()=>{(LOOP_AUTONOMY as Record<string,unknown>).loop_payroll_inputs={categories:[],ceiling:3,actor:true,criteria:[]};}).toThrow(TypeError);
  expect(maxLevel('loop_payroll_inputs')).toBe(1);
 });
});

describe('the promotion certificate',()=>{
 const ok={targetLevel:2 as const,prepared:214,asPrepared:199,changed:1,ruleBroken:0,daysAtLevel:34};
 it('meets every criterion of the missed clock-outs loop with the approved mock-up\'s evidence',()=>{
  expect(certificate('loop_missed_clock_outs',ok)).toEqual({targetLevel:2,met:true,criteria:[
   {id:'prepared',needed:200,actual:214,count:null,met:true},
   {id:'changed',needed:0.01,actual:0.005,count:1,met:true},
   {id:'rule_broken',needed:0,actual:0,count:null,met:true},
   {id:'days_at_level',needed:30,actual:34,count:null,met:true}]});
 });
 it('fails each criterion on its own threshold, and "under 1%" is strict',()=>{
  const failed=(input:Partial<typeof ok>)=>certificate('loop_missed_clock_outs',{...ok,...input}).criteria.filter(item=>!item.met).map(item=>item.id);
  expect(failed({prepared:199})).toEqual(['prepared']);
  expect(failed({prepared:200})).toEqual([]);
  expect(failed({asPrepared:99,changed:1})).toEqual(['changed']);// exactly 1%
  expect(failed({asPrepared:199,changed:2})).toEqual([]);// 2 of 201 is under 1%
  expect(failed({asPrepared:197,changed:3})).toEqual(['changed']);// 1.5%
  expect(failed({asPrepared:0,changed:0})).toEqual(['changed']);// no decided card: unknown, not met
  expect(failed({ruleBroken:1})).toEqual(['rule_broken']);
  expect(failed({daysAtLevel:29})).toEqual(['days_at_level']);
  expect(certificate('loop_missed_clock_outs',{...ok,asPrepared:0,changed:0}).criteria[1]).toEqual({id:'changed',needed:0.01,actual:null,count:0,met:false});
 });
 it('needs 90 days at Level 2 for Level 3',()=>{
  const three=(days:number)=>certificate('loop_missed_clock_outs',{...ok,targetLevel:3,daysAtLevel:days});
  expect(three(89).met).toBe(false);expect(three(89).criteria[3]).toEqual({id:'days_at_level',needed:90,actual:89,count:null,met:false});
  expect(three(90).met).toBe(true);
 });
 it('checks only what a loop declares: missing employee data proposes no value, so "changed" is not its criterion',()=>{
  expect(certificate('loop_missing_employee_data',{...ok,asPrepared:0,changed:0}).criteria.map(item=>item.id)).toEqual(['prepared','rule_broken','days_at_level']);
 });
});

describe('the demotion rule',()=>{
 it('fires strictly above 1% of the automatic actions, never on none',()=>{
  expect(shouldDemote(0,0)).toBe(false);
  expect(shouldDemote(100,1)).toBe(false);
  expect(shouldDemote(100,2)).toBe(true);
  expect(shouldDemote(200,2)).toBe(false);
  expect(shouldDemote(200,3)).toBe(true);
  expect(shouldDemote(2,1)).toBe(true);
 });
});

describe('the limits',()=>{
 it('accepts only whole nights of 1 to 200, an undo window of 3 or 7 days and a declared condition',()=>{
  expect(parseLimits({maxActionsPerNight:50,undoDays:3,condition:'roster_and_site_exit'})).toEqual({maxActionsPerNight:50,undoDays:3,condition:'roster_and_site_exit'});
  expect(parseLimits({maxActionsPerNight:200,undoDays:7,condition:'roster_end'})).toEqual({maxActionsPerNight:200,undoDays:7,condition:'roster_end'});
  for(const bad of [{maxActionsPerNight:0,undoDays:3,condition:'roster_end'},{maxActionsPerNight:201,undoDays:3,condition:'roster_end'},
   {maxActionsPerNight:2.5,undoDays:3,condition:'roster_end'},{maxActionsPerNight:Number.NaN,undoDays:3,condition:'roster_end'},
   {maxActionsPerNight:'50',undoDays:3,condition:'roster_end'},{maxActionsPerNight:50,undoDays:5,condition:'roster_end'},
   {maxActionsPerNight:50,undoDays:3,condition:'always'},null,undefined,'50'])expect(parseLimits(bad)).toBeNull();
 });
});

describe('Level 3: the weekly sample',()=>{
 it('is at least 10% and at least 5 actions, or every action when there are fewer',()=>{
  expect([0,1,4,5,6,12,49,50,51,120,200].map(sampleSize)).toEqual([0,1,4,5,5,5,5,5,6,12,20]);
 });
});

describe('changing limits without a promotion',()=>{
 const now={maxActionsPerNight:50,undoDays:3,condition:'roster_end'} as const;
 it('only makes them stricter, while the condition is the administrator\'s choice either way',()=>{
  expect(limitsChangeAllowed(now,{...now,maxActionsPerNight:20})).toBe(true);
  expect(limitsChangeAllowed(now,{...now,undoDays:7})).toBe(true);
  expect(limitsChangeAllowed(now,{...now,condition:'roster_and_site_exit'})).toBe(true);
  expect(limitsChangeAllowed({...now,condition:'roster_and_site_exit'},now)).toBe(true);
  expect(limitsChangeAllowed(now,{...now,maxActionsPerNight:51})).toBe(false);
  expect(limitsChangeAllowed({...now,undoDays:7},now)).toBe(false);
  expect(limitsChangeAllowed(now,now)).toBe(false);
 });
 it('starts from the roster-end condition while no site exit is recorded',()=>{
  expect(DEFAULT_LIMITS).toEqual({maxActionsPerNight:50,undoDays:3,condition:'roster_end'});
 });
});
