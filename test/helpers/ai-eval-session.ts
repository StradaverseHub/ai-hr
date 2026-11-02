/** One fictional-data model evaluation lifetime. Never a release receipt or price certification.
 * The additive guard calls the ORIGINAL native proof owner before reserving any lifetime amount.
 * Only a planned case may reach the actual fixed OpenRouter POST. Unknown/failed exposure is held.
 */
import {AsyncLocalStorage} from 'node:async_hooks';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {governedAiConfig,withAiAdmissionLifecycle} from '../../core/ai-governance';
import type {withReviewedAiSpendDispatch} from '../../core/ai-spend-capability';
import {usdToNanos} from '../../lib/ai/spend-allocation';
import {providerDataReviewStatus} from '../../lib/ai/provider-data-reviews';
import {TERAS_HARNESS_CONTRACT} from '../../lib/ai/teras-harness-policy';
import {captureRequestedEval,createEvalLedger,EVAL_CARRIERS,loadEvalPlan} from '../../.github/ci/eval/contract.mjs';
import {createNativeEvalBudget} from './ai-eval-native-budget';
import {createNativeEvalWitness} from './ai-eval-native-witness';

type NativeDispatch=typeof withReviewedAiSpendDispatch;
type Status='met'|'missed'|'review_required';
export type EvalGrade=Readonly<{findings:readonly string[];criteria:Readonly<Record<string,Status>>}>;
type PlannedCase={id:string;set:string;conversationId:string;turnId:string;repeat:number;requiresModel:boolean;dependsOn:string|null;quality:{kind:'deterministic'|'human_review';criteria:string[]}};
type CaseScope={id:string;attemptId?:string};
const scopes=new AsyncLocalStorage<CaseScope>();
let nativeOwner:NativeDispatch|null=null;
let lifecycleOwner:typeof withAiAdmissionLifecycle|null=null;
let activeRuntime:{dispatch:NativeDispatch;configuration:(cfg:Parameters<typeof withAiAdmissionLifecycle>[0],feature:Parameters<typeof withAiAdmissionLifecycle>[1],tenantId:string)=>ReturnType<typeof withAiAdmissionLifecycle>}|null=null;
/** Add correlation through the original lifecycle owner; existing checks/hooks remain composed. */
export function bindNativeEvalGovernance(actual:typeof governedAiConfig,lifecycle:typeof withAiAdmissionLifecycle):typeof governedAiConfig{
 lifecycleOwner=lifecycle;
 return (ctx,snapshot,feature)=>{
  const cfg=actual(ctx,snapshot,feature);
  return activeRuntime?activeRuntime.configuration(cfg,feature,ctx.tenantId):cfg;
 };
}
/** Vitest instrumentation supplies the actual unmodified owner; no resolver/permission bypass. */
export function bindNativeEvalDispatch(actual:NativeDispatch):NativeDispatch{
 nativeOwner=actual;
 return (envelope,configuration,request,consume)=>{
  if(!activeRuntime)throw Error('A requested evaluation lifetime is required.');
  return activeRuntime.dispatch(envelope,configuration,request,consume);
 };
}

export function createModelEvalSession(carrier:string){
 const requested=Boolean(process.env.AIHR_EVAL_MODEL?.trim())||process.env.AIHR_EVAL_REQUESTED==='true';
 if(!requested)return null;
 if(providerDataReviewStatus(TERAS_HARNESS_CONTRACT)!=='approved')throw Error('The exact production disclosure source is not approved.');
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.CI!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'
  ||process.env.GITHUB_RUN_ATTEMPT!=='1')throw Error('Requested model evaluation requires a first-attempt hosted run.');
 const identity={sourceSha:process.env.AIHR_CI_HEAD,controllerSha:process.env.AIHR_CI_CONTROL_HEAD,
  runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,
  runtime:{node:process.versions.node,platform:process.platform,arch:process.arch}};
 const request=captureRequestedEval(process.env,[carrier],identity);
 if(!request)throw Error('Requested evaluation configuration unavailable.');
 const plan=loadEvalPlan(request,process.cwd()),cases=plan.cases as PlannedCase[],byId=new Map(cases.map(row=>[row.id,row]));
 if(process.env.AIHR_EVAL_PLAN_HASH&&process.env.AIHR_EVAL_PLAN_HASH!==plan.planHash
  ||process.env.AIHR_EVAL_CORPUS_REVIEW_DIGEST&&process.env.AIHR_EVAL_CORPUS_REVIEW_DIGEST!==plan.corpusReviewDigest)
  throw Error('Controller and carrier evaluation plan differ.');
 const ledger=createEvalLedger(plan),observed=new Map<string,number>(),terminal=new Map<string,string>();
 const evaluationId=`${identity.runId}:${identity.attempt}:${plan.planHash}`;
 const attempts:{caseId:string;evaluationId:string;runId:string;capabilityDigest:string;requestId:string;requestDigest:string;configurationDigest:string;ceilingNanos:string}[]=[];
 let tenantId:string|null=null,witness:ReturnType<typeof createNativeEvalWitness>|null=null;
 const getWitness=()=>{
  if(!nativeOwner||!lifecycleOwner)throw Error('Original native evaluation owners unavailable.');
  return witness??=createNativeEvalWitness({evaluationId,withLifecycle:lifecycleOwner,nativeDispatch:nativeOwner});
 };
 const sent:{caseId:string;body:string}[]=[],consumedPosts=new Set<string>();
 let guard:ReturnType<typeof createNativeEvalBudget>|null=null,receipt:Record<string,unknown>|null=null,persisted=false;
 const getGuard=()=>{
  if(!nativeOwner)throw Error('Original native spend proof owner unavailable.');
  return guard??=createNativeEvalBudget({allocationNanos:usdToNanos(String(request.budgetUsd)),maxAttempts:1500,nativeDispatch:getWitness().dispatch});
 };
 const dispatch:NativeDispatch=(envelope,configuration,input,consume)=>{
  const scope=scopes.getStore();if(!scope||!byId.has(scope.id))throw Error('Model dispatch outside a planned case.');
  const allocation=getGuard();
  return allocation.dispatch(envelope,configuration,input,async()=>{
   const bound=allocation.attemptEvidence().at(-1);if(!bound)throw Error('Native evaluation attempt unavailable.');
   const native=getWitness().attemptFor(input);
   if(!native||native.caseId!==scope.id)throw Error('Exact native evaluation run unavailable.');
   attempts.push({...bound,...native,ceilingNanos:String(bound.ceilingNanos)});
   return scopes.run({id:scope.id,attemptId:bound.requestId},consume);
  });
 };
 if(activeRuntime)throw Error('Only one model evaluation may own this process.');
 const runtime={dispatch,configuration(cfg:Parameters<typeof withAiAdmissionLifecycle>[0],feature:Parameters<typeof withAiAdmissionLifecycle>[1],currentTenant:string){
  if(tenantId!==null&&tenantId!==currentTenant)throw Error('Evaluation fixture tenant changed.');
  tenantId=currentTenant;return getWitness().configuration(cfg,feature);
 }};activeRuntime=runtime;
 const realFetch=globalThis.fetch;
 const observer:typeof fetch=async(input,init)=>{
  if(activeRuntime!==runtime)throw Error('Evaluation lifetime is closed.');
  const raw=typeof input==='string'?input:input instanceof URL?input.href:input.url;
  const url=new URL(raw),method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase();
  if(url.origin!=='https://openrouter.ai'||url.username||url.password||url.hash)throw Error('Unapproved evaluation network destination.');
  if(method==='POST'){
   const scope=scopes.getStore();
   if(url.pathname!=='/api/v1/chat/completions'||url.search||!scope?.attemptId
    ||consumedPosts.has(scope.attemptId)||!attempts.some(row=>row.requestId===scope.attemptId&&row.caseId===scope.id)||typeof init?.body!=='string')
    throw Error('Unreserved evaluation inference refused.');
   const body=JSON.parse(init.body) as {model?:string};
   if(body.model!==request.model)throw Error('Unapproved evaluation model.');
   consumedPosts.add(scope.attemptId);
   observed.set(scope.id,(observed.get(scope.id)??0)+1);sent.push({caseId:scope.id,body:init.body});
  }else if(method!=='GET'||url.pathname!=='/api/v1/generation'||[...url.searchParams.keys()].join(',')!=='id'||!url.searchParams.get('id')
   ||!scopes.getStore()?.attemptId||!consumedPosts.has(scopes.getStore()!.attemptId!)){
   throw Error('Unapproved evaluation metadata request.');
  }
  return realFetch(input,init);
 };
 globalThis.fetch=observer;
 function finish(){
  if(receipt&&persisted)return receipt;
  if(!receipt){
  const outcomes=ledger.finalize('not executed or prerequisite unavailable');
  const snapshot=guard?.snapshot()??{allocationNanos:usdToNanos(String(request.budgetUsd)),reservedNanos:BigInt('0'),remainingNanos:usdToNanos(String(request.budgetUsd)),attempts:0,maxAttempts:1500};
  receipt={schemaVersion:1,request,files:[carrier],planHash:plan.planHash,corpusReviewDigest:plan.corpusReviewDigest,
   plannedCaseIds:cases.map(row=>row.id),productionReviewed:true,path:'production',outcomes,
   nativeAdmissions:witness?.committedAttempts()??[],
   budget:{kind:'native_owned_no_refund_lifetime_reservations',identity:request.identity,evaluationId,tenantId,
    snapshot:Object.fromEntries(Object.entries(snapshot).map(([key,value])=>[key,typeof value==='bigint'?String(value):value])),attempts:attempts.map(row=>({...row,postCount:consumedPosts.has(row.requestId)?1:0}))}};
  }
  try{
  const directory=process.env.AIHR_FOCUSED_EVIDENCE_DIR??(process.env.RUNNER_TEMP?join(process.env.RUNNER_TEMP,'aihr-focused'):null);
  if(!directory)throw Error('Hosted evaluation evidence directory unavailable.');
  mkdirSync(directory,{recursive:true});
  const definition=EVAL_CARRIERS[carrier as keyof typeof EVAL_CARRIERS];
  writeFileSync(join(directory,definition.receiptFile),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  persisted=true;return receipt;
  }finally{
   if(globalThis.fetch===observer)globalThis.fetch=realFetch;
   if(activeRuntime===runtime)activeRuntime=null;
  }
 }
 return Object.freeze({request,plan,
  id(set:string,conversationId:string,turnId:string,repeat=0){
   const id=`${set}:${conversationId}:${turnId}:${repeat}`;if(!byId.has(id))throw Error('Case is outside frozen evaluation plan.');return id;
  },
  async run<T>(id:string,work:()=>Promise<T>,judge:(value:T)=>EvalGrade):Promise<T>{
   const row=byId.get(id);if(!row)throw Error('Foreign evaluation case.');
   if(row.dependsOn&&terminal.get(row.dependsOn)!=='completed'){
    ledger.finish({id,status:'dependency_unavailable',reason:'previous planned turn did not complete'});terminal.set(id,'dependency_unavailable');
    throw Error('evaluation_dependency_unavailable');
   }
   ledger.start(id);const started=performance.now();
   try{
    const value=await scopes.run({id},()=>getWitness().runCase(id,work)),grade=judge(value);
    ledger.finish({id,status:'completed',elapsedMs:performance.now()-started,providerCalls:observed.get(id)??0,
     security:{passed:grade.findings.length===0,findings:[...grade.findings]},
     criteria:row.quality.criteria.map(criterion=>({id:criterion,status:grade.criteria[criterion]??'review_required'}))});
    terminal.set(id,'completed');return value;
   }catch(error){
    const budget=error instanceof Error&&(error.name==='AiSpendControlError'||/allocation unavailable/.test(error.message));
    ledger.finish({id,status:budget?'budget_refused':'error',reason:budget?'native or lifetime allocation refused':'case execution failed',elapsedMs:performance.now()-started,providerCalls:observed.get(id)??0});
    terminal.set(id,budget?'budget_refused':'error');throw error;
   }
  },
  sentText:(id=scopes.getStore()?.id)=>Object.freeze(sent.filter(row=>!id||row.caseId===id).map(row=>row.body)),finish,
  assertExecution(){
   const result=finish(),outcomes=result.outcomes as {status:string;providerCalls?:number;security?:{passed:boolean}}[];
   if(outcomes.some((row,index)=>row.status!=='completed'||row.security?.passed!==true||cases[index].requiresModel&&(row.providerCalls??0)===0)||![...observed.values()].some(count=>count>0))
    throw Error('Evaluation is incomplete or unsafe; see every planned outcome in its receipt.');
  },
 });
}
