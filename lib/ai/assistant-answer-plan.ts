/** A model selects references, never HR values or statement meaning. This pure boundary is not an
 * authority issuer: `current` MUST be built by the actual current-caller source owner, from the
 * executed read whose ORIGINAL source ordinal is `read`. Never pass posted/model catalogues here.
 * Adjudication returns immutable selectors only; current source owners/localized explainers render
 * their values. No provider, storage, arithmetic, URL, effect, permission or free-prose surface.
 */
import {JOB_FACT_FIELDS,type JobPresentation} from './module-jobs';
import {isAgentModuleCode} from './module-agents';
import {moduleHumanActionHandoffs} from './module-human-handoffs';
import {parseModuleAgentActionNomination,getModuleAgentAction} from './module-agent-actions';
import {ASSISTANT_PROPOSAL_MODULE,ASSISTANT_PROPOSAL_PROTOCOL,captureAssistantProposalHints,isAssistantProposableAction,type AssistantProposableAction,type AssistantProposalHints} from './assistant-action-proposal-hints';
import type {AgentModuleCode} from './module-agents';
import {SPECIALIST_FINDINGS,type SpecialistFinding} from './module-specialists';
import {FOLLOWUP_CODES,type FollowupCode} from './module-specialist-followup';
import {LEAVE_SUMMARY_EXPLAIN_KEYS,type LeaveSummaryExplainKey} from '../leave-summary-explain';
import {ENTITLEMENT_STATUS_LABEL_KEY,type EntitlementStatus,type EligibilityRuleNotice} from '../entitlement-status';

export const ANSWER_PLAN_LIMITS=Object.freeze({bytes:8192,reads:128,blocks:16,cards:25,presentationCards:26,factsPerCard:64,explanationsPerRead:512,textBytes:2000});
export const ASSISTANT_LEAVE_ELIGIBILITY_CODES=Object.freeze(['not_active','no_rules','no_match','undated_axes'] as const);
export const ASSISTANT_LEAVE_RULE_STATES=Object.freeze(['matched','in_force','expired','not_yet','table_stopped'] as const satisfies readonly EligibilityRuleNotice['state'][]);
export type AssistantExplanationCode=`leave_status:${EntitlementStatus}`|`leave_eligibility:${typeof ASSISTANT_LEAVE_ELIGIBILITY_CODES[number]}`|`leave_rule:${typeof ASSISTANT_LEAVE_RULE_STATES[number]}`|`specialist_finding:${SpecialistFinding}`|`specialist_followup:${FollowupCode}`|`leave_summary:${LeaveSummaryExplainKey}`;
export const ASSISTANT_EXPLANATION_CODES:readonly AssistantExplanationCode[]=Object.freeze([
 ...Object.keys(ENTITLEMENT_STATUS_LABEL_KEY).map(code=>`leave_status:${code as EntitlementStatus}` as const),
 ...ASSISTANT_LEAVE_ELIGIBILITY_CODES.map(code=>`leave_eligibility:${code}` as const),
 ...ASSISTANT_LEAVE_RULE_STATES.map(code=>`leave_rule:${code}` as const),
 ...SPECIALIST_FINDINGS.map(code=>`specialist_finding:${code}` as const),
 ...FOLLOWUP_CODES.map(code=>`specialist_followup:${code}` as const),
 ...LEAVE_SUMMARY_EXPLAIN_KEYS.map(code=>`leave_summary:${code}` as const),
]);
export const ASSISTANT_CLARIFICATION_SLOTS=Object.freeze(['employment','leave_type','period','module'] as const);
export type AssistantClarificationSlot=typeof ASSISTANT_CLARIFICATION_SLOTS[number];
export type AssistantAnswerBlock=Readonly<{kind:'fact';read:number;card:number;fact:number}>|
 Readonly<{kind:'explanation';read:number;card:number|null;code:AssistantExplanationCode}>;
export type AssistantAnswerPlan=Readonly<{version:1;mode:'answer';blocks:readonly AssistantAnswerBlock[]}>|
 Readonly<{version:1;mode:'clarify';slot:AssistantClarificationSlot}>|
 Readonly<{version:1;mode:'social';code:'greeting'|'thanks'|'help'}>|
 Readonly<{version:1;mode:'insufficient';code:'no_verified_facts'|'unsupported_explanation'}>|
 Readonly<{version:1;mode:'refuse';code:'unsupported_request'|'human_review_required'}>|
 /** ADR-0151 §4.3: a suggestion only. It names a declared, implemented, proposable action and typed
  * selectors; it prepares nothing, carries no ID or human text, and is adjudicated against the modules
  * the caller can currently read. The card resolves hints against the caller's own fresh choices. */
 Readonly<{version:1;mode:'propose';action:AssistantProposableAction;hints:AssistantProposalHints}>;
/** Current caller facts the propose mode needs; built by the caller's own source owner, never posted. */
export type AssistantAnswerAdjudication=Readonly<{readableModules?:readonly AgentModuleCode[];question?:string}>;
export type AssistantAnswerRead=Readonly<{read:number;presentation:JobPresentation;
 explanations:readonly Readonly<{card:number|null;code:AssistantExplanationCode}>[]}>;

/** Source-free copy is selected only by a complete local grammar. General help describes the
 * interaction, never installed capabilities, agent status or personal facts. Every clause must be
 * known: a harmless prefix does not consume arbitrary record requests or pasted instructions. */
export function assistantSocialIntent(question:unknown):'greeting'|'thanks'|'help'|null{
 if(typeof question!=='string'||question.length>500)return null;
 const normalized=question.normalize('NFC').trim().toLocaleLowerCase('en').replace(/[.!?。！？，,\s]+$/u,'').trim();
 const helpQuestions=[
  'what can you help me do','what can you help me with','what can you do','how can you help me',
  'i only want a short explanation of what you can help with','explain what you can help with',
  'apa yang boleh anda bantu','你可以帮我做什么','bạn có thể giúp tôi làm gì',
  'நீங்கள் எனக்கு என்ன உதவி செய்ய முடியும்','คุณช่วยอะไรฉันได้บ้าง',
 ];
 const helpQualifiers=['please keep it simple','keep it simple','please keep it simple and do not read personal records or make changes',
  'do not read personal records or make changes','no personal records please','do not retrieve records','do not read personal records',
  'please do not retrieve records','please do not read personal records','do not make changes'];
 const clauses=normalized.split(/[,.!?。！？，]+/u).map(part=>part.trim()).filter(Boolean);
 if(clauses.filter(part=>helpQuestions.includes(part)).length===1&&clauses.every(part=>helpQuestions.includes(part)||helpQualifiers.includes(part)||['hi','hello','hey'].includes(part)))return 'help';
 if(['hi','hello','hey','hi assistant','hello assistant','good morning','good afternoon','good evening','hai','helo','selamat pagi','selamat petang','selamat malam','你好','您好','嗨','早上好','xin chào','chào','வணக்கம்','สวัสดี','สวัสดีครับ','สวัสดีค่ะ'].includes(normalized))return 'greeting';
 if(['thanks','thank you','thankyou','terima kasih','谢谢','謝謝','多谢','多謝','cảm ơn','cảm ơn bạn','நன்றி','ขอบคุณ','ขอบคุณครับ','ขอบคุณค่ะ'].includes(normalized))return 'thanks';
 return null;
}

/** Keep the original read ordinal in the real tool catalogue. The model chooses ordering/focus;
 * code owns semantic clauses and canonical calculations. Unknown causes require insufficiency.
 */
export const ASSISTANT_ANSWER_PROTOCOL=[
 'Your final response must be one strict JSON object, without markdown or prose.',
 'Use exactly one of these shapes: {"version":1,"mode":"answer","blocks":[{"kind":"fact","read":0,"card":0,"fact":0}]}',
 'or {"version":1,"mode":"answer","blocks":[{"kind":"explanation","read":0,"card":null,"code":"<available exact code>"}]}',
 'or {"version":1,"mode":"clarify","slot":"employment|leave_type|period|module"}',
 'or {"version":1,"mode":"social","code":"greeting|thanks"}',
 'or {"version":1,"mode":"insufficient","code":"no_verified_facts|unsupported_explanation"}',
 'or {"version":1,"mode":"refuse","code":"unsupported_request|human_review_required"}',
 'or {"version":1,"mode":"propose","action":"<proposable action>","hints":{"<hint key>":"<value>"}}.',
 'Use social only for a standalone greeting or thanks, without reading HR records. A greeting mixed with a factual question still requires an answer from current sources; never disguise an HR/settings/effect request as social.',
 'Order 1 to 16 distinct fact/explanation blocks relevant to this question. The catalogue numbers original actual executed reads; use only its ordinals and available codes.',
 'A fact states only its recorded field. An explanation selects only its canonical clause for the same read/card (null means source-wide). Never infer causes, calculations, comparisons, decisions or permission reasons.',
 'Never invent or supply prose, HR values, URLs, effects or guessed selectors. Null, blank and omitted facts are unavailable; a partially withheld Leave card exposes only its remaining projected nonnull facts. Truncation proves neither absence nor all-clear.',
 'Clarify one missing selection using a slot only, without guessed choices. no_verified_facts requires no selectable evidence; unsupported_explanation means the requested meaning lacks support. Human review/confirmation remains separate.',
 'Use ordinary nonnegative integer ordinals and exact unescaped catalogue strings.',
 ASSISTANT_PROPOSAL_PROTOCOL,
].join(' ');

const explanationCodes=new Set<string>(ASSISTANT_EXPLANATION_CODES),factFields=new Set<string>(JOB_FACT_FIELDS);
const formats=new Set(['text','number','date','status','boolean','money','module','gap','blocks','performanceFramework','performanceArtifact','testingStatus']);
const fail=():never=>{throw Error('Assistant answer plan unavailable.');};
function object(value:unknown):Record<string,unknown>{
 if(value===null||typeof value!=='object'||Array.isArray(value))return fail();
 const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)return fail();
 for(const key of Reflect.ownKeys(value)){if(typeof key!=='string')return fail();const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!('value'in descriptor)||!descriptor.enumerable)return fail();}
 return value as Record<string,unknown>;
}
function exact(row:Record<string,unknown>,keys:readonly string[]):void{if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.hasOwn(row,key)))return fail();}
function array(value:unknown,max:number):readonly unknown[]{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>max)return fail();
 if(Reflect.ownKeys(value).length!==value.length+1)return fail();
 for(let index=0;index<value.length;index++){const d=Object.getOwnPropertyDescriptor(value,String(index));if(!d||!('value'in d)||!d.enumerable)return fail();}
 return value;
}
function ordinal(value:unknown,max:number):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||Object.is(value,-0)||value<0||value>=max)return fail();return value;}
function code(value:unknown):AssistantExplanationCode{if(typeof value!=='string'||!explanationCodes.has(value))return fail();return value as AssistantExplanationCode;}
const referenceKey=(block:AssistantAnswerBlock)=>block.kind==='fact'?`fact:${block.read}:${block.card}:${block.fact}`:`explanation:${block.read}:${block.card}:${block.code}`;

/** Capture before the caller awaits: no mutable caller object, prototype, getter or symbol survives. */
export function captureAssistantAnswerPlan(value:unknown):AssistantAnswerPlan{
 const row=object(value);if(row.version!==1)return fail();
 if(row.mode==='answer'){
  exact(row,['version','mode','blocks']);const blocks:AssistantAnswerBlock[]=[],seen=new Set<string>();
  for(const value of array(row.blocks,ANSWER_PLAN_LIMITS.blocks)){
   const item=object(value),read=ordinal(item.read,ANSWER_PLAN_LIMITS.reads);let block:AssistantAnswerBlock;
   if(item.kind==='fact'){exact(item,['kind','read','card','fact']);block=Object.freeze({kind:'fact',read,card:ordinal(item.card,ANSWER_PLAN_LIMITS.cards),fact:ordinal(item.fact,ANSWER_PLAN_LIMITS.factsPerCard)});}
   else if(item.kind==='explanation'){exact(item,['kind','read','card','code']);block=Object.freeze({kind:'explanation',read,card:item.card===null?null:ordinal(item.card,ANSWER_PLAN_LIMITS.cards),code:code(item.code)});}
   else return fail();
   const key=referenceKey(block);if(seen.has(key))return fail();seen.add(key);blocks.push(block);
  }
  if(!blocks.length)return fail();return Object.freeze({version:1,mode:'answer',blocks:Object.freeze(blocks)});
 }
 if(row.mode==='social'){exact(row,['version','mode','code']);if(row.code!=='greeting'&&row.code!=='thanks'&&row.code!=='help')return fail();return Object.freeze({version:1,mode:'social',code:row.code});}
 if(row.mode==='clarify'){
  exact(row,['version','mode','slot']);if(!ASSISTANT_CLARIFICATION_SLOTS.includes(row.slot as AssistantClarificationSlot))return fail();
  return Object.freeze({version:1,mode:'clarify',slot:row.slot as AssistantClarificationSlot});
 }
 if(row.mode==='insufficient'){
  exact(row,['version','mode','code']);if(row.code!=='no_verified_facts'&&row.code!=='unsupported_explanation')return fail();
  return Object.freeze({version:1,mode:'insufficient',code:row.code});
 }
 if(row.mode==='refuse'){
  exact(row,['version','mode','code']);if(row.code!=='unsupported_request'&&row.code!=='human_review_required')return fail();
  return Object.freeze({version:1,mode:'refuse',code:row.code});
 }
 if(row.mode==='propose'){
  exact(row,['version','mode','action','hints']);const action=row.action;if(!isAssistantProposableAction(action))return fail();
  // The closed proposal list is not authority by itself: the action must still be a declared,
  // implemented, human-selected prepare nomination for its own module, with no effect at nomination.
  const module=ASSISTANT_PROPOSAL_MODULE[action],declared=getModuleAgentAction(module,action);
  if(declared?.prepare.status!=='implemented'||declared.confirm.status!=='implemented')return fail();
  let hints:AssistantProposalHints;
  try{
   const nomination=parseModuleAgentActionNomination({module,action,phase:'prepare'});
   if(nomination.kind!=='prepare'||nomination.module!==module||nomination.action!==action||nomination.effect!=='none'||nomination.requiresHumanSelection!==true)return fail();
   hints=captureAssistantProposalHints(action,row.hints);
  }catch{return fail();}
  return Object.freeze({version:1,mode:'propose',action,hints});
 }
 return fail();
}

/** Canonical JSON spelling also rejects duplicate keys, ambiguous numeric spellings and escaped
 * selector aliases. Only structural JSON whitespace is ignored; string bytes are never rewritten.
 */
export function parseAssistantAnswerPlan(text:unknown):AssistantAnswerPlan{
 try{
  if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>ANSWER_PLAN_LIMITS.bytes)return fail();
  const value:unknown=JSON.parse(text);let compact='',quoted=false,escaped=false;
  for(const character of text){if(quoted){compact+=character;if(escaped)escaped=false;else if(character==='\\')escaped=true;else if(character==='"')quoted=false;}
   else if(character==='"'){quoted=true;compact+=character;}else if(![' ','\t','\r','\n'].includes(character))compact+=character;}
  if(compact!==JSON.stringify(value))return fail();return captureAssistantAnswerPlan(value);
 }catch{return fail();}
}

type CurrentRead=Readonly<{read:number;cards:readonly Readonly<{withheld:boolean;facts:readonly Readonly<{known:boolean}>[]}>[];explanations:ReadonlySet<string>}>;
function currentReads(input:readonly AssistantAnswerRead[]):readonly CurrentRead[]{
 const reads:CurrentRead[]=[],seen=new Set<number>();
 for(const value of array(input,ANSWER_PLAN_LIMITS.reads)){
  const row=object(value);exact(row,['read','presentation','explanations']);const read=ordinal(row.read,ANSWER_PLAN_LIMITS.reads);if(seen.has(read))return fail();seen.add(read);
  const p=object(row.presentation);exact(p,['module','cards','truncated',...(Object.hasOwn(p,'hasEmployment')?['hasEmployment']:[])]);
  if(!isAgentModuleCode(p.module)||typeof p.truncated!=='boolean'||Object.hasOwn(p,'hasEmployment')&&typeof p.hasEmployment!=='boolean')return fail();
  const cards:CurrentRead['cards'][number][]=[];
  for(const value of array(p.cards,ANSWER_PLAN_LIMITS.presentationCards)){
   const card=object(value);
   // The actual module presenter appends one deduplicated, source-owned human handoff. It is
   // not a 26th fact selector or effect capability; future/unknown extra cards fail closed.
   if(cards.length>=ANSWER_PLAN_LIMITS.cards&&(!Array.isArray(card.facts)||card.facts.length!==0||card.linkPurpose!=='human_review'||typeof card.href!=='string'||!moduleHumanActionHandoffs(p.module).some(handoff=>handoff.route===card.href)))return fail();if(card.withheld!==undefined&&typeof card.withheld!=='boolean')return fail();
   const facts:Readonly<{known:boolean}>[]=[];
   for(const value of array(card.facts,ANSWER_PLAN_LIMITS.factsPerCard)){
    const fact=object(value);exact(fact,['field','value','format']);if(typeof fact.field!=='string'||!factFields.has(fact.field)||typeof fact.format!=='string'||!formats.has(fact.format))return fail();
    const v=fact.value;if(v!==null&&typeof v!=='string'&&typeof v!=='boolean'&&typeof v!=='number')return fail();
    if(typeof v==='number'&&!Number.isFinite(v)||typeof v==='string'&&Buffer.byteLength(v,'utf8')>ANSWER_PLAN_LIMITS.textBytes)return fail();
    // Mine Leave hides individual fields as null/omission and marks a partially hidden card.
    // Other modules have no such fieldwise disclosure contract: their withheld cards stay closed.
    facts.push(Object.freeze({known:(card.withheld!==true||p.module==='leave')&&v!==null&&(typeof v!=='string'||v.trim().length>0)}));
   }
   cards.push(Object.freeze({withheld:card.withheld===true,facts:Object.freeze(facts)}));
  }
  const explanations=new Set<string>();
  for(const value of array(row.explanations,ANSWER_PLAN_LIMITS.explanationsPerRead)){
   const e=object(value);exact(e,['card','code']);const card=e.card===null?null:ordinal(e.card,ANSWER_PLAN_LIMITS.cards),c=code(e.code);if(['leave_summary:','leave_status:','leave_eligibility:','leave_rule:'].some(prefix=>c.startsWith(prefix))&&p.module!=='leave')return fail();
   if(card!==null&&(!cards[card]||cards[card].withheld))return fail();
   const key=`${card}:${c}`;if(explanations.has(key))return fail();explanations.add(key);
  }
  reads.push(Object.freeze({read,cards:Object.freeze(cards),explanations}));
 }
 return Object.freeze(reads);
}

/** This validates selector meaning/availability, not model prose or arbitrary causal assertions.
 * Known global codes are never evidence by themselves. The exact source owner supplies availability;
 * hidden/null facts cannot become assertions; permitted projected Mine fields remain selectable. A truncated read may still state an individual fact.
 */
export function adjudicateAssistantAnswerPlan(value:unknown,current:readonly AssistantAnswerRead[],caller:AssistantAnswerAdjudication={}):AssistantAnswerPlan{
 const plan=captureAssistantAnswerPlan(value),reads=currentReads(current),byRead=new Map(reads.map(read=>[read.read,read]));
 if(plan.mode==='social'){if(reads.length!==0||assistantSocialIntent(caller.question)!==plan.code)return fail();return plan;}
 // A proposal fails closed like any other unsupported plan unless the current caller can read its module.
 if(plan.mode==='propose'){const readable=caller.readableModules;if(!Array.isArray(readable)||!readable.includes(ASSISTANT_PROPOSAL_MODULE[plan.action]))return fail();return plan;}
 if(plan.mode==='answer')for(const block of plan.blocks){
  const read=byRead.get(block.read);if(!read)return fail();
  if(block.kind==='fact'){const card=read.cards[block.card];if(!card||!card.facts[block.fact]?.known)return fail();}
  else if(!read.explanations.has(`${block.card}:${block.code}`))return fail();
 }
 else if(plan.mode==='insufficient'&&plan.code==='no_verified_facts'&&reads.some(read=>read.explanations.size>0||read.cards.some(card=>card.facts.some(fact=>fact.known))))return fail();
 return plan;
}
