/** Closed source-owned workload transformations. These descriptors grant no source permission or
 * provider admission. Native owners must replay raw source fingerprints in the admission Tx. */
import {createHash} from 'node:crypto';
import {types as nodeTypes} from 'node:util';
import {AiGatewayError,type GenerateArgs,type ConverseArgs} from './types';
import type {AiFeatureId} from './features';
import {NATIVE_OUTLINE_KINDS as nativeOutlineKinds,type NativeOutlineSection,type NativeInsightOutline} from './native-insight-outline';
export {nativeParagraphOutline} from './native-insight-outline';
export type {NativeOutlineSection,NativeInsightOutline} from './native-insight-outline';
import {PROMPT_HOLDOUTS,promptCandidateSystem,capturePromptPlanCandidate} from './module-agent-prompt-candidate';
import {PERSONNEL_IMPORT_ASSISTANCE_REGISTRY} from '../personnel-import-assistance';
import {ASSISTANT_CONVERSATION_HOLDOUTS} from './assistant-conversation-holdouts';
import {captureAssistantConversationCandidate,assistantConversationCandidateSystem} from './assistant-conversation-candidate';
import {buildAssistantConversationSystem} from './assistant-conversation-system';
import {ASSISTANT_TOOL_CATALOGUE} from './assistant-tool-catalogue';
import type {AiTurn,AiToolCall,AiToolResult,AiToolSpec} from './types';

export class ProviderWorkloadUnavailableError extends AiGatewayError {
 constructor(public readonly variant:string){super('This task needs a supported protected source. Use the native screen for the remaining details.');this.name='ProviderWorkloadUnavailableError';}
}
const refuse=(variant='unsupported_source'):never=>{throw new ProviderWorkloadUnavailableError(variant);};
/** Strict descriptor capture never invokes accessors/proxies/toJSON. Original local text may be
 * fingerprinted here, but no captured value is automatically admitted to a provider payload. */
export function captureWorkloadSource(value:unknown):unknown{
 let nodes=0;
 const copy=(v:unknown,depth:number):unknown=>{
  if(++nodes>30000||depth>24)return refuse();
  if(v===null||typeof v==='boolean')return v;
  if(typeof v==='number')return Number.isFinite(v)?v:refuse();
  if(typeof v==='string')return v.length<=65536?v:refuse();
  if(!v||typeof v!=='object'||nodeTypes.isProxy(v))return refuse();
  const descriptors=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(descriptors);
  if(Array.isArray(v)){
   if(Object.getPrototypeOf(v)!==Array.prototype||keys.length!==v.length+1)return refuse();
   return Object.freeze(Array.from({length:v.length},(_,i)=>{const d=descriptors[String(i)];return d&&'value'in d?copy(d.value,depth+1):refuse();}));
  }
  if(![Object.prototype,null].includes(Object.getPrototypeOf(v)))return refuse();
  const result=Object.create(null) as Record<string,unknown>;
  for(const k of keys){const d=typeof k==='string'?descriptors[k]:undefined;if(typeof k!=='string'||!d?.enumerable||!('value'in d))return refuse();result[k]=copy(d.value,depth+1);}
  return Object.freeze(result);
 };
 const result=copy(value,0);if(Buffer.byteLength(JSON.stringify(result),'utf8')>262144)return refuse();return result;
}
function row(input:unknown,keys:readonly string[]){const v=captureWorkloadSource(input);if(!v||typeof v!=='object'||Array.isArray(v))return refuse();const r=v as Record<string,unknown>;if(Object.keys(r).length!==keys.length||keys.some(k=>!Object.hasOwn(r,k)))return refuse();return r;}
function member<const T extends readonly string[]>(value:unknown,choices:T):T[number]{return typeof value==='string'&&(choices as readonly string[]).includes(value)?value:refuse();}
function list(value:unknown,max:number){if(!Array.isArray(value)||value.length>max)return refuse();return value;}
const fingerprint=(source:unknown)=>createHash('sha256').update(JSON.stringify(captureWorkloadSource(source))).digest('hex');
export type ProviderWorkloadDescriptor=Readonly<{features:readonly AiFeatureId[];operation:'draft'|'conversation';fingerprint:(source:unknown)=>string;capture:(source:unknown)=>Readonly<{args:GenerateArgs|ConverseArgs;local?:unknown;retire?:()=>void}>}>;
const descriptor=(features:readonly AiFeatureId[],operation:'draft'|'conversation',capture:ProviderWorkloadDescriptor['capture']):ProviderWorkloadDescriptor=>Object.freeze({features:Object.freeze([...features]),operation,fingerprint,capture});
const digestSource=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:refuse();
export const PERFORMANCE_NATIVE_OUTLINE_PURPOSES=['written_performance','written_potential','potential','talent','record_present','record_cycle','record_trend','idp_fit','career_fit'] as const;
export type PerformanceNativeOutlinePurpose=typeof PERFORMANCE_NATIVE_OUTLINE_PURPOSES[number];
export function captureNativeOutlineSections(value:unknown):readonly NativeOutlineSection[]{const sections=list(captureWorkloadSource(value),24).map(value=>{const s=row(value,['index','kind','text']);if(typeof s.index!=='number'||!Number.isSafeInteger(s.index)||s.index<0||s.index>23||typeof s.text!=='string'||!s.text.trim())return refuse();return Object.freeze({index:s.index,kind:member(s.kind,nativeOutlineKinds),text:s.text});});if(!sections.length||new Set(sections.map(s=>s.index)).size!==sections.length)return refuse();return Object.freeze(sections);}
/** Distinct reference-only operation. Every native fact/verdict/decision remains byte-equivalent;
 * the model can only arrange a complete set of locally rendered sections for the UI. */
export function adjudicateNativeOutlineSelection<T extends object>(native:T,sections:readonly NativeOutlineSection[],raw:string):T&{nativeOutline:NativeInsightOutline}{
 const captured=captureWorkloadSource(native);if(!captured||typeof captured!=='object'||Array.isArray(captured)||Object.hasOwn(captured,'nativeOutline'))return refuse('invalid_native_outline_owner');
 const source=captureNativeOutlineSections(sections),selection=row(JSON.parse(raw),['items']),items=list(selection.items,24);
 if(items.length!==source.length||new Set(items).size!==items.length||items.some(index=>typeof index!=='number'||!Number.isSafeInteger(index)||!source.some(s=>s.index===index)))return refuse('unsupported_native_outline_selection');
 return Object.freeze({...captured,nativeOutline:Object.freeze({operation:'native_outline_selection' as const,order:Object.freeze(items as number[]),sections:source})}) as T&{nativeOutline:NativeInsightOutline};
}
const protocolSystem='This is a synthetic integration protocol test. There are no people, accounts or HR records in this test.';
const marker=(value:unknown)=>typeof value==='string'&&/^eval_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)?value:refuse();
const gaps=['no_compensation','no_bank_account','no_identity','no_tax_number','no_epf_number','no_socso_number'] as const;
const fieldIds=PERSONNEL_IMPORT_ASSISTANCE_REGISTRY.map(r=>r.field);
const hypothesisClaims=['missed_increment','out_of_step_with_peers','component_drift','deduction_outlier','statutory_category_doubt'] as const;
const hypothesisFields=['netChangePct','grossChangePct','otShareOfGrossPct','allowanceShareOfGrossPct','deductionShareOfGrossPct','statutoryShareOfGrossPct','netChangePctZ','grossChangePctZ','otShareOfGrossPctZ','allowanceShareOfGrossPctZ','deductionShareOfGrossPctZ','statutoryShareOfGrossPctZ'] as const;
const detectors=['negative-net','zero-net-with-pay','statutory-over-cap','missing-bank-profile','missing-tax-profile','pay-without-attendance','proration-mismatch','duplicate-employment-pay','net-swing','component-appeared','component-vanished','hypothesis'] as const;
const detectorFields=['netPay','grossPay','totalDeductions','actual','cap','excess','pcb','attendanceDays','approvedLeaveDays','daysWorked','periodDays','otherEmployments','previous','current','delta','changePct','amount','priorAmount'] as const;
export function protectedPayRuleInput(description:string):Record<string,unknown>{
 const text=description.trim().toLowerCase();if(text==='fixed'||text==='fixed monthly amount')return {kind:'fixed'};
 let m=/^(?:per[_ ]day|daily)(?: rate)?[: ]+(\d+(?:\.\d{1,4})?)$/.exec(text);if(m)return {kind:'per_day',rate:Number(m[1])};
 m=/^(?:per[_ ]hour|hourly)(?: rate)?[: ]+(\d+(?:\.\d{1,4})?)$/.exec(text);if(m)return {kind:'per_hour',rate:Number(m[1])};
 m=/^(\d+(?:\.\d{1,4})?)\s*%\s+of\s+basic$/.exec(text);if(m)return {kind:'percent_of',base:'basic',pct:Number(m[1])};
 m=/^quantity[: ]+(\d+(?:\.\d{1,4})?)\s+rate[: ]+(\d+(?:\.\d{1,4})?)$/.exec(text);if(m)return {kind:'qty_rate',qty:Number(m[1]),rate:Number(m[2])};
 m=/^value[: ]+(\d+(?:\.\d{1,4})?)\s+cap[: ]+(\d+(?:\.\d{1,4})?)$/.exec(text);if(m)return {kind:'flat_capped',value:Number(m[1]),cap:Number(m[2])};
 return refuse('raw_rule_description');
}
const reportDatasets=['attendance_ot','attendance_daily','leave_balances','payroll_register','payroll_history','claim_types','performance_goals','performance_reviews'] as const;
export const PROTECTED_REPORT_FIELDS=Object.freeze(['employeeCode','name','company','department','position','payPeriod','gross','net','status','date','days','hours','leaveType','available','taken','pending','balance','workedMinutes','otMinutes','title','weight','progress','dueOn']);
export function protectedReportColumns(description:string,available:readonly string[]):readonly string[]{const m=/^columns\s*:\s*([a-zA-Z][a-zA-Z0-9_]*(?:\s*,\s*[a-zA-Z][a-zA-Z0-9_]*)*)\s*$/.exec(description.trim());if(!m)return refuse('raw_report_description');const fields=m[1].split(',').map(v=>v.trim());if(!fields.length||fields.length>20||new Set(fields).size!==fields.length||fields.some(f=>!available.includes(f)||!PROTECTED_REPORT_FIELDS.includes(f)))return refuse('unsupported_report_columns');return Object.freeze(fields);}
export function protectedCalibrationQuery(input:unknown){
 const r=row(input,['message','axis','people','units']);if(typeof r.message!=='string'||r.message.length>2000)return refuse();const message=r.message,axis=member(r.axis,['performance','potential','both'] as const);
 const members=(value:unknown)=>list(value,1000).map(value=>{const p=row(value,['id','name']);if(typeof p.id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(p.id)||typeof p.name!=='string'||!p.name.trim()||p.name.length>250)return refuse();return {id:p.id,name:p.name};});
 const people=members(r.people),units=members(r.units),normal=(v:string)=>v.trim().normalize('NFKC').toLocaleLowerCase('en');
 if(/^(?:how are (?:the )?bands distributed|show (?:the )?band distribution)\??$/i.test(message.trim()))return Object.freeze({action:'distribution',axis});
 if(/^how are the performance bands spread across my cohort\??$/i.test(message.trim())){if(axis==='potential')return refuse('unsupported_calibration_axis');return Object.freeze({action:'distribution',axis:'performance'});}
 const named=/^(?:explain|open|show person|could you explain)\s*:?\s+(.+?)(?:\?)?$/i.exec(message.trim());
 if(named){const name=named[1].trim(),hits=people.filter(p=>normal(p.name)===normal(name));if(hits.length!==1)return refuse('ambiguous_calibration_subject');const start=message.lastIndexOf(name);if(start<0)return refuse();return Object.freeze({action:'person',reviewId:hits[0].id,name:Object.freeze({start,end:start+name.length})});}
 const request=/^(?:show\s+)?(distribution|framework|curve gaps|prepare lock)(?:\s+for\s+(.+))?[.!?]?$/i.exec(message.trim());if(!request)return refuse('raw_calibration_intent');
 const action=request[1].toLowerCase()==='curve gaps'?'framework':request[1].toLowerCase()==='prepare lock'?'prepare_lock':request[1].toLowerCase();
 if(!request[2])return Object.freeze({action,axis});const name=request[2].trim(),hits=units.filter(p=>normal(p.name)===normal(name));if(hits.length!==1)return refuse('ambiguous_calibration_unit');const start=message.lastIndexOf(name);if(start<0)return refuse();return Object.freeze({action,axis,unit:Object.freeze({id:hits[0].id,name:Object.freeze({start,end:start+name.length})})});
}
export function protectedPerformanceCommand(kind:unknown,input:unknown){
 const source=captureWorkloadSource(input);if(!source||typeof source!=='object'||Array.isArray(source))return refuse();const p=source as Record<string,unknown>,m=p.message;if(!m||typeof m!=='object'||Array.isArray(m)||typeof(m as {text:unknown}).text!=='string')return refuse();const text=(m as {text:string}).text;if(text.length>8000)return refuse();
 const spanFor=(value:string)=>{const start=text.indexOf(value,text.indexOf(':')+1);if(start<0||!value.trim())return refuse();return {start,end:start+value.length};};
 if(kind==='career'){
  if(p.canEditCareer!==true)return refuse('career_edit_unavailable');
  const match=/^\s*(?:career )?(aspiration|aspirationNow|aspirationLong|strengths|preferences|mentor|mobilityNote|mobility)\s*:\s*([\s\S]+)$/i.exec(text);if(!match)return refuse('semantic_performance_command');
  const field=member(match[1].toLowerCase(),['aspiration','aspirationnow','aspirationlong','strengths','preferences','mentor','mobilitynote','mobility'] as const),value=match[2].trim();
  if(field==='mobility'){member(value,['stay','role_in_unit','company_in_group','other_group','relocate'] as const);return {commands:[{action:'mobility',value:spanFor(value)}]};}
  const fields:Record<string,string>={aspiration:'aspiration',aspirationnow:'aspirationNow',aspirationlong:'aspirationLong',strengths:'strengths',preferences:'preferences',mentor:'mentor',mobilitynote:'mobilityNote'};return {commands:[{action:'career_field',field:fields[field],value:spanFor(value)}]};
 }
 if(kind==='review'||kind==='journey'){
  const review=kind==='journey'?p.review:p;
  if(review&&typeof review==='object'&&!Array.isArray(review)){
   const owner=review as Record<string,unknown>,marked=/^\s*mark\s+(.+)\s+(yes|no|not yet)\s*$/i.exec(text);
   if(owner.draftKind==='feedback'&&marked){const label=marked[1].trim(),answer=marked[2],targets=list(owner.targets,1000).map(value=>row(value,['id','label'])),hits=targets.filter(target=>typeof target.id==='string'&&typeof target.label==='string'&&target.label.trim().normalize('NFKC').toLocaleLowerCase('en')===label.normalize('NFKC').toLocaleLowerCase('en'));if(hits.length!==1||String(hits[0].id).startsWith('principle:'))return refuse('ambiguous_performance_target');const start=text.indexOf(label),answerStart=text.lastIndexOf(answer);if(start<0||answerStart<start+label.length)return refuse();return {commands:[{action:'feedback_answer',id:hits[0].id,target:{start,end:start+label.length},answer:{start:answerStart,end:answerStart+answer.length}}]};}
  }
  const remark=/^\s*(?:overall )?remark\s*:\s*([\s\S]+)$/i.exec(text);
  if(remark&&(typeof p.draftKind==='string'||p.review!==null&&typeof p.review==='object'))return {commands:[{action:'overall_remark',text:spanFor(remark[1].trim())}]};
  const evidence=/^\s*log evidence\s*:\s*([\s\S]+)$/i.exec(text),e=p.evidence;
  if(evidence&&kind==='journey'&&e&&typeof e==='object'&&!Array.isArray(e)&&(e as {canLog:unknown}).canLog===true)return {commands:[{action:'log_evidence',body:spanFor(evidence[1].trim())}]};
 }
 if(kind==='setting'){
  const request=/^\s*(add|remove) kpi\s*:\s*(.+)$/i.exec(text),weighted=/^\s*weight for\s+(.+)\s*:\s*(\d+(?:\.\d+)?)\s*$/i.exec(text);
  if(!request&&!weighted)return refuse('semantic_performance_command');const action=request?request[1].toLowerCase()==='add'?'add_kpi':'remove_kpi':'set_weight',name=(request?request[2]:weighted![1]).trim(),raw=action==='add_kpi'?p.library:p.kpis;
  if(!Array.isArray(raw)||raw.length>1000)return refuse();const normal=(s:string)=>s.trim().normalize('NFKC').toLocaleLowerCase('en'),matches=raw.filter(v=>v&&typeof v==='object'&&!Array.isArray(v)&&typeof(v as {title:unknown}).title==='string'&&normal((v as {title:string}).title)===normal(name));
  if(matches.length!==1||typeof(matches[0] as {id:unknown}).id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test((matches[0] as {id:string}).id))return refuse('ambiguous_performance_target');
  const start=text.indexOf(name,request?text.indexOf(':')+1:(/for\s+/i.exec(text)?.index??0)+3);if(start<0)return refuse();const command={action,id:(matches[0] as {id:string}).id,target:{start,end:start+name.length}};
  if(!weighted)return {commands:[command]};const value=weighted[2],valueStart=text.lastIndexOf(value);return {commands:[{...command,value:{start:valueStart,end:valueStart+value.length}}]};
 }
 return refuse('semantic_performance_command');
}
const contracts=Object.freeze({
 performance_native_outline_v1:descriptor(['performance_tc','performance_review','performance_idp'],'draft',input=>{const r=row(input,['purpose','native','sections']),purpose=member(r.purpose,PERFORMANCE_NATIVE_OUTLINE_PURPOSES);if(!r.native||typeof r.native!=='object'||Array.isArray(r.native))return refuse();const sections=captureNativeOutlineSections(r.sections);return {args:Object.freeze({system:'Arrange all native-owned summary section references into a useful reading order. The native owner has already established all facts and judgments; their text and values are withheld. Return exactly JSON {"items":[0,1]} with EVERY supplied index exactly once. No prose, new fields, values, ratings, decisions, causes or missing references. This is presentation selection, never independent semantic analysis.',prompt:JSON.stringify({purpose,sections:sections.map(s=>({index:s.index,kind:s.kind,lengthBand:s.text.length<=200?'short':s.text.length<=800?'medium':'long'}))}),maxTokens:400,timeoutMs:20000})};}),
 performance_explicit_commands_v1:descriptor(['performance_assistant'],'draft',input=>{const r=row(input,['channel','commands','source']);digestSource(r.source);const channel=member(r.channel,['career','setting','review','journey'] as const),commands=list(r.commands,50).map(value=>{const c=row(value,['index','action']);if(typeof c.index!=='number'||!Number.isSafeInteger(c.index)||c.index<0||c.index>49)return refuse();return {index:c.index,action:member(c.action,['career_field','mobility','role_choice','add_goal','edit_goal','remove_goal','add_kpi','remove_kpi','set_weight','set_target','set_number','competency_reflection','kpi_result','kpi_note','competency_answer','feedback_answer','feedback_comment','overall_remark','log_evidence','checkin'] as const)};});if(new Set(commands.map(c=>c.index)).size!==commands.length)return refuse();return {args:Object.freeze({system:'Confirm all explicit source-parsed human draft command references, or abstain. Return only JSON {"items":[0,1]} containing every supplied index once, or {"items":[]}. No identities, target labels, numbers, values, text spans or personal facts are supplied. Do not infer decisions, ratings or intent. Native adjudication and the current human draft workflow own every effect.',prompt:JSON.stringify({channel,commands}),maxTokens:400})};}),
 performance_starter_selection_v1:descriptor(['performance_pm'],'draft',input=>{const r=row(input,['items','source']);digestSource(r.source);const items=list(r.items,100).map(value=>{const c=row(value,['index','scoringReady']);if(typeof c.index!=='number'||!Number.isSafeInteger(c.index)||c.index<0||c.index>99||typeof c.scoringReady!=='boolean')return refuse();return {index:c.index,scoringReady:c.scoringReady};});if(!items.length||new Set(items.map(c=>c.index)).size!==items.length)return refuse();return {args:Object.freeze({system:'Select one to eight distinct eligible source library references for an editable starter scorecard. Return only JSON {"items":[0,1]}. Text, personal information, values, weights and scoring thresholds are withheld. Prefer scoringReady references. Never invent targets, calculate values, rate a person or approve. The native library owner restores IDs and administrator defaults for human review.',prompt:JSON.stringify({items}),maxTokens:250})};}),
 synthetic_protocol_echo_v1:descriptor(['provider_evaluation'],'draft',input=>{const r=row(input,['marker']),m=marker(r.marker);return {args:Object.freeze({system:protocolSystem,prompt:`Return exactly this token and nothing else: ${m}`,maxTokens:1024,timeoutMs:15000})};}),
 synthetic_protocol_tools_v1:descriptor(['provider_evaluation'],'conversation',input=>{
  const r=row(input,['marker','stage','callId']),m=marker(r.marker),stage=member(r.stage,['first','final'] as const);
  const tool:AiToolSpec={name:'integration_echo',description:'Synthetic integration fixture only. Return the supplied marker through the tool; this tool has no side effects.',inputSchema:{type:'object',properties:{marker:{type:'string',enum:[m]}},required:['marker'],additionalProperties:false}};
  const question=`Call integration_echo exactly once with marker ${m}. Do not answer in text yet.`;
  if(stage==='first'&&r.callId!==null)return refuse();
  if(stage==='final'&&(typeof r.callId!=='string'||! /^[\x21-\x7e]{1,200}$/.test(r.callId)))return refuse();
  const turns:ConverseArgs['turns']=stage==='first'?[{role:'user',content:question}]:[{role:'user',content:question},{role:'assistant',content:'',toolCalls:[{id:r.callId as string,name:tool.name,input:{marker:m}}]},{role:'tool',results:[{id:r.callId as string,name:tool.name,content:JSON.stringify({marker:m})}]}];
  return {args:Object.freeze({system:stage==='first'?[protocolSystem]:[protocolSystem,'After the tool result, return exactly its marker and nothing else.'],turns,tools:[tool],maxTokens:1024,timeoutMs:15000})};
 }),
 synthetic_read_plan_v1:descriptor(['module_agent_evaluation'],'draft',input=>{
  const r=row(input,['candidate','fixtureId']),candidate=capturePromptPlanCandidate(r.candidate),fixture=PROMPT_HOLDOUTS.find(f=>f.id===r.fixtureId);if(!fixture)return refuse();
  return {args:Object.freeze({system:promptCandidateSystem(candidate),prompt:fixture.question,maxTokens:384,timeoutMs:15000})};
 }),
 synthetic_assistant_conversation_v1:descriptor(['module_agent_evaluation'],'conversation',input=>{
  const r=row(input,['fixtureId','strategy','steps']),fixture=ASSISTANT_CONVERSATION_HOLDOUTS.find(f=>f.id===r.fixtureId);if(!fixture)return refuse();
  // Strict source capture deliberately uses null-prototype records. Rebuild only these two already
  // captured data fields as a plain object for the source-owned closed candidate validator.
  const strategy=captureAssistantConversationCandidate({...row(r.strategy,['kind','variant'])});
  const turns:AiTurn[]=[{role:'user',content:JSON.stringify({locale:fixture.locale,question:fixture.question,evaluationClock:'2026-10-01',fictionalSource:true})}];
  for(const value of list(r.steps,2)){
   const step=row(value,['calls']),calls:AiToolCall[]=[],results:AiToolResult[]=[];
   for(const value of list(step.calls,8)){
    const call=row(value,['id','expectedIndex']);if(typeof call.id!=='string'||! /^[\x21-\x7e]{1,200}$/.test(call.id))return refuse();
    if(call.expectedIndex!==null&&(typeof call.expectedIndex!=='number'||!Number.isSafeInteger(call.expectedIndex)||call.expectedIndex<0||call.expectedIndex>=fixture.expectedTools.length))return refuse();
    const index=call.expectedIndex as number|null,expected=index===null?null:fixture.expectedTools[index],read=index===null?null:fixture.reads[index];
    // An unsupported model request is represented by one closed unavailable marker, never its raw
    // proposed text/arguments. No executable registry function runs in this synthetic evaluator.
    if(!expected||!read){calls.push({id:call.id,name:'my_module_work',input:{module:'assistant'}});results.push({id:call.id,name:'my_module_work',content:JSON.stringify({ok:false,message:'This source is unavailable for this request.'}),isError:true});continue;}
    calls.push({id:call.id,name:expected.name,input:structuredClone(expected.input)});
    const canonical=fixture.source&&typeof fixture.source==='object'?fixture.source as Record<string,unknown>:{},context=expected.name==='my_leave_balances'?canonical.balance:expected.name==='leave_entitlement_explain'?canonical.explanation:undefined;
    results.push({id:call.id,name:expected.name,content:JSON.stringify({ok:true,canonicalRead:read,...(context?{context}:{})})});
   }
   if(!calls.length||new Set(calls.map(c=>c.id)).size!==calls.length)return refuse();turns.push({role:'assistant',content:'',toolCalls:calls},{role:'tool',results});
  }
  return {args:Object.freeze({system:buildAssistantConversationSystem(assistantConversationCandidateSystem(strategy)),turns,tools:ASSISTANT_TOOL_CATALOGUE.map(spec=>({...spec,inputSchema:structuredClone(spec.inputSchema)})),maxTokens:2048,timeoutMs:15000})};
 }),
 readiness_message_v1:descriptor(['readiness_reminders'],'draft',input=>{const r=row(input,['gap','audience']),gap=member(r.gap,gaps),audience=member(r.audience,['employee','hr'] as const);return {args:Object.freeze({system:'Choose a reminder tone for the supplied missing-record category. Return only JSON {"tone":"direct"} or {"tone":"supportive"}. Do not emit prose, names, numbers, URLs or decisions. The application writes the reminder from its own template.',prompt:JSON.stringify({gap,audience,employeeAction:'request_correction_for_human_review'}),maxTokens:80})};}),
 claim_detail_triage_v1:descriptor(['claims_triage'],'draft',input=>{const r=row(input,['detail','source']),detail=member(r.detail,['missing','brief'] as const);return {args:Object.freeze({system:'A native source established that a claim description is insufficient. Suggest whether to request detail or abstain. Return exactly JSON {"requestDetail":true} or {"requestDetail":false}. This does not approve, reject, submit or assess the financial merits of a claim. No prose or values.',prompt:JSON.stringify({detail,availableQuestion:'request_expense_description'}),maxTokens:80})};}),
 payroll_feature_hypothesis_v1:descriptor(['payroll_hypotheses'],'draft',input=>{
  const r=row(input,['candidates','source']);const candidates=list(r.candidates,60).map(v=>{const p=row(v,['claim','evidence']),claim=member(p.claim,hypothesisClaims),evidence=list(p.evidence,3).map(k=>member(k,hypothesisFields));if(!evidence.length||new Set(evidence).size!==evidence.length)return refuse();return {claim,evidence};});
  if(!candidates.length)return refuse();return {args:Object.freeze({system:'Select at most one of the native-adjudicated payroll hypothesis candidates, or abstain. Candidates are questions for human investigation, never verified causes or payroll changes. Copy one supplied claim/evidence pair exactly, or return {"claim":"nothing_notable","evidence":[]}. Return only that JSON object, no prose, money, figures or actions.',prompt:JSON.stringify({candidates}),maxTokens:200})};
 }),
 payroll_detector_explanation_v1:descriptor(['payroll_explanation'],'draft',input=>{const r=row(input,['detector','fields','source']),detector=member(r.detector,detectors),fields=list(r.fields,20).map(k=>member(k,detectorFields));if(!fields.length||new Set(fields).size!==fields.length)return refuse();return {args:Object.freeze({system:'Choose the most useful recorded field references to show beside an existing payroll detector finding. Return only JSON {"fields":["suppliedField"]}, distinct supplied fields, maximum5. Do not infer causes, calculate pay, provide prose, or decide employment/pay outcomes. The application restores exact authorized values locally.',prompt:JSON.stringify({detector,fields}),maxTokens:180}),local:Object.freeze({fields})};}),
 authored_pay_rule_v1:descriptor(['pay_rule_draft'],'draft',input=>{const r=row(input,['description','prorates']);if(typeof r.description!=='string'||typeof r.prorates!=='boolean')return refuse();const rule=protectedPayRuleInput(r.description);return {args:Object.freeze({system:'Confirm the requested declarative pay-rule KIND only. Return exactly JSON {"kind":"suppliedKind"}. No numbers, money calculation, prose or employment actions. The human-supplied numeric parameters are withheld and restored locally before native validation.',prompt:JSON.stringify({requestedKind:rule.kind,componentProrates:r.prorates}),maxTokens:80}),local:Object.freeze({kind:rule.kind})};}),
 authored_report_plan_v1:descriptor(['report_insight'],'draft',input=>{const r=row(input,['dataset','columns']),dataset=member(r.dataset,reportDatasets),columns=list(r.columns,20).map(f=>member(f,PROTECTED_REPORT_FIELDS));if(!columns.length||new Set(columns).size!==columns.length)return refuse();return {args:Object.freeze({system:'Arrange the supplied report column IDs into a useful reading order. Return only JSON {"columns":["suppliedId"]} containing exactly the supplied set once each. Do not invent labels, filters, names, values, SQL, facts or prose. No employee records are supplied.',prompt:JSON.stringify({dataset,columns}),maxTokens:500})};}),
 feedback_task_outline_v1:descriptor(['feedback_planning'],'draft',input=>{const r=row(input,['category','contested','source']),category=member(r.category,['issue','enhancement','new_function'] as const);if(typeof r.contested!=='boolean')return refuse();return {args:Object.freeze({system:'Choose a useful implementation-plan outline for the supplied feedback category. Return exactly JSON {"steps":["reproduce","change","verify","review"]}, each of these four phases exactly once. No narrative facts, code, private names, implementation guesses or automatic approval. The application attaches the reporter\'s exact request locally for human review.',prompt:JSON.stringify({category,contested:r.contested}),maxTokens:120})};}),
 personnel_header_mapping_v1:descriptor(['personnel_import_mapping'],'draft',input=>{
  const r=row(input,['columns']),seen=new Set<number>();const columns=list(r.columns,32).map(v=>{const c=row(v,['columnIndex','candidates']);if(typeof c.columnIndex!=='number'||!Number.isSafeInteger(c.columnIndex)||c.columnIndex<0||c.columnIndex>16383||seen.has(c.columnIndex))return refuse();seen.add(c.columnIndex);const candidates=list(c.candidates,5).map(f=>member(f,fieldIds));if(new Set(candidates).size!==candidates.length)return refuse();return {columnIndex:c.columnIndex,candidates};});
  if(!columns.length)return refuse();return {args:Object.freeze({system:'Propose an import mapping using only each column\'s supplied canonical candidate field IDs. No headings or employee values are supplied. Return JSON {"mappings":[{"columnIndex":0,"status":"mapped","field":"candidate"}]} or status ambiguous with fields, or status unresolved. No invented fields or prose. Duplicate target fields must remain ambiguous or unresolved.',prompt:JSON.stringify({columns}),maxTokens:4096,timeoutMs:20000}),local:Object.freeze({columns})};
 }),
 performance_narrative_selection_v1:descriptor(['performance_360','performance_tc','performance_pm','performance_review','performance_idp','performance_calib','performance_assistant'],'draft',input=>{
  const r=row(input,['task','passages']),task=member(r.task,['manager_review','assessment_narrative','development_outline','career_outline','feedback_outline'] as const);
  const passages=list(r.passages,100).map(v=>{const p=row(v,['index','kind','text']);if(typeof p.index!=='number'||!Number.isSafeInteger(p.index)||p.index<0||p.index>99||typeof p.text!=='string'||!p.text.trim())return refuse();return {index:p.index,kind:member(p.kind,['self','manager','goal','peer','evidence','development','career','authored'] as const),text:p.text};});
  if(!passages.length||new Set(passages.map(p=>p.index)).size!==passages.length)return refuse();
  return {args:Object.freeze({system:'Select and order source passage references to produce a useful evidence outline. Only source kinds, coarse lengths and references are supplied; do not infer the withheld passage meaning. Return exactly JSON {"items":[0,1]} using distinct supplied indices, maximum30. Prefer concise coverage of each available source kind. No prose, ratings, employment decisions or invented facts. The authorized application restores exact source text locally for human editing.',prompt:JSON.stringify({task,passages:passages.map(p=>({index:p.index,kind:p.kind,lengthBand:p.text.length<=200?'short':p.text.length<=800?'medium':'long'}))}),maxTokens:600,timeoutMs:22000})};
 }),
 performance_text_layout_v1:descriptor(['performance_360','performance_tc','performance_pm','performance_review','performance_idp'],'draft',input=>{const r=row(input,['draft','instruction','forwardLooking']);if(typeof r.draft!=='string'||!r.draft.trim()||typeof r.instruction!=='string'||typeof r.forwardLooking!=='boolean'||!/^(?:polish(?: the wording)?|format(?: as)? (?:a paragraph|bullets)|make (?:a paragraph|bullets))\.?$/i.test(r.instruction.trim()))return refuse('semantic_performance_rewrite');return {args:Object.freeze({system:'Choose a presentation layout for an existing human-authored passage. The content is withheld. Return exactly JSON {"layout":"paragraph"} or {"layout":"bullets"}. No rewriting, facts, values, ratings or decisions.',prompt:JSON.stringify({requestedLayout:/bullets/i.test(r.instruction)?'bullets':'paragraph'}),maxTokens:80}),local:Object.freeze({requested:/bullets/i.test(r.instruction)?'bullets':'paragraph'})};}),
 performance_fact_selection_v1:descriptor(['performance_review'],'draft',input=>{const r=row(input,['intent','facts','source']),intent=member(r.intent,['status','calendar','record','guide','unknown'] as const),facts=list(r.facts,120).map(v=>{const f=row(v,['index','kind']);if(typeof f.index!=='number'||!Number.isSafeInteger(f.index)||f.index<0||f.index>119)return refuse();return {index:f.index,kind:member(f.kind,['task','summary','calendar','record','current','history','guide','other'] as const)};});return {args:Object.freeze({system:'Select up to four source references for a read-only Performance guide. Only source kinds and intent are supplied. Return JSON {"items":[0],"unanswered":false}. Unknown intent must return {"items":[],"unanswered":true}. Never infer withheld facts, identities, ratings, dates, links or actions.',prompt:JSON.stringify({intent,facts}),maxTokens:250})};}),
 performance_calibration_read_v1:descriptor(['performance_calib'],'draft',input=>{const query=protectedCalibrationQuery(input);return {args:Object.freeze({system:'Confirm a source-resolved read-only calibration query. Return exactly JSON {"action":"suppliedAction"}. This selects no rating and performs no lock, approval or change. No names, IDs, roster data, spans, prose or invented facts are supplied.',prompt:JSON.stringify({action:query.action}),maxTokens:80}),local:Object.freeze({query})};}),
 performance_admin_selection_v1:descriptor(['performance_review'],'draft',input=>{const r=row(input,['items','source']),items=list(r.items,6).map(v=>{const p=row(v,['index','kind']);if(typeof p.index!=='number'||!Number.isSafeInteger(p.index)||p.index<0||p.index>5)return refuse();return {index:p.index,kind:member(p.kind,['setting','page','report'] as const)};});return {args:Object.freeze({system:'Prioritize up to three authorized settings/pages/report links from a local search. Return only JSON {"items":[0,1]} with distinct supplied indices. No private labels, URLs, facts, commands, reports or changes may be invented or executed.',prompt:JSON.stringify({items}),maxTokens:150})};}),
 performance_literal_command_v1:descriptor(['performance_assistant'],'draft',input=>{const r=row(input,['kind','payload']),kind=member(r.kind,['career','review','journey','setting'] as const),proposal=protectedPerformanceCommand(kind,r.payload),command=proposal.commands[0];return {args:Object.freeze({system:'Confirm a locally parsed explicit user draft command. Return exactly JSON {"action":"suppliedAction"}. Content, identities, dates, values and UTF-16 spans are withheld. Do not infer or add commands, submit, approve, rate, calculate, change access or make employment decisions. Native adjudication and the human review flow remain mandatory.',prompt:JSON.stringify({action:command.action}),maxTokens:80}),local:Object.freeze({proposal})};}),
});
export type ProviderWorkloadContractId=keyof typeof contracts;
export function getProviderWorkloadDescriptor(id:string):ProviderWorkloadDescriptor|undefined{return Object.hasOwn(contracts,id)?contracts[id as ProviderWorkloadContractId]:undefined;}
/** Availability describes implemented safe variants, not review approval or a rollout promise. */
export const PROVIDER_WORKLOAD_AVAILABILITY=Object.freeze([
 {feature:'provider_evaluation',variant:'fixed_synthetic_protocol',contracts:['synthetic_protocol_echo_v1','synthetic_protocol_tools_v1'],remaining:[]},
 {feature:'module_agent_evaluation',variant:'fixed_synthetic_read_plan_and_conversation',contracts:['synthetic_read_plan_v1','synthetic_assistant_conversation_v1'],remaining:['provider_specific_continuation_state']},
 {feature:'personnel_import_mapping',variant:'canonical_header_candidates',contracts:['personnel_header_mapping_v1'],remaining:['unknown_private_heading_semantics']},
 {feature:'readiness_reminders',variant:'closed_gap_template_choice',contracts:['readiness_message_v1'],remaining:[]},
 {feature:'claims_triage',variant:'description_completeness',contracts:['claim_detail_triage_v1'],remaining:['raw_description_category_date_subject_interpretation']},
 {feature:'payroll_hypotheses',variant:'native_adjudicated_candidate_ranking',contracts:['payroll_feature_hypothesis_v1'],remaining:[]},
 {feature:'payroll_explanation',variant:'native_detector_field_selection',contracts:['payroll_detector_explanation_v1'],remaining:['arbitrary_unsupported_detector_facts']},
 {feature:'pay_rule_draft',variant:'closed_rule_intent_with_local_parameters',contracts:['authored_pay_rule_v1'],remaining:['unstructured_rule_semantics','formula_dependencies']},
 {feature:'report_insight',variant:'closed_report_column_intent',contracts:['authored_report_plan_v1'],remaining:['unstructured_request_semantics','private_filter_values']},
 {feature:'feedback_planning',variant:'category_outline_with_local_reporter_request',contracts:['feedback_task_outline_v1'],remaining:['raw_note_semantic_implementation_inference']},
 ...(['performance_360','performance_tc','performance_pm','performance_review','performance_idp','performance_calib','performance_assistant'] as const).map(feature=>({feature,variant:'source_reference_outline',contracts:['performance_narrative_selection_v1',...(['performance_tc','performance_review','performance_idp'].includes(feature)?['performance_native_outline_v1']:[]),...(feature==='performance_pm'?['performance_starter_selection_v1']:[]),...(!['performance_calib','performance_assistant'].includes(feature)?['performance_text_layout_v1']:[]),...(feature==='performance_review'?['performance_fact_selection_v1','performance_admin_selection_v1']:[]),...(feature==='performance_calib'?['performance_calibration_read_v1']:[]),...(feature==='performance_assistant'?['performance_literal_command_v1','performance_explicit_commands_v1']:[])],remaining:['raw_notes_semantic_rewrite','raw_documents','raw_images','individual_rating_inference','career_aspiration_semantics','unstructured_targeted_draft_commands']})),
]);
