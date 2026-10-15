import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import framework from '../packs/performance/onehr/framework.json';
import { defaultPolicy, type KPI } from '../packs/performance/onehr/model';
import { assessmentDraftSchema, assertCurveLock, careerPlanLocked, careerPlanState, curveGaps, curveTolerance, settingModerator, sourceRound } from '../packs/performance/onehr/journey-model';
import { assessmentReturnPath } from '../lib/performance-navigation';

// Contracts re-derived from the supplied October source: single moderator, integer curve targets,
// private partial inputs, and the unified journey's PM/TC dependency (not peer feedback).
describe('Performance journey source contracts',()=>{
 it('assigns one active moderator and refuses employee rerouting, including an ordered chain',()=>{
  const manager=randomUUID(),matrix=randomUUID();
  expect(settingModerator(undefined,manager,[manager,matrix])).toBe(manager);
  expect(()=>settingModerator(undefined,manager,[manager,matrix],[matrix])).toThrow(/HR assigns/);
  expect(()=>settingModerator(undefined,manager,[manager,matrix],[manager,matrix])).toThrow(/one assigned/);
  const existing={moderatorEmploymentId:matrix} as KPI;
  expect(settingModerator(existing,manager,[manager,matrix],[matrix])).toBe(matrix);
  expect(settingModerator(existing,manager,[manager])).toBe(manager);
  expect(settingModerator(undefined,null,[])).toBeNull();
 });
 it('matches Python integer target rounding separately from half-up percentage tolerance',()=>{
  expect([0.5,1.5,2.5,3.5].map(sourceRound)).toEqual([0,2,2,4]);
  const policy=defaultPolicy(framework);
  expect(curveTolerance(policy,0)).toBe(0);expect(curveTolerance(policy,200)).toBe(1);
  expect(curveTolerance({...policy,curveTolerancePeople:8},3)).toBe(3);
  expect(curveTolerance({...policy,curveToleranceMode:'percent',curveTolerancePct:10},25)).toBe(3);
  expect(curveGaps(['Low','Mid','High'],{Low:1,Mid:7,High:2},{Low:15,Mid:70,High:15})).toEqual({Low:1,Mid:0,High:0});
 });
 it('cannot bypass strict BU distribution with a reason; non-strict still needs a reason; HOD and BG have no curve gate',()=>{
  const policy=defaultPolicy(framework),rows=Array.from({length:10},()=>({performance:'OU' as const,potential:'High' as const})),axes={pm:true,pot:true},reference={UA:5,BE:10,ME:70,AE:10,OU:5};
  expect(()=>assertCurveLock(policy,'bu',rows,reference,axes,'Executive override')).toThrow(/Strict/);
  expect(()=>assertCurveLock({...policy,curveStrict:false},'bu',rows,reference,axes,'')).toThrow(/reason/);
  expect(()=>assertCurveLock({...policy,curveStrict:false},'bu',rows,reference,axes,'A documented exception')).not.toThrow();
  for(const tier of ['hod','bg','group'])expect(()=>assertCurveLock(policy,tier,rows,reference,axes,'')).not.toThrow();
 });
 it('keeps unfinished answers in the draft model and rejects non-finite results and arbitrary answers',()=>{
  expect(assessmentDraftSchema.parse({kind:'results',lines:[{id:randomUUID(),actual:null,note:''}],remark:''}).kind).toBe('results');
  expect(()=>assessmentDraftSchema.parse({kind:'results',lines:[{id:randomUUID(),actual:Infinity,note:''}],remark:''})).toThrow();
  expect(()=>assessmentDraftSchema.parse({kind:'feedback',answers:{statement:'sometimes'},remark:''})).toThrow();
 });
 it('opens career planning after own PM and competency are done; rating colleagues never blocks it',()=>{
  expect(careerPlanLocked([{key:'checkin',module:'pm',group:'self',state:'waiting'}])).toBe(true);
  expect(careerPlanLocked([{key:'feedback',module:'tm',group:'self',state:'open'},{key:'competency',module:'tm',group:'self',state:'done'}])).toBe(false);
  expect(careerPlanLocked([{key:'competency',module:'tm',group:'self',state:'later'}])).toBe(false);
  expect(careerPlanState('done','open')).toBe('open');expect(careerPlanState('done','done')).toBe('done');
  expect(careerPlanState('done','later')).toBe('later');expect(careerPlanState('open','open',true)).toBe('later');expect(careerPlanState('off',undefined)).toBeNull();
 });
 it('preserves workspace context without accepting external redirects or arbitrary query arguments',()=>{
  const fallback='/performance/review/record';
  for(const value of ['https://example.com','//example.com','/performance/workspace/../outside','/performance/workspace.evil?review=a'])expect(assessmentReturnPath(value,fallback)).toBe(fallback);
  expect(assessmentReturnPath('/performance/workspace?view=team&module=pm&review=abc&unsafe=yes',fallback)).toBe('/performance/workspace?view=team&module=pm&review=abc');
 });
});
