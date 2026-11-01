/** ADR-0170 §4 and §11.3 change 4, step 1 — the turn runner: the tool-using Assistant loop as product code.
 *
 * One turn, in order, every rule read from HARNESS_SPEC (./spec.ts):
 *  1. switch: refuses unless a test enables it (no production entry point imports this module);
 *  2. pre-read gate (lib/product-context/request-gate.ts gateTurn) on the person's own words, with the spec's
 *     sensitive topics: a workplace-harms request ends here with the spec's fixed refusal, and a crisis turn
 *     with the spec's fixed safe message, both without a model call;
 *  3. offer: the caller's candidate tools (./tools.ts), filtered by the gate, the spec's offer policy and the
 *     caller's own narrowing; fixed for the turn, so nothing a tool returns can widen it;
 *  4. task memory loaded and re-authorised for the current caller (./memory.ts);
 *  5. bounded loop: step, token, wall-time and spend budgets; identical calls never re-run; the last step
 *     offers only final_answer; one retry for a blank, unreadable or cut-off final answer;
 *  6. each call: offered? arguments valid? handles issued to this caller this turn? then run by its owner
 *     AS THE CALLER, disclosed under the semantic model (./disclosure.ts) and fenced as untrusted (./fence.ts);
 *  7. reply checks (./reply-checks.ts), one corrective retry, then the spec's fixed fallback: never blank;
 *  8. exact figures restored only for values this caller may see (./restore.ts); a sensitive-topic turn then
 *     gets the spec's contact route after the reply and keeps its words out of task memory;
 *  9. a trace (./trace.ts) for the outcome record.
 * It returns a reply, an optional suggestion (a pointer to a review page) and the caller's still-valid open
 * proposals (core/proposals objects). It never prepares, confirms or writes a change. */
import {createHash,randomUUID} from 'node:crypto';
import type {SessionContext} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {gateTurn,isSensitiveReason,TURN_GATE_NOTE} from '../../lib/product-context/request-gate';
import {canonicalJson,type Proposal} from '../proposals/proposal';
import {DisclosureLedger,discloseToolOutput,type DisclosureApplied} from './disclosure';
import {fenceNonce,fenceUntrusted} from './fence';
import {advanceMemory,authorityKey,emptyMemory,memoryNote,reauthoriseMemory,type TaskMemory,type TaskMemoryStore} from './memory';
import type {HarnessMessage,HarnessToolDeclaration,ModelClient,ModelResponse} from './model-client';
import {checkReply,type ReplyCheckResult} from './reply-checks';
import {restoreFigures} from './restore';
import {HARNESS_SPEC,harnessSpecDigest} from './spec';
import {invalidInput,nativeToolProvider,type ToolBinding,type ToolProvider,type ToolScope} from './tools';
import type {BudgetExhausted,TraceCall,TraceRetry,TurnTrace} from './trace';

/** The only value that enables the runner, and only inside a test process. The per-tenant switch arrives
 * with wiring, after the ADR-0169 §5.1 privacy review. */
export const HARNESS_TEST_ONLY='enabled-in-tests-only' as const;
export class HarnessDisabled extends Error{constructor(){super('The Teras harness is switched off.');this.name='HarnessDisabled';}}
const testProcess=()=>process.env.VITEST==='true'||process.env.NODE_ENV==='test';

export type TurnOptions=Readonly<{
 enabled:typeof HARNESS_TEST_ONLY;
 ctx:SessionContext;conversationId:string;question:string;
 history?:readonly Readonly<{role:'user'|'assistant';content:string}>[];
 scope:ToolScope;model:ModelClient;memory:TaskMemoryStore;
 /** The caller's own narrowing of the offer, e.g. a surface that only answers leave questions. */
 allowTools?:readonly string[];
 /** Defaults to the native owners. Tests may substitute bindings; the offer policy still applies. */
 tools?:ToolProvider;
 clock?:()=>Date;
}>;
export type TurnSuggestion=Readonly<{action:string;reviewRoute:string;inlineCard:boolean}>;
export type TurnResult=Readonly<{reply:string;mode:string|null;slot:string|null;suggestion:TurnSuggestion|null;
 /** The caller's open proposals, each verified again this turn. The harness never creates or confirms one. */
 proposals:readonly Proposal[];
 /** Names of reads and context tools that returned data this turn. */
 reads:readonly string[];trace:TurnTrace;memory:TaskMemory}>;

const S=HARNESS_SPEC;
const finalDeclaration:HarnessToolDeclaration=Object.freeze({name:S.offer.finalTool,description:S.offer.finalDescription,parameters:{type:'object',
 properties:{mode:{type:'string',enum:[...S.offer.finalModes]},slot:{type:'string',enum:[...S.offer.finalSlots]},reply:{type:'string'}},required:['mode','reply'],additionalProperties:false}});
const digestOf=(value:string)=>createHash('sha256').update(value).digest('hex');
const argumentsDigest=(raw:string)=>{try{return digestOf(canonicalJson(JSON.parse(raw||'{}')));}catch{return digestOf(raw);}};

/** Which candidates this turn offers. Pure; the gate and the spec decide, never the model or a tool. */
export function offerFor(bindings:readonly ToolBinding[],gate:ReturnType<typeof gateTurn>,allowTools?:readonly string[]):readonly ToolBinding[]{
 const publicContext:readonly string[]=S.offer.publicContextTools,actionTools:readonly string[]=S.offer.actionTools;
 return bindings.filter(binding=>{
  if(allowTools&&!allowTools.includes(binding.name))return false;
  if(actionTools.includes(binding.name)&&!gate.actions)return false;
  if(binding.kind==='suggest')return gate.actions;
  if(binding.kind==='read')return gate.privateReads;
  return gate.privateReads||publicContext.includes(binding.name);
 });
}

/** The spec's contact route for a sensitive-topic turn. */
export function routeReply():string{
 const {contact,routeReply:template,caseClause}=S.sensitive,route:string|null=contact.caseRoute;
 return template.replace('{contact}',contact.label).replace('{case}',route?caseClause.replace('{route}',route):'');
}

export async function runTurn(options:TurnOptions):Promise<TurnResult>{
 if(options.enabled!==HARNESS_TEST_ONLY||!testProcess())throw new HarnessDisabled();
 const clock=options.clock??(()=>new Date()),started=clock(),startedMs=Date.now(),{ctx,model}=options;
 const callerKey=authorityKey(ctx),gate=gateTurn(options.question,{sensitive:S.sensitive.topics}),admin=isAdmin(ctx);
 const reason=gate.privateReads?null:gate.reason,refused=reason==='workplace_harm',crisis=reason==='sensitive_crisis',routed=isSensitiveReason(reason);
 // Crisis turns never reach the model: in run 41307457954 the provider answered every one with a bare refusal.
 const fixed=refused||crisis;
 const candidates=await (options.tools??nativeToolProvider)(ctx,options.scope,gate.actions);
 // A fixed turn offers nothing: the model is never called.
 const offered=fixed?[]:offerFor(candidates.bindings,gate,options.allowTools),offeredNames=new Set(offered.map(binding=>binding.name));

 // Task memory: loaded for this tenant and user only, then re-authorised against what the caller is offered now.
 const stored=await options.memory.load(ctx.tenantId,ctx.userId??'',options.conversationId)??emptyMemory(ctx,options.conversationId,started);
 const callerReads=new Set(candidates.bindings.filter(binding=>binding.kind==='read').map(binding=>binding.name));
 const {memory:current,result:memoryResult}=reauthoriseMemory(stored,ctx,callerReads,started);

 const gateNote=gate.privateReads?null:TURN_GATE_NOTE[gate.reason],note=memoryNote(current);
 const system=[S.instructions.join(' ').replace('{today}',todayInKualaLumpur(started)),admin?S.roleNote.admin:S.roleNote.employee,...(gateNote?[gateNote]:[]),...(note?[note]:[])].join(' ');
 const messages:HarnessMessage[]=[{role:'system',content:system},...(options.history??[]).map(row=>({role:row.role,content:row.content}) as HarnessMessage),{role:'user',content:options.question}];
 const declarations:HarnessToolDeclaration[]=[...offered.map(binding=>({name:binding.name,description:binding.spec.description,parameters:binding.spec.inputSchema as Record<string,unknown>})),finalDeclaration];

 const ledger=new DisclosureLedger(callerKey),nonce=fenceNonce(),seen=new Set<string>();
 const calls:TraceCall[]=[],disclosure:DisclosureApplied[]=[],checks:{attempt:number;results:readonly ReplyCheckResult[]}[]=[],retries:TraceRetry[]=[],reads:string[]=[];
 let steps=0,inputTokens=0,outputTokens=0,spendUsd=0,repeats=0,forceFinal=false,blankRetries=0,checkRetries=0,retryPending=false;
 let suggestion:TurnSuggestion|null=null,exhausted:BudgetExhausted|null=null,reply:string|null=null,mode:string|null=null,slot:string|null=null,fallback=false;
 const allowedPaths=()=>new Set([...candidates.destinations,...(suggestion?[suggestion.reviewRoute]:[])].map(path=>path.replace(/\/$/,'')||'/'));

 /** Runs the checks on a candidate reply; returns true when the turn may end with it. */
 const judge=(candidate:string,candidateMode:string|null,candidateSlot:string|null)=>{
  const results=checkReply(candidate,allowedPaths(),S.replyChecks.order);checks.push({attempt:checks.length+1,results});
  const failed=results.find(result=>!result.ok);
  if(!failed){reply=candidate;mode=candidateMode;slot=candidateSlot;return true;}
  if(checkRetries<S.retry.replyCheck){checkRetries++;retries.push({step:steps,reason:failed.check});retryPending=true;
   messages.push({role:'system',content:S.retryNotes[failed.check]});return false;}
  reply=S.replyChecks.fallbackReply;mode=null;slot=null;fallback=true;return true;
 };

 // Workplace-harms rule (principle 8) and crisis: decided from the wording alone, before any model call.
 if(refused){reply=S.sensitive.workplaceHarmReply;mode='refuse';}
 else if(crisis)reply=S.sensitive.crisisReply;
 else for(;;){
  const wallMs=Date.now()-startedMs;
  exhausted=steps>=S.budgets.maxSteps?'steps':inputTokens+outputTokens>=S.budgets.maxTotalTokens?'tokens':wallMs>=S.budgets.maxWallMs?'time':spendUsd>=S.budgets.maxSpendUsd?'spend':null;
  if(exhausted){reply=S.replyChecks.budgetReply;fallback=true;break;}
  const finalOnly=forceFinal||retryPending||steps===S.budgets.maxSteps-1;retryPending=false;
  let response:ModelResponse;
  try{response=await model.complete({messages,tools:finalOnly?[finalDeclaration]:declarations,toolChoice:S.offer.toolChoice,maxOutputTokens:S.budgets.maxOutputTokensPerCall,
   signal:AbortSignal.timeout(Math.max(1,Math.min(S.budgets.callTimeoutMs,S.budgets.maxWallMs-wallMs)))});}
  finally{steps++;}
  inputTokens+=response.usage.inputTokens;outputTokens+=response.usage.outputTokens;spendUsd+=response.usage.costUsd;
  const final=response.toolCalls.find(call=>call.name===S.offer.finalTool);
  if(final){
   let args:Record<string,unknown>|null=null;try{const parsed=JSON.parse(final.arguments||'{}');args=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:null;}catch{args=null;}
   // A final answer cut off at the output cap, or unreadable, is asked for once more (shorter) rather than shown blank.
   if((!args||response.finish==='length')&&blankRetries<S.retry.blankOrTruncated){blankRetries++;const reason=response.finish==='length'?'truncated':'blank';
    retries.push({step:steps,reason});retryPending=true;messages.push({role:'system',content:S.retryNotes[reason]});continue;}
   const text=typeof args?.reply==='string'?args.reply:'';
   if(judge(text,typeof args?.mode==='string'?args.mode:null,typeof args?.slot==='string'?args.slot:null))break;
   continue;
  }
  if(!response.toolCalls.length){if(judge(response.content??'',null,null))break;continue;}
  messages.push({role:'assistant',content:response.content,toolCalls:response.toolCalls});
  for(const call of response.toolCalls){
   const record=(status:TraceCall['status'],content:unknown,refusal?:string)=>{calls.push({step:steps,tool:call.name,status,argumentsDigest:argumentsDigest(call.arguments),...(refusal?{refusal}:{})});
    messages.push({role:'tool',toolCallId:call.id,content:fenceUntrusted(call.name,content,nonce)});};
   // On a final-only step nothing but final_answer was offered, so any other call is refused.
   const binding=finalOnly?undefined:offered.find(row=>row.name===call.name);
   if(!binding){record('not_offered',{ok:false,message:'This tool is not available for this request.'});continue;}
   let input:Record<string,unknown>;
   try{const parsed=JSON.parse(call.arguments||'{}');if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();input=parsed;}
   catch{record('invalid_input',{ok:false,message:'The arguments could not be read.'});continue;}
   const key=call.name+':'+canonicalJson(input);
   if(seen.has(key)){repeats++;if(repeats>=S.repeatCall.forceFinalAfter)forceFinal=true;record('repeat',{ok:false,message:'Already retrieved above in this turn; use that result.'});continue;}
   seen.add(key);
   const problem=invalidInput(binding.spec.inputSchema as Record<string,unknown>,input);
   if(problem){record('invalid_input',{ok:false,message:'Invalid arguments: '+problem+'.'});continue;}
   // Record handles go back to the ids they stand for, only when this turn issued them to this caller.
   let unknownHandle=false;const resolved={...input};
   for(const name of binding.identifierInputs){if(resolved[name]===undefined)continue;const handle=ledger.handles.get(String(resolved[name]));
    if(!handle||handle.callerKey!==callerKey){unknownHandle=true;break;}resolved[name]=handle.value;}
   if(unknownHandle){record('unknown_handle',{ok:false,message:'Use a handle exactly as an earlier result in this conversation turn gave it; never guess one.'});continue;}
   let run:Awaited<ReturnType<ToolBinding['run']>>;
   try{run=await binding.run(resolved);}catch{record('error',{ok:false,message:'This source is unavailable for this request.'});continue;}
   const disclosed=discloseToolOutput(binding.name,binding.kind==='read'?binding.entity:null,run.content,ledger);disclosure.push(disclosed.applied);
   if(run.ok&&binding.kind!=='suggest')reads.push(binding.name);
   if(run.suggestion)suggestion=run.suggestion;
   record(run.ok?'ok':'refused',disclosed.value,run.refusal);
  }
 }

 const shown=reply??S.replyChecks.fallbackReply;
 const restoration=fallback||fixed?{reply:shown,restored:0,refused:[]}:restoreFigures(shown,ledger,callerKey,offeredNames);
 // A routed turn always ends with the contact route, whatever the model wrote (a crisis turn: the safe message, then the route).
 const shownReply=routed?[restoration.reply,routeReply()].join('\n\n'):restoration.reply;
 const finished=clock();
 // The person's words on a routed or refused turn never become the conversation goal in task memory.
 const advanced=advanceMemory(current,{question:options.question,reads,slot,mode},finished);
 const next=routed||refused?{...advanced,goal:current.goal}:advanced;
 await options.memory.save(next);
 const trace:TurnTrace=Object.freeze({kind:'teras.turn-trace',version:1,turnId:randomUUID(),conversationId:options.conversationId,startedAt:started.toISOString(),finishedAt:finished.toISOString(),
  spec:{version:S.version,digest:harnessSpecDigest()},model:{id:model.modelId},
  caller:{tenantId:ctx.tenantId,userId:ctx.userId??null,personId:ctx.personId??null,roles:[...(ctx.roles??[])],authorityKey:callerKey},
  gate:{privateReads:gate.privateReads,actions:gate.actions,reason},
  offered:[...offeredNames],calls,disclosure,checks,retries,
  budgets:{steps,inputTokens,outputTokens,spendUsd:Number(spendUsd.toFixed(6)),wallMs:Date.now()-startedMs,exhausted},
  restoration:{restored:restoration.restored,refused:restoration.refused},memory:memoryResult,
  outcome:{mode,slot,suggestion:suggestion?.action??null,openProposals:next.openProposals.length,fallback}});
 return Object.freeze({reply:shownReply,mode,slot,suggestion,proposals:next.openProposals,reads:Object.freeze(reads),trace,memory:next});
}
