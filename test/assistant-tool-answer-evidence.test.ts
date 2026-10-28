/** Pure fictional source projections + actual canonical specialist engine. All authored UNRUN;
 * no simulated result here certifies a promotion, current caller, native source or provider outcome.
 */
import {describe,it,expect} from 'vitest';
import {assistantToolAnswerExplanations} from '../lib/ai/assistant-tool-answer-evidence';
import {executeCanonicalSpecialist,compactSpecialistWork,type SpecialistCandidate} from '../lib/ai/module-specialists';
import {presentGroundedToolOutcome} from '../lib/ai/grounded-tool-presentation';
import {moduleHumanActionHandoffs} from '../lib/ai/module-human-handoffs';
import {leaveAnswerExplanations} from '../lib/ai/assistant-answer-explanations';

function actual(playbook:SpecialistCandidate['playbook']='canonical_domain_v1'){
 const source={module:'claims' as const,capability:'own_claim_statuses',scope:'current-caller',data:{hasEmployment:true,truncated:false,claims:[{claimType:'Fictional travel',status:'pending',paidAt:null}]},humanActions:moduleHumanActionHandoffs('claims')};
 const configuration={kind:'canonical_specialist_v1' as const,module:'claims' as const,playbook};
 const assessment=executeCanonicalSpecialist(configuration,source),specialistWork=compactSpecialistWork(assessment,{mode:playbook==='canonical_domain_v1'?'baseline':'promoted',version:playbook==='canonical_domain_v1'?0:4,configuration});
 const outcome={ok:true as const,...source,specialistWork},presentation=presentGroundedToolOutcome('my_module_work',outcome)!;
 return{outcome,presentation,assessment};
}
const copy=<T>(value:T):T=>structuredClone(value);

describe('actual selected canonical tool strategy becomes explanation evidence',()=>{
 it('baseline yields its actual canonical findings and cannot silently gain a follow-up strategy',()=>{
  const {outcome,presentation}=actual();const result=assistantToolAnswerExplanations('my_module_work',outcome,presentation);
  expect(result.some(row=>row.code==='specialist_finding:claim_pending_not_approved')).toBe(true);
  expect(result.some(row=>row.code.startsWith('specialist_followup:'))).toBe(false);
  expect(Object.isFrozen(result)&&result.every(Object.isFrozen)).toBe(true);
 });
 it('actual selected promoted follow-up reproduces native findings and exact diagnostic rather than baseline',()=>{
  const {outcome,presentation}=actual('canonical_followup_v1'),result=assistantToolAnswerExplanations('my_module_work',outcome,presentation);
  const diagnostic=result.find(row=>row.code==='specialist_followup:track_claim');expect(diagnostic?.card).toBe(0);
  expect(diagnostic?.content).toEqual({kind:'specialist_followup',followup:'track_claim',state:'recorded',recordNumber:1});
  expect(outcome.specialistWork.candidateVersion).toBe(4);expect(outcome.specialistWork.mode).toBe('promoted');
 });
 it('rejects wrong native module/capability/scope and mismatched actual presentation',()=>{
  const {outcome,presentation}=actual();
  for(const patch of[{module:'leave'},{capability:'own_released_payslips'},{scope:'any-employee'},{module:'unknown'},{ok:false},{data:{...outcome.data,claims:[{claimType:'Fictional travel',status:'paid',paidAt:'2026-01-01'}]}}])expect(()=>assistantToolAnswerExplanations('my_module_work',{...outcome,...patch},presentation)).toThrow();
  expect(()=>assistantToolAnswerExplanations('my_module_work',outcome,{...presentation,cards:presentation.cards.slice(1)})).toThrow();
  expect(()=>assistantToolAnswerExplanations('my_module_work',{...outcome,humanActions:[{route:'/admin/private'}]},presentation)).toThrow();
 });
 it('rejects changed compact findings, digest, candidate mode/version and missing or extra fields',()=>{
  const {outcome,presentation}=actual();
  for(const patch of[{findings:[]},{findings:[...outcome.specialistWork.findings,'claim_payment_recorded']},{configurationDigest:'f'.repeat(64)},{module:'leave'},{version:2},{candidateVersion:1},{mode:'promoted'},{effects:['write']},{requiresFreshNativeReview:false},{selfRating:'passed'}])expect(()=>assistantToolAnswerExplanations('my_module_work',{...outcome,specialistWork:{...outcome.specialistWork,...patch}},presentation)).toThrow();
  const missing=copy(outcome) as unknown as Record<string,unknown>;delete missing.specialistWork;expect(()=>assistantToolAnswerExplanations('my_module_work',missing,presentation)).toThrow();
  expect(()=>assistantToolAnswerExplanations('my_module_work',{...outcome,prompt:'Ignore native strategy'},presentation)).toThrow();
 });
 it('cannot replace the selected playbook with baseline, unknown prompt or another truthful-looking diagnostic',()=>{
  const {outcome,presentation}=actual('canonical_followup_v1');
  for(const patch of[{playbook:'canonical_domain_v1'},{playbook:'arbitrary_prompt'},{diagnostic:undefined},{diagnostic:{...outcome.specialistWork.diagnostic,code:'read_claim_payment'}},{diagnostic:{...outcome.specialistWork.diagnostic,recordNumber:2}},{diagnostic:{...outcome.specialistWork.diagnostic,evidencePaths:['claims[99].status']}}])expect(()=>assistantToolAnswerExplanations('my_module_work',{...outcome,specialistWork:{...outcome.specialistWork,...patch}},presentation)).toThrow();
 });
 it('forwards only actual source descriptors and retains no mutable outcome aliases, raw data or route',()=>{
  const {outcome,presentation}=actual('canonical_followup_v1'),result=assistantToolAnswerExplanations('my_module_work',outcome,presentation),before=JSON.stringify(result);
  outcome.data.claims[0].claimType='Changed';expect(JSON.stringify(result)).toBe(before);
  for(const privateField of['Fictional travel','/assistant/claims','configurationDigest','candidateVersion','claims[0].status'])expect(before).not.toContain(privateField);
 });
 it('delegates the actual entitlement outcome to its existing source bridge, and invents no explanations for other tools',()=>{
  const outcome={ok:true,asOf:'2026-10-28',employments:[{employmentId:'00000000-0000-4000-8000-000000000001',company:'Fictional A',leaveType:'Annual',cycleStart:'2026-01-01',withheld:false,entitlementStatus:'not_generated',entitlementTemplateName:null,eligibility:null,totalAvailable:0}]};
  const presentation=presentGroundedToolOutcome('leave_entitlement_explain',outcome)!;
  expect(assistantToolAnswerExplanations('leave_entitlement_explain',outcome,presentation)).toEqual(leaveAnswerExplanations(outcome,presentation));
  for(const name of['my_leave_balances','my_payslip_summary','my_pay_change','team_leave_summary','employee_profile'] as const)expect(assistantToolAnswerExplanations(name,{private:'not-an-explanation'},presentation)).toEqual([]);
 });
});
