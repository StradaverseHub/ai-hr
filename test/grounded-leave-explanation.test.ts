/** Authored UNRUN: semantic Mine evidence, no provider/DB/model or recomputation. */
import {describe,expect,it} from 'vitest';
import {projectLeaveAnswerEvidence} from '../lib/ai/leave-answer-evidence';
import {projectMineLeaveEntitlement} from '../core/assistant-leave-projection';
import {resolveEssView,ESS_VIEW_COMPONENT_KEYS} from '../core/ess-view';
import type {LeaveEntitlementBreakdown} from '../core/read';
import {ENTITLEMENT_STATUS_LABEL_KEY,ENTITLEMENT_STATUS_TIP_KEY} from '../lib/entitlement-status';
const poison='PRIVATE_OR_MODEL_TEXT_NOT_AN_EXPLANATION';
const rule=()=>({id:'lineage-1',name:'Canonical scheme',state:'in_force',tested:true,validFrom:'2026-01-01',validTo:null as string|null,
 tableName:'Canonical table',failingAxis:'employmentTypes',failingAxisValue:poison,failsOnCombination:false,href:poison});
const row=()=>({employmentId:'employment-1',company:'Company A',leaveType:'Annual',cycleStart:'2026-01-01',
 entitlementStatus:'no_eligibility_match',entitlementTemplateName:null,withheld:false,
 displayEntitlementDays:0,currentYearEntitlement:0,broughtForward:3,adjustments:-1,totalEntitlement:2,takenThisCycle:1,
 pendingApproval:0,forfeitedThisCycle:0,totalAvailable:1,carryForwardExpiryDate:'2026-03-31',
 eligibility:{verdict:'no_match',activeAtDate:true,usesUndatedAxis:true,rules:[rule()]},
 transactions:poison,derivation:poison,balance:poison,answer:poison});
const outcome=(rows:unknown[]= [row()])=>({ok:true,asOf:'2026-02-01',employments:rows,answer:poison});
describe('question-specific canonical leave explanation evidence',()=>{
 it('keeps the actual reason, failed-axis label and expiry without exposing raw stored values or admin links',()=>{
  const evidence=projectLeaveAnswerEvidence(outcome())!,e=evidence.employments[0];
  expect(e.entitlement).toEqual({status:'no_eligibility_match',labelKey:'statusNoEligibilityMatch',tipKey:'statusNoEligibilityMatchTip',templateName:null});
  expect(e.eligibility).toMatchObject({verdict:'no_match',activeAtDate:true,usesUndatedAxis:true,rules:[{lineageId:'lineage-1',state:'in_force',tested:true,
   failingAxisLabel:{ns:'criteria',key:'employmentType'}}]});
  expect(e.carryForwardExpiryDate).toBe('2026-03-31');expect(e.figures.totalAvailable).toBe(1);
  expect(JSON.stringify(evidence)).not.toContain(poison);expect(Object.isFrozen(e.eligibility!.rules[0])).toBe(true);
 });
 it.each(Object.keys(ENTITLEMENT_STATUS_LABEL_KEY))('uses canonical %s status rather than explaining zero by guessing',status=>{
  const e=projectLeaveAnswerEvidence(outcome([{...row(),entitlementStatus:status,totalAvailable:0}]))!.employments[0];
  expect(e.entitlement.status).toBe(status);expect(e.entitlement.labelKey).toBe(ENTITLEMENT_STATUS_LABEL_KEY[status as keyof typeof ENTITLEMENT_STATUS_LABEL_KEY]);
  expect(e.entitlement.tipKey).toBe(ENTITLEMENT_STATUS_TIP_KEY[status as keyof typeof ENTITLEMENT_STATUS_TIP_KEY]??null);
 });
 it('distinguishes expired/not-yet/stopped and untested/combination reasons; keeps same-name lineages separate',()=>{
  const r=row();r.eligibility.rules=[{...rule(),state:'expired',tested:false,validTo:'2026-01-31'},
   {...rule(),id:'lineage-2',state:'not_yet',tested:false,validFrom:'2026-03-01'},
   {...rule(),id:'lineage-3',state:'table_stopped',tested:false},
   {...rule(),id:'lineage-4',failingAxis:null as unknown as string,failsOnCombination:true}];
  const rules=projectLeaveAnswerEvidence(outcome([r]))!.employments[0].eligibility!.rules;
  expect(rules.map(r=>r.state)).toEqual(['expired','not_yet','table_stopped','in_force']);
  expect(rules.map(r=>r.lineageId)).toEqual(['lineage-1','lineage-2','lineage-3','lineage-4']);
  expect(rules.every(r=>r.failingAxisLabel===null)).toBe(true);expect(rules[3].failsOnCombination).toBe(true);
 });
 it.each(ESS_VIEW_COMPONENT_KEYS)('preserves the actual Mine %s withholding without recovering ledger aliases',key=>{
  const raw={...row(),eligibleDays:9876,entitlement:{displayEntitlementDays:12},monthlyAccruedToDate:8765,carriedForward:7654,
   carryForwardRemaining:6543,configAdjustments:5432,systemAdjustments:4321,transactions:[],essView:resolveEssView({[key]:false})} as unknown as LeaveEntitlementBreakdown;
  const projected=projectMineLeaveEntitlement(raw),e=projectLeaveAnswerEvidence(outcome([{...projected,employmentId:'employment-1',company:'Company A'}]))!.employments[0];
  const mapping={eligible:'displayEntitlementDays',ytdEntitled:'currentYearEntitlement',broughtForward:'broughtForward',adjustment:'adjustments',total:'totalEntitlement',
   taken:'takenThisCycle',pendingApproval:'pendingApproval',forfeited:'forfeitedThisCycle',available:'totalAvailable'} as const;
  expect(e.withheld).toBe(true);expect(e.figures).not.toHaveProperty(mapping[key]);
  if(key==='forfeited')expect(e.carryForwardExpiryDate).toBeNull();
  for(const hidden of [9876,8765,7654,6543,5432,4321])expect(JSON.stringify(e)).not.toContain(String(hidden));
 });
 it('keeps each employment and exact canonical figures separate even when they intentionally do not form a simple sum',()=>{
  const first={...row(),totalAvailable:19},second={...row(),employmentId:'employment-2',company:'Company B',totalAvailable:7,carryForwardExpiryDate:null};
  const e=projectLeaveAnswerEvidence(outcome([first,second]))!;
  expect(e.employments.map(x=>[x.company,x.figures.totalAvailable])).toEqual([['Company A',19],['Company B',7]]);
  expect(e.employments[1].carryForwardExpiryDate).toBeNull();
  first.totalAvailable=999;first.eligibility.rules[0].name=poison;
  expect(e.employments[0].figures.totalAvailable).toBe(19);expect(JSON.stringify(e)).not.toContain(poison);
 });
 it('rejects malformed source states/dates/numbers and refuses unsuccessful outcomes without inventing an explanation',()=>{
  expect(projectLeaveAnswerEvidence({ok:false,error:poison})).toBeNull();
  for(const change of [{entitlementStatus:poison},{totalAvailable:Infinity},{carryForwardExpiryDate:'2026-02-30'},
   {eligibility:{...row().eligibility,rules:[{...rule(),state:poison}]}}])expect(()=>projectLeaveAnswerEvidence(outcome([{...row(),...change}]))).toThrow('Invalid canonical leave evidence.');
  expect(()=>projectLeaveAnswerEvidence({...outcome(),asOf:'2026-02-30'})).toThrow();
 });
 it('marks employment truncation explicitly and never mutates incoming source data',()=>{
  const r=row(),before=JSON.stringify(r),e=projectLeaveAnswerEvidence(outcome(Array.from({length:26},()=>r)))!;
  expect(e.employments).toHaveLength(25);expect(e.truncated).toBe(true);expect(JSON.stringify(r)).toBe(before);
 });
});
