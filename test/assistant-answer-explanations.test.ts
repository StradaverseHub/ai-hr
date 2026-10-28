/** Fictional canonical projections/real pure specialist only; no app/RLS/provider/runtime proof. */
import {describe,it,expect} from 'vitest';
import {leaveAnswerExplanations,specialistAnswerExplanations,assistantAnswerExplanationAvailability,ASSISTANT_EXPLANATION_LIMITS} from '../lib/ai/assistant-answer-explanations';
import {adjudicateAssistantAnswerPlan,type AssistantAnswerRead} from '../lib/ai/assistant-answer-plan';
import {presentGroundedToolOutcome} from '../lib/ai/grounded-tool-presentation';
import {executeCanonicalSpecialist} from '../lib/ai/module-specialists';
import type {JobPresentation} from '../lib/ai/module-jobs';
import type {EntitlementStatus,EligibilityRuleNotice,EligibilityVerdict} from '../lib/entitlement-status';
const row=(status:EntitlementStatus='not_generated')=>({employmentId:'00000000-0000-4000-8000-000000000001',company:'Fictional A',leaveType:'Fictional Annual',cycleStart:'2026-01-01',withheld:false,
 entitlementStatus:status,entitlementTemplateName:'Fictional table',displayEntitlementDays:12,currentYearEntitlement:10,broughtForward:0,adjustments:0,totalEntitlement:10,takenThisCycle:2,pendingApproval:1,forfeitedThisCycle:0,totalAvailable:7,
 carryForwardExpiryDate:null,eligibility:null as ReturnType<typeof notice>|null});
const rule=(state:EligibilityRuleNotice['state']='in_force',tested=true):EligibilityRuleNotice=>({id:'private-lineage',name:'Fictional scheme',state,tested,validFrom:'2026-01-01',validTo:'2026-06-30',tableName:'Fictional table',failingAxis:'gradeIds',failingAxisValue:'PRIVATE_AXIS_VALUE',href:'/admin/private',failsOnCombination:false});
const notice=(verdict:EligibilityVerdict='no_match')=>({verdict,activeAtDate:true,usesUndatedAxis:false,rules:[rule()]});
const outcome=(rows=[row()])=>({ok:true,asOf:'2026-10-28',employments:rows});
const view=(source:ReturnType<typeof outcome>)=>presentGroundedToolOutcome('leave_entitlement_explain',source)!;
const keys=(source:ReturnType<typeof outcome>)=>leaveAnswerExplanations(source,view(source)).map(row=>row.code);

describe('actual source-owned answer explanation bridge',()=>{
 it('copies each engine status without turning zero/no-ledger into not-generated or unknown into no table',()=>{
  for(const status of['granted','not_generated','earned_accrual','earned_method_not_annual_leave','zero_entitlement','earning_method_missing','no_entitlement_table','no_eligibility_match','capped_by_max_balance'] as const){const source=outcome([{...row(status),totalAvailable:0,currentYearEntitlement:0}]);expect(keys(source)).toEqual([`leave_status:${status}`]);}
  expect(keys(outcome([row('not_configured')]))).toEqual([]);
  const source=outcome([row('not_generated'),{...row('earned_accrual'),employmentId:'00000000-0000-4000-8000-000000000002',company:'Fictional B'}]);
  const descriptors=leaveAnswerExplanations(source,view(source));expect(descriptors.map(row=>[row.card,row.code])).toEqual([[0,'leave_status:not_generated'],[1,'leave_status:earned_accrual']]);
 });
 it('offers exact original-card clauses for the real model selector and refuses swapped/current-mismatched presentation',()=>{
  const source=outcome(),presentation=view(source),descriptors=leaveAnswerExplanations(source,presentation);
  const current:AssistantAnswerRead[]=[{read:4,presentation,explanations:assistantAnswerExplanationAvailability(descriptors)}];
  const plan={version:1,mode:'answer',blocks:[{kind:'explanation',read:4,card:0,code:'leave_status:not_generated'}]};expect(adjudicateAssistantAnswerPlan(plan,current)).toEqual(plan);
  expect(()=>adjudicateAssistantAnswerPlan({...plan,blocks:[{...plan.blocks[0],card:1}]},current)).toThrow();
  const changed={...presentation,cards:presentation.cards.map(card=>({...card,facts:card.facts.map(fact=>fact.field==='available'?{...fact,value:900}:fact)}))};expect(()=>leaveAnswerExplanations(source,changed)).toThrow();
  expect(()=>leaveAnswerExplanations(source,{...presentation,module:'claims'})).toThrow();
 });
 it('withheld and absent eligibility stay unavailable rather than becoming inferred reasons or full derivation',()=>{
  expect(keys(outcome([{...row('no_eligibility_match'),eligibility:null}]))).toEqual(['leave_status:no_eligibility_match']);
  expect(keys(outcome([{...row('no_eligibility_match'),withheld:true,eligibility:notice()}]))).toEqual([]);
  expect(keys(outcome([]))).toEqual([]);
  for(const status of['not_generated','not_configured'] as const){const source=outcome([{...row(status),eligibility:notice()}]);expect(keys(source).some(code=>code.startsWith('leave_eligibility:')||code.startsWith('leave_rule:')||code.startsWith('leave_summary:'))).toBe(false);}
 });
 it('preserves authoritative inactive/no-rules/no-match verdicts without reconstructing branch precedence',()=>{
  for(const verdict of['not_active','no_rules','no_match'] as const){const n=notice(verdict);if(verdict==='not_active')n.activeAtDate=false;const source=outcome([{...row('no_eligibility_match'),eligibility:n}]);const descriptors=leaveAnswerExplanations(source,view(source));expect(descriptors.some(row=>row.code===`leave_eligibility:${verdict}`)).toBe(true);expect(descriptors.some(row=>row.code.startsWith('leave_rule:'))).toBe(verdict==='no_match');}
  for(const verdict of['resolved','sole_table','default_table'] as const){const source=outcome([{...row('no_eligibility_match'),eligibility:notice(verdict)}]);expect(keys(source)).toEqual(['leave_status:no_eligibility_match']);}
 });
 it('keeps expired/not-yet/table-stopped/in-force rules distinct, and never calls untested in-force eligible',()=>{
  const n=notice();n.rules=['matched','in_force','expired','not_yet','table_stopped'].map(state=>rule(state as EligibilityRuleNotice['state'],false));
  const source=outcome([{...row('no_eligibility_match'),eligibility:n}]),descriptors=leaveAnswerExplanations(source,view(source));
  const rules=descriptors.filter(row=>row.content.kind==='leave_rules');expect(rules.map(row=>row.code)).toEqual(['leave_rule:matched','leave_rule:in_force','leave_rule:expired','leave_rule:not_yet','leave_rule:table_stopped']);
  for(const entry of rules){if(entry.content.kind!=='leave_rules')throw Error('wrong descriptor');expect(entry.content.rules[0].tested).toBe(false);expect(entry.content.rules[0].axisLabel).toBe(null);expect(entry.content.rules[0].failsOnCombination).toBe(false);if(entry.content.state==='expired')expect(entry.content.rules[0].date).toBe('2026-06-30');if(entry.content.state==='not_yet')expect(entry.content.rules[0].date).toBe('2026-01-01');}
  const json=JSON.stringify(descriptors);for(const secret of['PRIVATE_AXIS_VALUE','private-lineage','/admin/private','failingAxisValue','href'])expect(json).not.toContain(secret);
 });
 it('only names a tested known axis label, preserves combination/undated caveats and omits missing expiry evidence',()=>{
  const n=notice();n.usesUndatedAxis=true;n.rules=[{...rule(),failsOnCombination:true}];const source=outcome([{...row('no_eligibility_match'),eligibility:n}]),descriptors=leaveAnswerExplanations(source,view(source));
  const r=descriptors.find(row=>row.content.kind==='leave_rules');if(r?.content.kind!=='leave_rules')throw Error('missing actual rule');expect(r.content.rules[0].axisLabel).toEqual({ns:'criteria',key:'jobGrade'});expect(r.content.rules[0].failsOnCombination).toBe(true);expect(keys(source)).toContain('leave_eligibility:undated_axes');
  n.rules=[{...rule(),failingAxis:'unrecognized_raw_axis'}];const unknown=outcome([{...row('no_eligibility_match'),eligibility:n}]);const u=leaveAnswerExplanations(unknown,view(unknown)).find(row=>row.content.kind==='leave_rules');if(u?.content.kind!=='leave_rules')throw Error('missing rule');expect(u.content.rules[0].axisLabel).toBe(null);
  const missing=outcome([{...row('no_eligibility_match'),eligibility:{...notice(),rules:[{...rule('expired'),validTo:null}]}}]);expect(keys(missing)).not.toContain('leave_rule:expired');
 });
 it('large rule sets retain the recorded verdict but never silently claim a complete selected rule explanation',()=>{
  const source=outcome([{...row('no_eligibility_match'),eligibility:{...notice(),rules:Array.from({length:ASSISTANT_EXPLANATION_LIMITS.rules+1},()=>rule())}}]);expect(keys(source)).toContain('leave_eligibility:no_match');expect(keys(source).some(code=>code.startsWith('leave_rule:'))).toBe(false);
 });
 it('uses an actual pure canonical specialist assessment and actual diagnostic, not globally enabled findings',()=>{
  const assessment=executeCanonicalSpecialist({kind:'canonical_specialist_v1',module:'claims',playbook:'canonical_followup_v1'},{module:'claims',capability:'own_claim_statuses',scope:'current-caller',data:{hasEmployment:true,truncated:false,claims:[{claimType:'Fictional Travel',status:'pending',paidAt:null}]}});
  const descriptors=specialistAnswerExplanations(assessment,assessment.presentation);expect(descriptors.some(row=>row.code==='specialist_finding:claim_pending_not_approved')).toBe(true);expect(descriptors.some(row=>row.code==='specialist_finding:claim_payment_recorded')).toBe(false);
  const selected=descriptors.find(row=>row.code==='specialist_followup:track_claim')!;expect(selected.card).toBe(0);expect(selected.content).toEqual({kind:'specialist_followup',followup:'track_claim',state:'recorded',recordNumber:1});
  const appended:JobPresentation={...assessment.presentation,cards:[...assessment.presentation.cards,{title:{kind:'module',module:'claims'},facts:[],href:'/assistant/claims',linkPurpose:'human_review'}]};expect(specialistAnswerExplanations(assessment,appended)).toEqual(descriptors);
  expect(()=>specialistAnswerExplanations(assessment,{...assessment.presentation,cards:[]})).toThrow();
  const duplicate={...assessment,findings:[...assessment.findings,...assessment.findings]};expect(()=>specialistAnswerExplanations(duplicate,assessment.presentation)).toThrow();
 });
 it('captures immutable descriptors/availability without source aliases, free text, raw values or fabricated codes',()=>{
  const source=outcome([{...row('no_eligibility_match'),eligibility:notice()}]),descriptors=leaveAnswerExplanations(source,view(source)),availability=assistantAnswerExplanationAvailability(descriptors);
  source.employments[0].eligibility!.rules[0].name='Changed after capture';expect(JSON.stringify(descriptors)).toContain('Fictional scheme');expect(JSON.stringify(descriptors)).not.toContain('Changed after capture');
  expect(Object.isFrozen(descriptors)&&Object.isFrozen(availability)).toBe(true);expect(descriptors.every(Object.isFrozen)).toBe(true);for(const entry of availability)expect(Object.keys(entry).sort()).toEqual(['card','code']);
  expect(()=>assistantAnswerExplanationAvailability([...descriptors,...descriptors])).toThrow();
 });
});
