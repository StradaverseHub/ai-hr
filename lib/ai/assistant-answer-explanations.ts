/** Source-owned meaning for model-selected clauses. Values are captured here from the actual tool or
 * actual canonical specialist result, never accepted from a terminal model plan. The caller must
 * retain its current principal/source proof through rendering; this pure projection issues none.
 * No entitlement resolver, money arithmetic, provider, persistence, effect or admin href is added.
 */
import {projectLeaveAnswerEvidence} from './leave-answer-evidence';
import {presentGroundedToolOutcome} from './grounded-tool-presentation';
import type {JobPresentation} from './module-jobs';
import {SPECIALIST_FINDINGS,type SpecialistAssessment,type SpecialistFinding} from './module-specialists';
import {FOLLOWUP_CODES,type FollowupCode,type SpecialistDiagnostic} from './module-specialist-followup';
import {ASSISTANT_EXPLANATION_CODES,ASSISTANT_LEAVE_RULE_STATES,type AssistantExplanationCode} from './assistant-answer-plan';
import type {EntitlementStatus,EligibilityRuleNotice} from '../entitlement-status';

export type AssistantAnswerExplanationContent=
 Readonly<{kind:'leave_status';status:EntitlementStatus;labelKey:string;tipKey:string|null}>|
 Readonly<{kind:'leave_eligibility';verdict:'not_active'|'no_rules'|'no_match';key:'eligibilityNotActive'|'eligibilityNoRules'|'eligibilityRulesTitle';asOf:string}>|
 Readonly<{kind:'leave_undated';key:'eligibilityUndatedNote'}>|
 Readonly<{kind:'leave_rules';state:EligibilityRuleNotice['state'];key:typeof RULE_KEYS[EligibilityRuleNotice['state']];rules:readonly Readonly<{
  name:string;date:string|null;tested:boolean;axisLabel:Readonly<{ns:'criteria'|'orgCategory';key:string}>|null;failsOnCombination:boolean;
 }>[]}>|
 Readonly<{kind:'specialist_finding';finding:SpecialistFinding}>|
 Readonly<{kind:'specialist_followup';followup:FollowupCode;state:SpecialistDiagnostic['state'];recordNumber:number|null}>;
export type AssistantAnswerExplanation=Readonly<{card:number|null;code:AssistantExplanationCode;content:AssistantAnswerExplanationContent}>;
export const ASSISTANT_EXPLANATION_LIMITS=Object.freeze({rules:100,cards:25});
// Existing leave.breakdown copy keys in LeaveDetailsPanel. State is copied, not eligibility inferred.
const RULE_KEYS=Object.freeze({matched:'eligibilityStateMatched',in_force:'eligibilityStateInForce',expired:'eligibilityStateExpired',not_yet:'eligibilityStateNotYet',table_stopped:'eligibilityStateTableStopped'} as const);
const knownCodes=new Set<string>(ASSISTANT_EXPLANATION_CODES),findings=new Set<string>(SPECIALIST_FINDINGS),followups=new Set<string>(FOLLOWUP_CODES);
const fail=():never=>{throw Error('Assistant explanation evidence unavailable.');};
function frozen<T extends object>(value:T):Readonly<T>{return Object.freeze(value);}
function add(result:AssistantAnswerExplanation[],card:number|null,code:AssistantExplanationCode,content:AssistantAnswerExplanationContent){
 if(!knownCodes.has(code)||result.some(row=>row.card===card&&row.code===code))return fail();result.push(frozen({card,code,content:frozen(content)}));
}

/** Exact presentation equality ties the employment/leave-type rows to their actual card ordinal.
 * not_configured means an absent breakdown, NOT proof of no table: offer no asserted status for it.
 * Withheld rows retain the existing ordinary cards, but gain no model-selectable explanation here.
 */
export function leaveAnswerExplanations(outcome:unknown,presentation:JobPresentation):readonly AssistantAnswerExplanation[]{
 const expected=presentGroundedToolOutcome('leave_entitlement_explain',outcome);
 if(!expected||JSON.stringify(expected)!==JSON.stringify(presentation))return fail();
 const evidence=projectLeaveAnswerEvidence(outcome);if(!evidence)return frozen([]);
 if(evidence.employments.length!==presentation.cards.length)return fail();
 const result:AssistantAnswerExplanation[]=[];
 evidence.employments.forEach((row,card)=>{
  if(row.withheld||presentation.cards[card].withheld)return;
  if(row.entitlement.status!=='not_configured')add(result,card,`leave_status:${row.entitlement.status}`,{kind:'leave_status',status:row.entitlement.status,labelKey:row.entitlement.labelKey,tipKey:row.entitlement.tipKey});
  const eligibility=row.eligibility;if(!eligibility)return; // UNKNOWN, never absence or a guessed match.
  // core/read attaches this notice only for no_eligibility_match. Other verdicts need their own
  // winning-table sentence contract; do not invent one from a table name or zero days.
  if(row.entitlement.status!=='no_eligibility_match')return;
  const verdict=eligibility.verdict;
  if(verdict==='not_active'||verdict==='no_rules'||verdict==='no_match'){
   const key=verdict==='not_active'?'eligibilityNotActive':verdict==='no_rules'?'eligibilityNoRules':'eligibilityRulesTitle';
   add(result,card,`leave_eligibility:${verdict}`,{kind:'leave_eligibility',verdict,key,asOf:evidence.asOf});
   if(eligibility.usesUndatedAxis)add(result,card,'leave_eligibility:undated_axes',{kind:'leave_undated',key:'eligibilityUndatedNote'});
  }
  if(verdict!=='no_match'||eligibility.rules.length>ASSISTANT_EXPLANATION_LIMITS.rules)return;
  for(const state of ASSISTANT_LEAVE_RULE_STATES){
   const matching=eligibility.rules.filter(rule=>rule.state===state);if(!matching.length)continue;
   // An expired rule without an end date cannot support the existing dated expired sentence.
   if(state==='expired'&&matching.some(rule=>rule.validTo===null))continue;
   const rules=matching.map(rule=>frozen({name:rule.name,date:state==='expired'?rule.validTo:state==='not_yet'?rule.validFrom:null,
    tested:rule.tested,axisLabel:rule.tested&&rule.failingAxisLabel?frozen({...rule.failingAxisLabel}):null,
    failsOnCombination:rule.tested&&rule.failsOnCombination}));
   add(result,card,`leave_rule:${state}`,{kind:'leave_rules',state,key:RULE_KEYS[state],rules:frozen(rules)});
  }
 });
 return frozen(result);
}

/** Source-owned findings are already adjudicated by executeCanonicalSpecialist. They apply to that
 * exact bounded source, not every employee or a hidden record. The actual diagnostic retains its
 * record association; routes/evidence paths/effects are deliberately not copied to the answer DTO.
 */
export function specialistAnswerExplanations(assessment:SpecialistAssessment,presentation:JobPresentation):readonly AssistantAnswerExplanation[]{
 if(!assessment||assessment.version!==1||assessment.coverage!=='canonical_domain_guidance_only'||assessment.requiresFreshNativeReview!==true||
  !Array.isArray(assessment.effects)||assessment.effects.length||assessment.module!==presentation.module||
  assessment.presentation.module!==presentation.module||assessment.presentation.truncated!==presentation.truncated||
  assessment.presentation.hasEmployment!==presentation.hasEmployment||assessment.presentation.cards.length>presentation.cards.length||
  JSON.stringify(assessment.presentation.cards)!==JSON.stringify(presentation.cards.slice(0,assessment.presentation.cards.length))||
  !Array.isArray(assessment.findings)||new Set(assessment.findings).size!==assessment.findings.length||assessment.findings.some(code=>!findings.has(code)))return fail();
 const result:AssistantAnswerExplanation[]=[];
 for(const finding of assessment.findings)add(result,null,`specialist_finding:${finding}`,{kind:'specialist_finding',finding});
 const d=assessment.diagnostic;if(d){
  if(d.version!==1||d.effect!=='none'||d.requiresHumanIntent!==true||!followups.has(d.code)||!['review','recorded','insufficient','no_followup'].includes(d.state)||
   d.recordNumber!==null&&(!Number.isSafeInteger(d.recordNumber)||d.recordNumber<1||d.recordNumber>assessment.presentation.cards.length))return fail();
  const card=d.recordNumber===null?null:d.recordNumber-1;
  if(card===null||!assessment.presentation.cards[card].withheld)add(result,card,`specialist_followup:${d.code}`,{kind:'specialist_followup',followup:d.code,state:d.state,recordNumber:d.recordNumber});
 }
 return frozen(result);
}

/** Prompt/disclosure catalogue contains selectors only. Render the separately source-owned descriptor
 * AFTER actual current replay, never one returned from a browser, model or historical JSON body.
 */
export function assistantAnswerExplanationAvailability(entries:readonly AssistantAnswerExplanation[]):readonly Readonly<{card:number|null;code:AssistantExplanationCode}>[]{
 if(!Array.isArray(entries)||entries.length>512)return fail();const seen=new Set<string>();
 return frozen(entries.map(row=>{if(!knownCodes.has(row.code)||row.card!==null&&(!Number.isSafeInteger(row.card)||row.card<0||row.card>=ASSISTANT_EXPLANATION_LIMITS.cards))return fail();const key=`${row.card}:${row.code}`;if(seen.has(key))return fail();seen.add(key);return frozen({card:row.card,code:row.code});}));
}
