/** Closed Assistant disclosure: user language and canonical values stay local. The provider may
 * prioritize per-request ordinal references only; it cannot read a question, identity, date or amount. */
import {createHash} from 'node:crypto';
import {types as nodeTypes} from 'node:util';
import {z} from 'zod';
import {adjudicatePromptReadPlan} from './module-agent-prompt-candidate';
import {isCalendarDate} from '../calendar-date';
import {AiGatewayError,type ConverseArgs,type GenerateArgs} from './types';
import {AGENT_MODULE_CODES,type AgentModuleCode} from './module-agents';
import {JOB_FACT_FIELDS} from './module-jobs';
import {ASSISTANT_EXPLANATION_CODES,assistantSocialIntent,parseAssistantAnswerPlan,type AssistantAnswerPlan,type AssistantAnswerRead} from './assistant-answer-plan';
import en from '../../messages/en.json';import ms from '../../messages/ms.json';import zh from '../../messages/zh.json';import vi from '../../messages/vi.json';import ta from '../../messages/ta.json';import th from '../../messages/th.json';
export const ASSISTANT_PRIVATE_CONTRACT='assistant_closed_references_v1' as const;
export const PRIVATE_ASSISTANT_INTENTS=Object.freeze(['module_overview','leave_available','leave_taken','leave_pending','leave_requests','claim_statuses','holidays','reporting_line','work_profile','payslip','pay_change','attendance','performance','notifications','approvals','toil','lifecycle','knowledge_base','rewards'] as const);
export type PrivateAssistantIntent=typeof PRIVATE_ASSISTANT_INTENTS[number];
const ordinal=z.number().int().min(0),explanation=z.enum(ASSISTANT_EXPLANATION_CODES as [typeof ASSISTANT_EXPLANATION_CODES[number],...typeof ASSISTANT_EXPLANATION_CODES[number][]]);
const read=z.object({read:ordinal.max(7),module:z.enum(AGENT_MODULE_CODES as [AgentModuleCode,...AgentModuleCode[]]),cards:z.array(z.object({card:ordinal.max(24),facts:z.array(z.object({fact:ordinal.max(63),field:z.enum(JOB_FACT_FIELDS),available:z.boolean()}).strict()).max(64)}).strict()).max(25),explanations:z.array(z.object({card:ordinal.max(24).nullable(),code:explanation}).strict()).max(512)}).strict();
const payload=z.discriminatedUnion('operation',[
 z.object({version:z.literal(1),operation:z.literal('conversation'),intent:z.enum(PRIVATE_ASSISTANT_INTENTS),reads:z.array(read).max(8)}).strict(),
 z.object({version:z.literal(1),operation:z.literal('draft'),intent:z.enum(PRIVATE_ASSISTANT_INTENTS),modules:z.array(z.enum(AGENT_MODULE_CODES as [AgentModuleCode,...AgentModuleCode[]])).min(1).max(4)}).strict(),
]);
export type PrivateAssistantPayload=z.infer<typeof payload>;
const fail=():never=>{throw new AiGatewayError('The private Assistant request could not be confirmed.');};
function capture(value:unknown):PrivateAssistantPayload{
 let nodes=0;
 const copy=(value:unknown,depth:number):unknown=>{
  if(++nodes>20000||depth>15)return fail();
  if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number')return Number.isFinite(value)?value:fail();
  if(!value||typeof value!=='object'||nodeTypes.isProxy(value))return fail();
  const entries=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(entries);
  if(Array.isArray(value)){if(Object.getPrototypeOf(value)!==Array.prototype||keys.length!==value.length+1)return fail();return Array.from({length:value.length},(_,index)=>{const item=entries[String(index)];if(!item||!('value'in item))return fail();return copy(item.value,depth+1);});}
  if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))return fail();const result=Object.create(null) as Record<string,unknown>;
  for(const key of keys){const item=entries[key as string];if(typeof key!=='string'||!item?.enumerable||!('value'in item))return fail();result[key]=copy(item.value,depth+1);}return result;
 };
 const checked=payload.safeParse(copy(value,0));if(!checked.success)return fail();const parsed=checked.data;if(Buffer.byteLength(JSON.stringify(parsed),'utf8')>65536)return fail();
 if(parsed.operation==='draft'){if(new Set(parsed.modules).size!==parsed.modules.length)return fail();}
 else{
  if(new Set(parsed.reads.map(row=>row.read)).size!==parsed.reads.length)return fail();
  for(const row of parsed.reads){if(new Set(row.cards.map(card=>card.card)).size!==row.cards.length||new Set(row.explanations.map(item=>JSON.stringify(item))).size!==row.explanations.length)return fail();for(const card of row.cards)if(new Set(card.facts.map(fact=>fact.fact)).size!==card.facts.length)return fail();}
 }
 return parsed;
}
const system='Select only relevant available ordinal facts or canonical explanations from this closed source catalogue. There are no HR values or human words here. Never infer amounts, identities, causes, outcomes, permissions, dates or missing information. Return exactly one JSON object: {"version":1,"mode":"answer","blocks":[{"kind":"fact","read":0,"card":0,"fact":0}]} or an available {"kind":"explanation","read":0,"card":null,"code":"exact-code"} block; select 1 to 16 distinct blocks. Use {"version":1,"mode":"insufficient","code":"no_verified_facts"} only when no available references exist. Do not return prose, tools, actions, effects, history or other fields. For leave_available prioritize available; leave_pending prioritize pending; leave_taken prioritize taken. Other intents select the smallest useful current-source answer.';
export function capturePrivateAssistantTask(value:unknown):{args:ConverseArgs|GenerateArgs;local:PrivateAssistantPayload}{
 const local=capture(value),json=JSON.stringify(local);
 if(local.operation==='draft')return{args:Object.freeze({system:'Choose only from the supplied source-owned module list. Return exactly {"decision":"read","modules":["closed-module-code"]}, using the supplied modules only, or {"decision":"refuse","modules":[]}. Never add modules, prose, effects or other keys.',prompt:json,maxTokens:384,timeoutMs:15000}),local};
 return{args:Object.freeze({system:[system],turns:[{role:'user',content:json}],tools:[],maxTokens:2048,timeoutMs:30000}),local};
}
export function fingerprintPrivateAssistantTask(value:unknown):string{return createHash('sha256').update(JSON.stringify(capture(value))).digest('hex');}
export function privateAssistantCatalogue(intent:PrivateAssistantIntent,reads:readonly AssistantAnswerRead[]):PrivateAssistantPayload{
 return capture({version:1,operation:'conversation',intent,reads:reads.map(source=>({read:source.read,module:source.presentation.module,cards:source.presentation.cards.slice(0,25).map((card,index)=>({card:index,facts:card.facts.map((fact,index)=>({fact:index,field:fact.field,available:(card.withheld!==true||source.presentation.module==='leave')&&fact.value!==null&&(typeof fact.value!=='string'||fact.value.trim().length>0)}))})),explanations:source.explanations}))});
}
export function adjudicatePrivateAssistantTerminal(text:string,local:unknown):AssistantAnswerPlan{
 const source=capture(local);if(source.operation!=='conversation')return fail();const plan=parseAssistantAnswerPlan(text);
 const keys=new Set(source.reads.flatMap(read=>[...read.cards.flatMap(card=>card.facts.filter(fact=>fact.available).map(fact=>`fact:${read.read}:${card.card}:${fact.fact}`)),...read.explanations.map(item=>`explanation:${read.read}:${item.card}:${item.code}`)]));
 if(plan.mode==='answer'){if(plan.blocks.some(block=>!keys.has(block.kind==='fact'?`fact:${block.read}:${block.card}:${block.fact}`:`explanation:${block.read}:${block.card}:${block.code}`)))return fail();return plan;}
 if(plan.mode==='insufficient'&&plan.code==='no_verified_facts'&&keys.size===0)return plan;
 return fail();
}
export function adjudicatePrivateAssistantReadPlan(text:string,local:unknown):ReturnType<typeof adjudicatePromptReadPlan>{
 const source=capture(local);if(source.operation!=='draft')return fail();const plan=adjudicatePromptReadPlan(text);
 if(plan.modules.some(module=>!source.modules.includes(module)))return fail();return plan;
}
const normalize=(value:string)=>value.normalize('NFC').trim().toLocaleLowerCase('en').replace(/[.!?。！？]+$/u,'').replace(/\s+/g,' ');
const aliases:Readonly<Partial<Record<PrivateAssistantIntent,readonly string[]>>>=Object.freeze({
 module_overview:['what can you do','what can you help me with','what can you help me do in this application','how many agents are turned on and where do i activate the rest','show assistant capabilities'],
 leave_available:['my leave balance','show my leave balance','how much leave do i have','how much leave do i have left','how much leave is left','what is my leave balance','my leave'],
 leave_pending:['how much leave is pending','my pending leave'],leave_taken:['how much leave have i taken','my leave taken'],
 leave_requests:['my leave requests','show my leave requests','my leave applications'],claim_statuses:['my claims','show my claims','what is my claim status'],holidays:['my upcoming holidays','what are my upcoming holidays'],
 reporting_line:['who is my manager','who do i report to','my reporting line'],work_profile:['my work profile','show my work profile','my employment'],payslip:['my payslip','show my latest payslip','my latest payslip'],pay_change:['why did my pay change','explain my pay change'],
 attendance:['my attendance','show my attendance'],performance:['my performance review','show my review status'],notifications:['my notifications'],approvals:['my approvals'],toil:['my replacement credits'],lifecycle:['my onboarding'],knowledge_base:['my knowledge base','show published guides'],rewards:['my rewards'],
});
const dictionaries=[en,ms,zh,vi,ta,th];
/** A closed local grammar, NOT regex masking of arbitrary language. Unknown wording stays local and
 * asks for a module; names, free prose and pasted instructions are never sent as an alleged safe intent. */
export function resolvePrivateAssistantIntent(question:string,previous:readonly string[]=[]):Readonly<{intent:PrivateAssistantIntent|null;social:'greeting'|'thanks'|null;fromDate?:string}>{
 const social=assistantSocialIntent(question);if(social)return{intent:null,social};
 const normalized=normalize(question);
 for(const dictionary of dictionaries){const template=dictionary.assistant.workspace.holidays_prompt,[prefix,suffix]=template.split('{date}');if(suffix===undefined)continue;const before=normalize(prefix),after=normalize(suffix);if(normalized.startsWith(before)&&normalized.endsWith(after)){const date=normalized.slice(before.length,after?normalized.length-after.length:undefined).trim();if(isCalendarDate(date))return{intent:'holidays',social:null,fromDate:date};}}
 for(const intent of PRIVATE_ASSISTANT_INTENTS){
  if(aliases[intent]?.some(alias=>normalize(alias)===normalized)||dictionaries.some(dictionary=>{const key=`${intent}_prompt` as keyof typeof en.assistant.workspace;const value=dictionary.assistant.workspace[key as keyof typeof dictionary.assistant.workspace];return typeof value==='string'&&!value.includes('{date}')&&normalize(value)===normalized;}))return{intent,social:null};
 }
 for(const module of AGENT_MODULE_CODES)if(normalized===normalize(module.replaceAll('_',' '))){const map:Partial<Record<AgentModuleCode,PrivateAssistantIntent>>={leave:'leave_available',claims:'claim_statuses',payroll:'payslip',employees:'work_profile',org:'reporting_line',assistant:'module_overview',attendance:'attendance',performance:'performance',notifications:'notifications',approvals:'approvals',toil:'toil',lifecycle:'lifecycle',knowledge_base:'knowledge_base',rewards:'rewards'};return{intent:map[module]??null,social:null};}
 const last=previous.length?resolvePrivateAssistantIntent(previous[previous.length-1],previous.slice(0,-1)).intent:null;
 if(last&&['leave_available','leave_pending','leave_taken'].includes(last)){
  if(['and pending','what about pending','and how much is pending'].includes(normalized))return{intent:'leave_pending',social:null};
  if(['and taken','what about taken','and how much have i taken'].includes(normalized))return{intent:'leave_taken',social:null};
  if(['and available','what about available'].includes(normalized))return{intent:'leave_available',social:null};
 }
 return{intent:null,social:null};
}
export function privateAssistantModules(intent:PrivateAssistantIntent):readonly AgentModuleCode[]{
 const module:AgentModuleCode=intent==='module_overview'?'assistant':intent.startsWith('leave_')?'leave':intent==='claim_statuses'?'claims':intent==='holidays'||intent==='reporting_line'?'org':intent==='work_profile'?'employees':intent==='payslip'||intent==='pay_change'?'payroll':intent as AgentModuleCode;
 return Object.freeze([module]);
}
