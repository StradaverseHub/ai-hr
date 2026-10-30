/** A selected clause consumes an original fresh source-owned descriptor, never model prose or a
 * posted/copied JSON explanation. Canonical engines own the verdict; this component names it only. */
import {getTranslations} from 'next-intl/server';
import {AssistantCatalogueSummary} from './assistant-catalogue-summary';
import type {SessionContext} from '../../db/client';
import {assertCanonicalModuleJobView,type CanonicalModuleJobView} from '../../core/workspace-module-jobs';
import type {AssistantAnswerExplanation} from '../../lib/ai/assistant-answer-explanations';
import {ENTITLEMENT_STATUS_LABEL_KEY,ENTITLEMENT_STATUS_TIP_KEY,ELIGIBILITY_AXIS_LABEL_KEY} from '../../lib/entitlement-status';
import {SPECIALIST_FINDINGS} from '../../lib/ai/module-specialists';
import {FOLLOWUP_CODES} from '../../lib/ai/module-specialist-followup';
const ruleKeys={matched:'eligibilityStateMatched',in_force:'eligibilityStateInForce',expired:'eligibilityStateExpired',not_yet:'eligibilityStateNotYet',table_stopped:'eligibilityStateTableStopped'} as const;
const dateOnly=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
/** Dates follow LeaveDetailsPanel's default dateText: recorded ISO date, no inferred effective date.
 * Failed axes use the shared editor label only; raw criteria values never enter this descriptor. */
export async function ConversationExplanation({view,explanation,ctx}:{view:CanonicalModuleJobView;explanation:AssistantAnswerExplanation;ctx:SessionContext}){
 const copy=await getTranslations('assistant.workspace.conversation');
 const unavailable=()=> <p role="status" className="text-sm text-muted-foreground">{copy('unavailable')}</p>;
 try{
  assertCanonicalModuleJobView(view,ctx);
  if(view.state!=='ready'||!Array.isArray(view.answerExplanations)||!view.answerExplanations.includes(explanation))return unavailable();
  const c=explanation.content,card=explanation.card;
  if(card!==null&&(!Number.isSafeInteger(card)||card<0||!view.presentation.cards[card]||view.presentation.cards[card].withheld))return unavailable();
  if(c.kind.startsWith('leave_')){
   if(view.presentation.module!=='leave'||view.toolName!=='leave_entitlement_explain'||card===null)return unavailable();
   if(c.kind!=='leave_status'&&!view.answerExplanations.some(row=>row.card===card&&row.content.kind==='leave_status'&&row.content.status==='no_eligibility_match'&&row.code==='leave_status:no_eligibility_match'))return unavailable();
  }
  if(c.kind==='leave_status'){
   if(!Object.hasOwn(ENTITLEMENT_STATUS_LABEL_KEY,c.status)||c.status==='not_configured'||explanation.code!==`leave_status:${c.status}`||c.labelKey!==ENTITLEMENT_STATUS_LABEL_KEY[c.status]||c.tipKey!==(ENTITLEMENT_STATUS_TIP_KEY[c.status]??null))return unavailable();
   const t=await getTranslations('me.leaveBalanceTable');return <div className="space-y-1 text-sm"><p className="font-medium">{t(c.labelKey)}</p>{c.tipKey&&<p>{t(c.tipKey)}</p>}</div>;
  }
  if(c.kind==='leave_eligibility'){
   const key=c.verdict==='not_active'?'eligibilityNotActive':c.verdict==='no_rules'?'eligibilityNoRules':c.verdict==='no_match'?'eligibilityRulesTitle':null;
   if(!key||c.key!==key||explanation.code!==`leave_eligibility:${c.verdict}`||!dateOnly(c.asOf))return unavailable();
   const t=await getTranslations('leave.breakdown');return <p className="text-sm">{t(key,{date:c.asOf})}</p>;
  }
  if(c.kind==='leave_undated'){
   if(c.key!=='eligibilityUndatedNote'||explanation.code!=='leave_eligibility:undated_axes')return unavailable();
   const t=await getTranslations('leave.breakdown');return <p className="text-sm">{t('eligibilityUndatedNote')}</p>;
  }
  if(c.kind==='leave_rules'){
   if(!Object.hasOwn(ruleKeys,c.state)||c.key!==ruleKeys[c.state]||explanation.code!==`leave_rule:${c.state}`||!Array.isArray(c.rules)||c.rules.length===0||c.rules.length>100)return unavailable();
   const[t,criteria,org]=await Promise.all([getTranslations('leave.breakdown'),getTranslations('admin.leave.adjustmentsCriteria'),getTranslations('admin.profileOptions.category')]);
   const rows=c.rules.map((rule,index)=>{
    if(typeof rule.name!=='string'||rule.name.trim()===''||rule.name.length>500||typeof rule.tested!=='boolean'||typeof rule.failsOnCombination!=='boolean'||rule.failsOnCombination&&!rule.tested)throw Error();
    const dated=c.state==='expired'||c.state==='not_yet';if(dated?!dateOnly(rule.date):rule.date!==null)throw Error();
    let axis:string|null=null;if(rule.axisLabel){const label=rule.axisLabel;if(!rule.tested||!Object.values(ELIGIBILITY_AXIS_LABEL_KEY).some(value=>value.ns===label.ns&&value.key===label.key))throw Error();axis=label.ns==='criteria'?criteria(label.key):org(label.key);}
    return <p key={index} className="text-sm"><span className="font-medium">{rule.name}</span>{' — '}{t(c.key,{date:rule.date??''})}{axis&&<span className="block">{t('eligibilityWhyAxis',{axis})}</span>}{rule.failsOnCombination&&<span className="block">{t('eligibilityWhyCombination')}</span>}</p>;
   });return <div className="space-y-2">{rows.slice(0,3)}{rows.length>3&&<details className="rounded-md border p-3"><summary className="min-h-11 cursor-pointer py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{copy('moreRules',{count:rows.length-3})}</summary><div className="mt-2 space-y-2">{rows.slice(3)}</div></details>}</div>;
  }
  if(c.kind==='specialist_finding'){
   if(!SPECIALIST_FINDINGS.includes(c.finding)||explanation.code!==`specialist_finding:${c.finding}`||!view.specialist?.findings.includes(c.finding))return unavailable();
   if(c.finding==='catalogue_not_permission'&&view.presentation.module==='assistant')return await AssistantCatalogueSummary({view,ctx})??unavailable();
   const t=await getTranslations('assistant.workspace.specialistFindings');return <p className="text-sm">{t(c.finding)}</p>;
  }
  if(c.kind==='specialist_followup'){
   const d=view.specialist?.diagnostic;if(!FOLLOWUP_CODES.includes(c.followup)||explanation.code!==`specialist_followup:${c.followup}`||!['review','recorded','insufficient','no_followup'].includes(c.state)||!d||d.code!==c.followup||d.state!==c.state||d.recordNumber!==c.recordNumber||c.recordNumber!==null&&(!Number.isSafeInteger(c.recordNumber)||c.recordNumber<1||c.recordNumber>view.presentation.cards.length))return unavailable();
   const t=await getTranslations('assistant.workspace.specialists');return <div className="space-y-1 text-sm"><p>{t(`diagnosticState_${c.state}`)}</p>{c.recordNumber!==null&&<p>{t('diagnosticRecord',{n:c.recordNumber})}</p>}</div>;
  }
  return unavailable();
 }catch{return unavailable();}
}
