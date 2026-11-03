/** ADR-0170 §4 and §11.3 change 4, step 1 — the turn runner: the tool-using Assistant loop as product code.
 *
 * One turn, in order, every rule read from HARNESS_SPEC (./spec.ts):
 *  1. switch: refuses unless a test enables it, or the tenant's Noveri conversation switch issued a single-use
 *     permit for this tenant and login (./permit.ts; only core/teras-wiring imports this module);
 *  2. pre-read gate (lib/product-context/request-gate.ts gateTurn) on the person's own words, with the spec's
 *     sensitive topics: a workplace-harms or rule-override request ends here with the spec's fixed refusal, a crisis turn with the
 *     spec's fixed safe message and the contact route, and every other sensitive topic with the contact route,
 *     all without a model call;
 *  3. offer: the caller's candidate tools (./tools.ts), filtered by the gate, the spec's offer policy and the
 *     caller's own narrowing; fixed for the turn, so nothing a tool returns can widen it;
 *  4. task memory loaded and re-authorised for the current caller (./memory.ts); the question, the history (the
 *     model-side transcript only) and the memory note screened for identifiers before anything is sent;
 *  5. bounded loop: step, token, wall-time and spend budgets; identical calls never re-run; the last step
 *     offers only final_answer; one retry for a blank, unreadable or cut-off final answer;
 *  6. each call: offered? arguments valid? handles issued to this caller this turn? then run by its owner
 *     AS THE CALLER, disclosed under the semantic model (./disclosure.ts) and fenced as untrusted (./fence.ts);
 *  7. reply checks (./reply-checks.ts), one corrective retry, then the spec's fixed fallback: never blank;
 *  8. exact figures restored only for values this caller may see (./restore.ts); a sensitive-topic turn then
 *     gets the spec's contact route after the reply and keeps its words out of task memory;
 *  9. a trace (./trace.ts) for the outcome record, and the turn twice over: as the person saw it (restored) and as
 *     the model may see it again (modelTurn: bands and markers, never a restored value), which is the only
 *     history a later turn accepts.
 * It returns a reply, an optional suggestion (a pointer to a review page) and the caller's still-valid open
 * proposals (core/proposals objects), including any a native preparer issued for this turn's suggestion. It
 * never confirms or writes a change. */
import {createHash,randomUUID} from 'node:crypto';
import type {SessionContext} from '../../db/client';
import {canManagePayroll,isAdmin,isGroupAdmin,withEffectiveGrants} from '../../lib/authz-model';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {PAY_VIEW_PURPOSE,payViewDestinationFor} from '../../lib/product-context/destinations';
import {gateTurn,isSensitiveReason,TURN_GATE_NOTE} from '../../lib/product-context/request-gate';
import {capabilityOffered} from '../../lib/product-context/capability-intent';
import {chatImportFileInput} from '../../lib/chat-import';
import {chatImportKindsFor} from '../chat-import/kinds';
import {destinationLabel} from '../product-context/tools';
import {canonicalJson,type Proposal} from '../proposals/proposal';
import {DisclosureLedger,discloseToolOutput,type DisclosureApplied} from './disclosure';
import {fenceNonce,fenceUntrusted} from './fence';
import {advanceMemory,authorityKey,emptyMemory,memoryGoal,memoryNote,reauthoriseMemory,type TaskMemory,type TaskMemoryStore} from './memory';
import type {HarnessMessage,HarnessToolDeclaration,ModelClient,ModelResponse} from './model-client';
import {consumeHarnessPermit,type HarnessPermit} from './permit';
import {checkReply,screenIdentifiers,type ReplyCheckResult} from './reply-checks';
import {modelSide,restoreFigures} from './restore';
import {HARNESS_SPEC,harnessSpecDigest} from './spec';
import {invalidInput,nativeToolProvider,type ToolBinding,type ToolProvider,type ToolScope} from './tools';
import type {BudgetExhausted,TraceCall,TraceRetry,TurnTrace} from './trace';

/** Enables the runner inside a test process only. In production the runner runs only with a permit from the
 * per-tenant conversation switch (./permit.ts), wired after the ADR-0169 §5.1 owner sign-off of 2 November 2026. */
export const HARNESS_TEST_ONLY='enabled-in-tests-only' as const;
export class HarnessDisabled extends Error{constructor(){super('The Teras harness is switched off.');this.name='HarnessDisabled';}}
const testProcess=()=>process.env.VITEST==='true'||process.env.NODE_ENV==='test';

/** One message of the model-side transcript: what the model was sent or wrote, never what the person was shown.
 * Only a TurnResult's modelTurn produces these; a turn refuses any other history. */
export type ModelHistoryMessage=Readonly<{role:'user'|'assistant';content:string;side:'model'}>;
export class PersonSideHistory extends Error{constructor(){super('History must be the model-side transcript (TurnResult.modelTurn).');this.name='PersonSideHistory';}}
export type TurnOptions=Readonly<{
 enabled:typeof HARNESS_TEST_ONLY|HarnessPermit;
 ctx:SessionContext;conversationId:string;question:string;
 /** Earlier turns of the conversation, as the model-side transcript: the modelTurn of each earlier TurnResult. */
 history?:readonly ModelHistoryMessage[];
 scope:ToolScope;model:ModelClient;memory:TaskMemoryStore;
 /** The caller's own narrowing of the offer, e.g. a surface that only answers leave questions. */
 allowTools?:readonly string[];
 /** Defaults to the native owners. Tests may substitute bindings; the offer policy still applies. */
 tools?:ToolProvider;
 clock?:()=>Date;
 /** AI v2 W11: whether the protected case route is set up for this caller and company (core/private-case-route.ts).
  * Asked only on a routed sensitive turn, after the gate; it reads no case and nothing of the person's words. */
 caseRouteAvailable?:()=>Promise<boolean>;
}>;
export type TurnSuggestion=Readonly<{action:string;reviewRoute:string;inlineCard:boolean}>;
export type TurnResult=Readonly<{
 /** What the person is shown: exact figures and withheld text restored. Never sent to a model again. */
 reply:string;
 /** The person-side transcript of this turn (the person's words and the restored reply), for the surface. */
 personTurn:readonly Readonly<{role:'user'|'assistant';content:string}>[];
 /** The model-side transcript of this turn, to pass as history next turn: the screened question (or a marker on
  * a sensitive turn) and the reply as the model wrote it, figures as bands and withheld text as a marker. */
 modelTurn:readonly ModelHistoryMessage[];
 mode:string|null;slot:string|null;suggestion:TurnSuggestion|null;
 /** The caller's open proposals, each verified again this turn. The harness never creates or confirms one. */
 proposals:readonly Proposal[];
 /** Names of reads and context tools that returned data this turn. */
 reads:readonly string[];trace:TurnTrace;memory:TaskMemory;
 /** AI v2 W11: a routed sensitive turn for a caller whose company has the protected case route set up. */
 caseRoute:boolean}>;

const S=HARNESS_SPEC;
const finalDeclaration:HarnessToolDeclaration=Object.freeze({name:S.offer.finalTool,description:S.offer.finalDescription,parameters:{type:'object',
 properties:{mode:{type:'string',enum:[...S.offer.finalModes]},slot:{type:'string',enum:[...S.offer.finalSlots]},reply:{type:'string'}},required:['mode','reply'],additionalProperties:false}});
const digestOf=(value:string)=>createHash('sha256').update(value).digest('hex');
const argumentsDigest=(raw:string)=>{try{return digestOf(canonicalJson(JSON.parse(raw||'{}')));}catch{return digestOf(raw);}};

/** Which candidates this turn offers. Pure; the gate and the spec decide, never the model or a tool. Spec v17: the
 * capability catalogue (S.offer.capabilityTool) only when `capability`, the person's words asking what they can do, how,
 * or to import, set up, add or create something, or (v18) picking a numbered option of the previous turn's question
 * (lib/product-context/capability-intent.ts capabilityOffered); it is not a public context tool, so a gated turn never
 * has it. */
export function offerFor(bindings:readonly ToolBinding[],gate:ReturnType<typeof gateTurn>,allowTools?:readonly string[],capability=false):readonly ToolBinding[]{
 const publicContext:readonly string[]=S.offer.publicContextTools,actionTools:readonly string[]=S.offer.actionTools;
 return bindings.filter(binding=>{
  if(allowTools&&!allowTools.includes(binding.name))return false;
  if(binding.name===S.offer.capabilityTool&&!capability)return false;
  if(actionTools.includes(binding.name)&&!gate.actions)return false;
  if(binding.kind==='suggest')return gate.actions;
  if(binding.kind==='read')return gate.privateReads;
  return gate.privateReads||publicContext.includes(binding.name);
 });
}

/** Spec v11: the caller profile, from the session's own roles and grants (lib/authz-model.ts): employee; manager;
 * HR administrator with the companies their grants cover, or group administrator; payroll partner with theirs. It
 * describes and never grants: the offer is fixed before it by offerFor, which never reads it, and every tool and
 * review page still decides as the caller. Pure. */
export function roleNoteFor(ctx:SessionContext):string{
 const R=S.roleNote,grants=withEffectiveGrants(ctx).grants??[];
 const caller:SessionContext={...ctx,grants,roles:ctx.roles??[...new Set(grants.map(grant=>grant.role))]};
 const scopeOf=(roles:readonly string[])=>{const held=grants.filter(grant=>roles.includes(grant.role));
  if(held.some(grant=>grant.companyId==null))return R.scope.group;
  const companies=new Set(held.map(grant=>grant.companyId)).size;return companies>1?R.scope.many.replace('{n}',String(companies)):R.scope.one;};
 const parts:string[]=[ctx.personId?R.employee:R.noRecord];
 if(isGroupAdmin(caller))parts.push(R.groupAdmin);
 else if(isAdmin(caller))parts.push(R.admin.replace('{scope}',scopeOf(['hr_admin','super_admin'])));
 // An administrator already manages payroll (canManagePayroll unions the admin roles); a partner is described apart.
 if(!isAdmin(caller)&&canManagePayroll(caller))parts.push(R.payroll.replace('{scope}',scopeOf(['payroll_partner'])));
 if(caller.roles?.includes('manager'))parts.push(R.manager);
 parts.push(R.tools);
 return parts.join(' ');
}

/** Spec v11, issue 13: on a turn about another person, where a caller with payroll access can already see that
 * person's pay, from the destination registry and this caller's own linkable paths, so the link passes the
 * destination check. Null for a caller without payroll access: their turn is unchanged. No figure or id is in it. */
export function payViewNoteFor(ctx:SessionContext,destinations:readonly string[],locale?:string):string|null{
 if(!canManagePayroll(withEffectiveGrants(ctx)))return null;
 const page=payViewDestinationFor(ctx,destinations);
 return page?S.payView.page.replace('{label}',destinationLabel(page.labelKey,locale)).replace('{href}',page.href).replace('{purpose}',PAY_VIEW_PURPOSE[page.href]??'where they see the pay of the people they administer'):S.payView.none;
}

/** The spec's contact route for a sensitive-topic turn. AI v2 W11: the spec's case clause joins it only where the
 * protected case route is set up for the caller (`caseRoute`), and only once the spec names a route. */
export function routeReply(caseRoute=false):string{
 const {contact,routeReply:template,caseClause}=S.sensitive,route:string|null=caseRoute?contact.caseRoute:null;
 return template.replace('{contact}',contact.label).replace('{case}',route?caseClause.replace('{route}',route):'');
}

export async function runTurn(options:TurnOptions):Promise<TurnResult>{
 if(options.enabled===HARNESS_TEST_ONLY?!testProcess():!consumeHarnessPermit(options.enabled,options.ctx.tenantId,options.ctx.userId))throw new HarnessDisabled();
 const clock=options.clock??(()=>new Date()),started=clock(),startedMs=Date.now(),{ctx,model}=options;
 // AI v2 slice 3 (issue 16b): the attachment gate is lifted only for a turn carrying a chat import file that passes the
 // server's own file check again here, from a caller who may prepare an import in chat. Any other file is dropped from
 // the scope, and its words stay gated like any message about an attachment.
 const {importFile:postedFile,...scopeWithoutFile}=options.scope;
 const checkedFile=postedFile===undefined?null:chatImportFileInput(postedFile);
 const importUpload=checkedFile!==null&&(await chatImportKindsFor(ctx)).length>0;
 const scope:ToolScope=importUpload&&checkedFile?{...scopeWithoutFile,importFile:checkedFile}:scopeWithoutFile;
 const callerKey=authorityKey(ctx),gate=gateTurn(options.question,{sensitive:S.sensitive.topics,importUpload});
 const reason=gate.privateReads?null:gate.reason,refused=reason==='workplace_harm'||reason==='instruction_override',crisis=reason==='sensitive_crisis',routed=isSensitiveReason(reason);
 // Crisis turns never reach the model (run 41307457954: the provider answered every one with a bare refusal), and
 // since spec v6 no sensitive-topic turn does: the person's words about health, harassment, a grievance or a
 // threat of dismissal are not sent to a provider at all.
 const fixed=refused||routed;
 const history=options.history??[];
 if(history.some(row=>row?.side!=='model'))throw new PersonSideHistory();
 const candidates=await (options.tools??nativeToolProvider)(ctx,{...scope,personWords:options.question},gate.actions);

 // Task memory: loaded for this tenant and user only, then re-authorised against what the caller is offered now.
 const stored=await options.memory.load(ctx.tenantId,ctx.userId??'',options.conversationId)??emptyMemory(ctx,options.conversationId,started);
 const callerReads=new Set(candidates.bindings.filter(binding=>binding.kind==='read').map(binding=>binding.name));
 const {memory:current,result:memoryResult}=reauthoriseMemory(stored,ctx,callerReads,started);
 // A fixed turn offers nothing: the model is never called. Spec v18: an answer picking one option of the previous turn's
 // question (re-authorised task memory's pendingQuestion) keeps the catalogue offered, so that entry can be acted on.
 const offered=fixed?[]:offerFor(candidates.bindings,gate,options.allowTools,capabilityOffered(options.question,current.pendingQuestion)),offeredNames=new Set(offered.map(binding=>binding.name));

 // Identifiers never leave: the question, the history and the memory note are screened before any model call.
 const screening={question:0,history:0,memory:0,tools:0,kinds:[] as string[]};
 const screened=(text:string,part:'question'|'history'|'memory')=>{const result=screenIdentifiers(text);screening[part]+=result.count;
  for(const kind of result.kinds)if(!screening.kinds.includes(kind))screening.kinds.push(kind);return result.text;};
 const question=screened(options.question,'question'),nonce=fenceNonce();
 // Spec v12: the person's (screened) words go to the model labelled, unchanged; the gate, tools, history and memory
 // keep the bare words. Unlabelled, the upstream's content filter stopped everyday questions (spec.question).
 const asked=S.question.label+'\n'+question;
 const gateNote=gate.privateReads?null:TURN_GATE_NOTE[gate.reason],rawNote=memoryNote(current),note=rawNote?screened(rawNote,'memory'):null;
 // A turn about another person closes every private read; a caller with payroll access is told where they already see pay.
 const payNote=!gate.privateReads&&gate.reason==='other_person'?payViewNoteFor(ctx,candidates.destinations,options.scope.locale):null;
 // Review H2: the goal (the person's earlier words) travels fenced in the person's own message, never in system text.
 const rawGoal=memoryGoal({...current,goal:current.goal?screened(current.goal,'memory'):null},value=>fenceUntrusted('conversation_goal',value,nonce));
 const system=[S.instructions.join(' ').replace('{today}',todayInKualaLumpur(started)),roleNoteFor(ctx),...(gateNote?[gateNote]:[]),...(payNote?[payNote]:[]),...(note?[note]:[])].join(' ');
 // Review M8: the newest earlier turns up to the spec's character cap; the kept history starts with the person's turn.
 const kept:ModelHistoryMessage[]=[];let historyChars=0;
 for(const row of [...history].reverse()){historyChars+=row.content.length;if(historyChars>S.budgets.maxHistoryChars)break;kept.unshift(row);}
 while(kept.length&&kept[0].role!=='user')kept.shift();
 const messages:HarnessMessage[]=[{role:'system',content:system},...kept.map(row=>({role:row.role,content:screened(row.content,'history')}) as HarnessMessage),
  {role:'user',content:(rawGoal?rawGoal+'\n\n':'')+asked}];
 const declarations:HarnessToolDeclaration[]=[...offered.map(binding=>({name:binding.name,description:binding.spec.description,parameters:binding.spec.inputSchema as Record<string,unknown>})),finalDeclaration];

 const ledger=new DisclosureLedger(callerKey),seen=new Set<string>();
 const calls:TraceCall[]=[],disclosure:DisclosureApplied[]=[],checks:{attempt:number;results:readonly ReplyCheckResult[]}[]=[],retries:TraceRetry[]=[],reads:string[]=[];
 let steps=0,inputTokens=0,outputTokens=0,spendUsd=0,repeats=0,turnCalls=0,refusedCalls=0,forceFinal=false,blankRetries=0,checkRetries=0,retryPending=false;
 const issued:Proposal[]=[];
 let suggestion:TurnSuggestion|null=null,exhausted:BudgetExhausted|null=null,reply:string|null=null,mode:string|null=null,slot:string|null=null,fallback=false;
 const allowedPaths=()=>new Set([...candidates.destinations,...(suggestion?[suggestion.reviewRoute]:[])].map(path=>path.replace(/\/$/,'')||'/'));

 /** Runs the checks on a candidate reply; returns true when the turn may end with it. */
 const judge=(candidate:string,candidateMode:string|null,candidateSlot:string|null)=>{
  // "Prepared … for you to review and confirm" is admitted only when this turn issued a proposal (a prepared card).
  const results=checkReply(candidate,allowedPaths(),S.replyChecks.order,{question:options.question,prepared:issued.length>0});checks.push({attempt:checks.length+1,results});
  const failed=results.find(result=>!result.ok);
  if(!failed){reply=candidate;mode=candidateMode;slot=candidateSlot;return true;}
  if(checkRetries<S.retry.replyCheck){checkRetries++;retries.push({step:steps,reason:failed.check});retryPending=true;
   messages.push({role:'system',content:S.retryNotes[failed.check]});return false;}
  reply=S.replyChecks.fallbackReply;mode=null;slot=null;fallback=true;return true;
 };

 // Workplace-harms rule (principle 8) and sensitive topics: decided from the wording alone, before any model call.
 // A routed turn other than crisis is answered by the contact route alone (below).
 if(refused){reply=reason==='instruction_override'?S.sensitive.instructionOverrideReply:S.sensitive.workplaceHarmReply;mode='refuse';}
 else if(crisis)reply=S.sensitive.crisisReply;
 else if(routed)reply='';
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
  // Review M7: a response whose calls exceed the per-step or per-turn cap is not trusted at all. None of its calls
  // runs; each is answered as refused and counted, and the turn is forced to its final answer. Otherwise the calls
  // run one after another, in the order returned, each through the same checks as a single call.
  if(response.toolCalls.length>S.budgets.maxCallsPerStep||turnCalls+response.toolCalls.length>S.budgets.maxCallsPerTurn){
   refusedCalls+=response.toolCalls.length;forceFinal=true;
   for(const call of response.toolCalls)messages.push({role:'tool',toolCallId:call.id,content:fenceUntrusted(call.name,{ok:false,message:'Too many lookups at once; ask for fewer.'},nonce)});
   continue;
  }
  turnCalls+=response.toolCalls.length;
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
   // Reads and suggest_action are disclosed under their declared entity; context tools (no entity) are swept.
   const disclosed=discloseToolOutput(binding.name,binding.entity,run.content,ledger,{namesInScope:run.namesInScope});disclosure.push(disclosed.applied);
   screening.tools+=disclosed.applied.identifiers;for(const kind of disclosed.applied.identifierKinds)if(!screening.kinds.includes(kind))screening.kinds.push(kind);
   if(run.ok&&binding.kind!=='suggest')reads.push(binding.name);
   if(run.suggestion)suggestion=run.suggestion;
   if(run.proposal)issued.push(run.proposal);
   record(run.ok?'ok':'refused',disclosed.value,run.refusal);
  }
 }

 const shown=reply??S.replyChecks.fallbackReply;
 const restoration=fallback||fixed?{reply:shown,restored:0,refused:[]}:restoreFigures(shown,ledger,callerKey,offeredNames);
 // A routed turn ends with the contact route (a crisis turn: the safe message first, then the route). AI v2 W11: the
 // case route is asked about only now, on a routed turn; a failure keeps the contact route alone.
 const caseRoute=routed&&options.caseRouteAvailable?await options.caseRouteAvailable().then(value=>value===true,()=>false):false;
 const shownReply=routed?[restoration.reply,routeReply(caseRoute)].filter(Boolean).join('\n\n'):restoration.reply;
 // The two transcripts part here: the person sees shownReply; a later model call may only see modelTurn.
 const modelTurn:readonly ModelHistoryMessage[]=Object.freeze([
  Object.freeze({role:'user' as const,content:routed?S.history.routedQuestion:reason==='instruction_override'?S.history.overrideQuestion:refused?S.history.refusedQuestion:question,side:'model' as const}),
  Object.freeze({role:'assistant' as const,content:fallback||fixed?shownReply:modelSide(shown,ledger),side:'model' as const})]);
 const personTurn=Object.freeze([Object.freeze({role:'user' as const,content:options.question}),Object.freeze({role:'assistant' as const,content:shownReply})]);
 const finished=clock();
 // Proposals issued this turn join the open ones, newest first; each is re-verified at the next turn's start.
 // The person's words on a routed or refused turn never become the conversation goal in task memory; any other
 // goal is stored as screened (no identifier).
 const advanced=advanceMemory({...current,openProposals:[...issued.reverse(),...current.openProposals]},{question,reads,slot,mode},finished);
 // Review H2: only an ungated turn's words may become the goal; any gated turn (routed, refused, override, attachment,
 // another person) keeps the goal as it was.
 const next=gate.privateReads?advanced:{...advanced,goal:current.goal};
 await options.memory.save(next);
 const trace:TurnTrace=Object.freeze({kind:'teras.turn-trace',version:1,turnId:randomUUID(),conversationId:options.conversationId,startedAt:started.toISOString(),finishedAt:finished.toISOString(),
  spec:{version:S.version,digest:harnessSpecDigest()},model:{id:model.modelId},
  caller:{tenantId:ctx.tenantId,userId:ctx.userId??null,personId:ctx.personId??null,roles:[...(ctx.roles??[])],authorityKey:callerKey},
  gate:{privateReads:gate.privateReads,actions:gate.actions,reason},
  offered:[...offeredNames],calls,disclosure,checks,retries,screening:Object.freeze({...screening,kinds:Object.freeze([...screening.kinds])}),
  budgets:{steps,inputTokens,outputTokens,spendUsd:Number(spendUsd.toFixed(6)),wallMs:Date.now()-startedMs,exhausted,refusedCalls},
  restoration:{restored:restoration.restored,refused:restoration.refused},memory:memoryResult,
  outcome:{mode,slot,suggestion:suggestion?.action??null,openProposals:next.openProposals.length,fallback}});
 return Object.freeze({reply:shownReply,personTurn,modelTurn,mode,slot,suggestion,proposals:next.openProposals,reads:Object.freeze(reads),trace,memory:next,caseRoute});
}
