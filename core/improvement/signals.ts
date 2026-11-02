/** ADR-0170 §3.12 steps 1 and 2, step 5c — improvement signals and their triage.
 *
 * Reads a tenant's outcome records (core/outcome-record, §3.11) and the harness traces they carry, and turns
 * them into aggregated signals:
 *  - suggestions accepted, rejected, reversed or still open, by job type (an action id or a work job type);
 *  - "no tool or action" and "no guide found" replies, by tool category;
 *  - fallbacks to "needs review", by reason;
 *  - guard blocks, by reason;
 *  - reply-check retries, by check, and tool calls the harness refused, by tool.
 * Each (signal, category) pair is one cluster, classified as missing context, missing capability, harness
 * defect, guard gap or interface gap, and ranked by how many people and roles it affects.
 *
 * PRIVACY (§3.12 "Privacy of the loop itself"). The report carries counts, categories, tool names and role
 * names only. Every string that reaches it is checked against a closed vocabulary taken from the product's
 * own registries (tools, actions, job types, gate reasons, reply checks, roles); anything else becomes
 * `other`. People are counted through a set that never leaves this function: no user, person, tenant or
 * record id, no question or reply text, and no record contents can appear in the output
 * (test/improvement-signals.test.ts plants each of them and fails if one survives).
 *
 * "No guide found" is inferred, not observed: the trace records that product_guidance ran, not that it
 * returned nothing. A turn that ended as an honest gap after a guidance lookup and no private read is counted
 * as "no guide found"; any other honest gap as "no tool or action" (open question in the step 5c hand-over).
 *
 * The harness's own names (its public context tools, action tools, reply checks, retry reasons and budgets)
 * are copied into HARNESS_VOCABULARY below, because nothing outside the harness may import it
 * (test/teras-harness-units.test.ts); test/improvement-signals.test.ts pins the copy to the harness spec.
 *
 * Read only. Nothing here writes, changes a guard, a permission, a disclosure class or a job type, and the
 * module is not imported by the production Assistant (test/improvement-engine-boundary.test.ts). */
import type {SessionContext} from '../../db/client';
import {roleEnum} from '../../db/schema';
import {AGENT_ACTION_IDS} from '../../lib/ai/agent-action-registry';
import {TURN_GATE_NOTE} from '../../lib/product-context/request-gate';
import {WORK_JOB_TYPES} from '../mandates/job-types';
import {listOutcomeRecords} from '../outcome-record/record';
import type {OutcomeRecordInput} from '../outcome-record/record';
import type {OutcomeCheck,OutcomeKind,OutcomeRead} from '../outcome-record/types';
import {SEMANTIC_ACTIONS} from '../semantic-model/entities';
import {terasCapabilityRegistry} from '../semantic-model/generate';

/** The fields of an outcome record triage reads. core/outcome-record listOutcomeRecords rows satisfy it. */
export type SignalRecord=Readonly<{runKind:'turn'|'mandate_run';outcomeKind:OutcomeKind;askedByUserId:string|null;grantorUserId:string|null;
 outcome:Readonly<Record<string,unknown>>;checks:readonly OutcomeCheck[];reads:readonly OutcomeRead[];trace:unknown;
 decision:'accepted'|'rejected'|'completed'|'undone'|null}>;

export type SignalKind='suggestion_rejected'|'suggestion_reversed'|'no_tool_or_action'|'no_guide_found'|'needs_review_fallback'|'guard_block'|'reply_check_retry'|'tool_call_failure';
export type Classification='missing_context'|'missing_capability'|'harness_defect'|'guard_gap'|'interface_gap';
export const CLASSIFICATIONS:readonly Classification[]=Object.freeze(['missing_context','missing_capability','harness_defect','guard_gap','interface_gap']);
export type SignalCluster=Readonly<{key:string;signal:SignalKind;category:string;classification:Classification;count:number;people:number;roles:readonly string[];rank:number}>;
export type SuggestionTally=Readonly<{accepted:number;rejected:number;reversed:number;open:number}>;
export type SignalReport=Readonly<{kind:'teras.improvement-signals';version:1;
 records:Readonly<{total:number;turns:number;mandateRuns:number;people:number}>;
 suggestions:Readonly<Record<string,SuggestionTally>>;
 replies:Readonly<{noToolOrAction:Readonly<Record<string,number>>;noGuideFound:Readonly<Record<string,number>>}>;
 fallbacks:Readonly<Record<string,number>>;guardBlocks:Readonly<Record<string,number>>;replyCheckRetries:Readonly<Record<string,number>>;
 toolCallFailures:Readonly<Record<string,number>>;
 clusters:readonly SignalCluster[]}>;

const OTHER='other';
/** The harness spec's names triage reads, pinned to the spec by test/improvement-signals.test.ts. */
export const HARNESS_VOCABULARY=Object.freeze({
 publicContextTools:Object.freeze(['product_destinations','product_guidance','available_actions','password_policy_guidance','correction_controls_guidance']),
 actionTools:Object.freeze(['available_actions','suggest_action']),
 replyChecks:Object.freeze(['non_blank','destination_links','workplace_channel','overclaim','identifiers']),
 retryReasons:Object.freeze(['truncated','blank']),
 budgets:Object.freeze(['steps','tokens','time','spend']),
});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const closed=(known:Iterable<string>)=>{const set=new Set(known);return(value:unknown):string=>typeof value==='string'&&set.has(value)?value:OTHER;};

/** Tool name → category: a read's module, `product_context` for context tools, `actions` for the action tools. */
const TOOL_CATEGORY:ReadonlyMap<string,string>=new Map([
 ...terasCapabilityRegistry().filter(row=>row.effect==='read').map(row=>[row.name,row.module??'company'] as const),
 ...['product_destinations','product_guidance','company_setup','setup_readiness','approval_queue'].map(name=>[name,'product_context'] as const),
 ...HARNESS_VOCABULARY.actionTools.map(name=>[name,'actions'] as const),
]);
const PUBLIC_CONTEXT:ReadonlySet<string>=new Set(HARNESS_VOCABULARY.publicContextTools);
const toolName=closed(TOOL_CATEGORY.keys());
const jobType=closed([...AGENT_ACTION_IDS,...SEMANTIC_ACTIONS.map(action=>action.id),...Object.keys(WORK_JOB_TYPES)]);
const gateReason=closed(Object.keys(TURN_GATE_NOTE));
const retryReason=closed([...HARNESS_VOCABULARY.retryReasons,...HARNESS_VOCABULARY.replyChecks]);
const budgetReason=closed(HARNESS_VOCABULARY.budgets);
const refusalReason=closed(['not_offered','invalid_input','not_permitted','unknown_handle','missing_details','not_available','not_found','repeat']);
const callStatus=closed(['refused','not_offered','invalid_input','unknown_handle','repeat','error']);
const checkName=closed([...HARNESS_VOCABULARY.replyChecks,...SEMANTIC_ACTIONS.flatMap(action=>action.checks.map(check=>check.check)),'turn_gate']);
const role=closed(roleEnum.enumValues);

const CLASSIFY:Readonly<Record<SignalKind,Classification>>={
 no_guide_found:'missing_context',no_tool_or_action:'missing_capability',
 // A rejected suggestion is one the review did not fit; one accepted and later undone was wrong in substance.
 suggestion_rejected:'interface_gap',suggestion_reversed:'harness_defect',
 needs_review_fallback:'harness_defect',reply_check_retry:'harness_defect',tool_call_failure:'harness_defect',guard_block:'guard_gap',
};
/** A guard block that only says the product cannot take the input (a file) is an interface gap, not a guard question. */
const classify=(signal:SignalKind,category:string):Classification=>signal==='guard_block'&&category==='attachment'?'interface_gap':CLASSIFY[signal];

type TraceView=Readonly<{roles:readonly string[];gateReason:string|null;calls:readonly Readonly<{tool:string;status:string;refusal?:string}>[];retries:readonly string[]}>;
/** Only the trace fields triage reads, each checked for shape; a malformed trace reads as empty. */
function traceView(trace:unknown):TraceView{
 const value=trace&&typeof trace==='object'?trace as Record<string,unknown>:{};
 const caller=value.caller&&typeof value.caller==='object'?value.caller as Record<string,unknown>:{};
 const gate=value.gate&&typeof value.gate==='object'?value.gate as Record<string,unknown>:{};
 const list=(item:unknown)=>Array.isArray(item)?item.filter(row=>row&&typeof row==='object') as Record<string,unknown>[]:[];
 return{roles:Array.isArray(caller.roles)?caller.roles.map(role):[],gateReason:gate.reason==null?null:gateReason(gate.reason),
  calls:list(value.calls).map(call=>({tool:String(call.tool??''),status:String(call.status??''),...(typeof call.refusal==='string'?{refusal:call.refusal}:{})})),
  retries:list(value.retries).map(retry=>retryReason(retry.reason))};
}

type Hit=Readonly<{signal:SignalKind;category:string}>;
/** The signals one record raises. Categories are already closed-vocabulary strings. */
function hitsOf(record:SignalRecord,trace:TraceView):Hit[]{
 const hits:Hit[]=[];const outcome=record.outcome??{};
 const reads:{tool:string;status:string;refusal?:string}[]=(trace.calls.length?trace.calls:record.reads.map(read=>({tool:read.tool,status:read.status}))).map(call=>({...call,tool:toolName(call.tool)}));
 if(outcome.mode==='honest_gap'){
  const privateCategories=[...new Set(reads.filter(call=>call.tool!==OTHER&&!PUBLIC_CONTEXT.has(call.tool)&&TOOL_CATEGORY.get(call.tool)!=='actions').map(call=>TOOL_CATEGORY.get(call.tool)!))];
  const guidance=reads.some(call=>call.tool==='product_guidance');
  if(guidance&&!privateCategories.length)hits.push({signal:'no_guide_found',category:'product_context'});
  else for(const category of privateCategories.length?privateCategories:['none'])hits.push({signal:'no_tool_or_action',category});
 }
 if(record.outcomeKind==='fallback'||outcome.fallback===true){
  const budget=outcome.budgetExhausted;
  hits.push({signal:'needs_review_fallback',category:typeof budget==='string'?'budget_'+budgetReason(budget):'reply_check'});
 }
 for(const check of record.checks)if(check.result==='needs_review'&&check.check!=='turn_gate')hits.push({signal:'needs_review_fallback',category:'check_'+checkName(check.check)});
 if(trace.gateReason)hits.push({signal:'guard_block',category:trace.gateReason});
 for(const call of reads){
  if(call.status==='refused'){const reason=refusalReason(call.refusal);
   if(reason==='not_permitted')hits.push({signal:'guard_block',category:'tool_not_permitted'});else hits.push({signal:'tool_call_failure',category:call.tool});}
  else if(callStatus(call.status)!==OTHER)hits.push({signal:'tool_call_failure',category:call.tool});
 }
 for(const retry of trace.retries)hits.push({signal:'reply_check_retry',category:retry});
 if(record.decision==='rejected')hits.push({signal:'suggestion_rejected',category:suggestedJob(record)});
 if(record.decision==='undone')hits.push({signal:'suggestion_reversed',category:suggestedJob(record)});
 return hits;
}
const suggestedJob=(record:SignalRecord):string=>jobType(record.runKind==='mandate_run'?record.outcome?.jobType:record.outcome?.suggestion);
const suggests=(record:SignalRecord)=>record.runKind==='mandate_run'?record.outcomeKind==='prepared':record.outcomeKind==='suggested'||typeof record.outcome?.suggestion==='string';

const bump=(map:Map<string,number>,key:string)=>map.set(key,(map.get(key)??0)+1);
const sorted=(map:ReadonlyMap<string,number>):Record<string,number>=>Object.fromEntries([...map].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])));

/** Triages a tenant's records into the aggregated report. Pure. */
export function triageSignals(records:readonly SignalRecord[]):SignalReport{
 const everyone=new Set<string>(),suggestions=new Map<string,{accepted:number;rejected:number;reversed:number;open:number}>();
 const noTool=new Map<string,number>(),noGuide=new Map<string,number>(),fallbacks=new Map<string,number>(),guards=new Map<string,number>(),retries=new Map<string,number>(),failures=new Map<string,number>();
 const clusters=new Map<string,{signal:SignalKind;category:string;count:number;people:Set<string>;roles:Set<string>}>();
 let turns=0,mandateRuns=0;
 for(const record of records){
  if(record.runKind==='mandate_run')mandateRuns++;else turns++;
  const person=record.askedByUserId??record.grantorUserId;if(person)everyone.add(person);
  const trace=traceView(record.trace);
  if(suggests(record)){const job=suggestedJob(record),tally=suggestions.get(job)??{accepted:0,rejected:0,reversed:0,open:0};
   if(record.decision==='accepted'||record.decision==='completed')tally.accepted++;else if(record.decision==='rejected')tally.rejected++;else if(record.decision==='undone')tally.reversed++;else tally.open++;
   suggestions.set(job,tally);}
  for(const hit of hitsOf(record,trace)){
   const into={no_tool_or_action:noTool,no_guide_found:noGuide,needs_review_fallback:fallbacks,guard_block:guards,reply_check_retry:retries,tool_call_failure:failures}[hit.signal as string];
   if(into)bump(into,hit.category);
   const key=hit.signal+':'+hit.category,cluster=clusters.get(key)??{signal:hit.signal,category:hit.category,count:0,people:new Set<string>(),roles:new Set<string>()};
   cluster.count++;if(person)cluster.people.add(person);for(const name of trace.roles)cluster.roles.add(name);
   clusters.set(key,cluster);
  }
 }
 const ranked=[...clusters].map(([key,cluster])=>({key,signal:cluster.signal,category:cluster.category,classification:classify(cluster.signal,cluster.category),
  count:cluster.count,people:cluster.people.size,roles:[...cluster.roles].sort()}))
  .sort((a,b)=>b.people-a.people||b.roles.length-a.roles.length||b.count-a.count||a.key.localeCompare(b.key))
  .map((cluster,index)=>({...cluster,rank:index+1}));
 return freeze({kind:'teras.improvement-signals' as const,version:1 as const,
  records:{total:records.length,turns,mandateRuns,people:everyone.size},
  suggestions:Object.fromEntries([...suggestions].sort((a,b)=>a[0].localeCompare(b[0]))),
  replies:{noToolOrAction:sorted(noTool),noGuideFound:sorted(noGuide)},
  fallbacks:sorted(fallbacks),guardBlocks:sorted(guards),replyCheckRetries:sorted(retries),toolCallFailures:sorted(failures),clusters:ranked});
}

/** A turn not yet persisted, read as the record it would become: pass the input the trace persistence builds
 * from a harness trace (outcomeRecordFromTrace). */
export function signalRecordFromOutcomeInput(input:OutcomeRecordInput):SignalRecord{
 return{runKind:input.runKind,outcomeKind:input.outcomeKind,askedByUserId:input.authority.kind==='person'?input.authority.askedByUserId:null,
  grantorUserId:input.authority.kind==='mandate'?input.authority.grantorUserId:null,outcome:input.outcome,checks:input.checks,reads:input.reads,trace:input.trace??null,decision:null};
}

/** The caller's tenant's report, from the outcome records the caller may see (RLS: who asked, the grantor,
 * group administrators). Read only. */
export async function readTenantSignals(ctx:SessionContext,options:Readonly<{limit?:number}>={}):Promise<SignalReport>{
 return triageSignals(await listOutcomeRecords(ctx,{limit:options.limit??500}));
}
