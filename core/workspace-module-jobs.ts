/** Deterministic user jobs: one fresh closed Assistant carrier, no provider/model or shared cache. */
import {randomUUID} from 'node:crypto';
import {executeCanonicalSpecialist,compactSpecialistWork,type CompactSpecialistWork,type SpecialistAssessment} from '../lib/ai/module-specialists';
import type {SessionContext,Tx} from '../db/client';
import {reopenGovernedModuleReadJobTx,readGovernedSpecialistToolResultTx} from './module-agent-releases';
import {withAssistantRead} from './assistant-read-session';
import {isAgentModuleCode,MODULE_AGENT_CAPABILITIES,type AgentModuleCode} from '../lib/ai/module-agents';
import {toolsFor} from './assistant-tools';
import type {AssistantReadSession} from './assistant-read-session';
import {assistantPublicToolResult} from '../lib/ai/assistant-public-replies';
import {presentGroundedToolOutcome,isGroundedToolName,type GroundedToolName} from '../lib/ai/grounded-tool-presentation';
import {presentCanonicalModuleData} from '../lib/ai/module-job-presentation';
import {assistantSourceDigest} from '../lib/ai/assistant-disclosure';
import {assistantToolAnswerExplanations} from '../lib/ai/assistant-tool-answer-evidence';
import {specialistAnswerExplanations,type AssistantAnswerExplanation} from '../lib/ai/assistant-answer-explanations';
import type {JobPresentation} from '../lib/ai/module-jobs';
const owners=new WeakMap<object,{principal:string;issuedAt:number;digest:string}>();
const principal=(ctx:SessionContext)=>JSON.stringify([ctx.tenantId,ctx.userId,ctx.personId??null,ctx.roles??null,ctx.grants??null]);
export type CanonicalModuleJobView=Readonly<{state:'ready';presentation:JobPresentation;checkedAt:number;viewId:string;toolName?:GroundedToolName;answerExplanations?:readonly AssistantAnswerExplanation[];specialist?:SpecialistAssessment|null;specialistVersion?:CompactSpecialistWork}|{state:'unavailable';module:AgentModuleCode|null;checkedAt:number;viewId:string}>;
export async function loadCanonicalModuleJob(ctx:SessionContext,input:unknown):Promise<CanonicalModuleJobView>{
 const captured={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 const request=input&&typeof input==='object'&&!Array.isArray(input)?input as Record<string,unknown>:null;
 const module=request&&Object.keys(request).length===1&&isAgentModuleCode(request.module)?request.module:null;
 let view:CanonicalModuleJobView;
 try{if(!module)throw Error();
  const presentation=await withAssistantRead(captured,module,async read=>{
   const result=await read.moduleWork(module),expected=MODULE_AGENT_CAPABILITIES.find(row=>row[0]===module)![1];
   if(result.module!==module||result.capability!==expected||result.scope!=='current-caller')throw Error();
   return{presentation:presentCanonicalModuleData(module,result.data),specialist:executeCanonicalSpecialist({kind:'canonical_specialist_v1',module,playbook:'canonical_domain_v1'},result)};
  });
  view=Object.freeze({state:'ready',presentation:presentation.presentation,answerExplanations:specialistAnswerExplanations(presentation.specialist,presentation.presentation),specialist:presentation.specialist,specialistVersion:compactSpecialistWork(presentation.specialist,{mode:'baseline',version:0,configuration:{kind:'canonical_specialist_v1',module,playbook:'canonical_domain_v1'}}),checkedAt:Date.now(),viewId:randomUUID()});
 }catch{view=Object.freeze({state:'unavailable',module,checkedAt:Date.now(),viewId:randomUUID()});}
 owners.set(view,{principal:principal(captured),issuedAt:Date.now(),digest:assistantSourceDigest(view)});return view;
}
/** A posted/copied/escaped/cross-principal view is never a source of facts for the renderer. */
export function assertCanonicalModuleJobView(view:CanonicalModuleJobView,ctx:SessionContext):void{
 const owner=owners.get(view),age=owner?Date.now()-owner.issuedAt:NaN;
 if(!owner||owner.digest!==assistantSourceDigest(view)||owner.principal!==principal(ctx)||!Number.isFinite(age)||age<0||age>30000)throw Error('Current module facts unavailable.');
}

/** Historical plan inputs nominate only. The actual current tool/source/field guards still own facts. */
export async function loadCanonicalToolJob(ctx:SessionContext,name:string,input:unknown,expectedDigest:string,session:AssistantReadSession):Promise<CanonicalModuleJobView>{
 const current={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};let view:CanonicalModuleJobView;
 try{if(!isGroundedToolName(name)||!/^[a-f0-9]{64}$/.test(expectedDigest))throw Error();
  // Unrenderable legacy comparisons are withheld rather than treating their numbers as typed facts.
  if(name==='my_pay_change'||name==='team_leave_summary')throw Error();
  const tool=toolsFor(current).find(row=>row.spec.name===name);if(!tool)throw Error();
  const answer=await withAssistantRead(current,tool.module,async read=>{
   const result=assistantPublicToolResult(await tool.run(current,input,read));
   if(assistantSourceDigest(result)!==expectedDigest)throw Error();
   const presentation=presentGroundedToolOutcome(name,result);if(!presentation)throw Error();
   return {presentation,explanations:assistantToolAnswerExplanations(name,result,presentation)};
  },session);
  view=Object.freeze({state:'ready',presentation:answer.presentation,answerExplanations:answer.explanations,checkedAt:Date.now(),viewId:randomUUID(),toolName:name});
 }catch{view=Object.freeze({state:'unavailable',module:null,checkedAt:Date.now(),viewId:randomUUID()});}
 owners.set(view,{principal:principal(current),issuedAt:Date.now(),digest:assistantSourceDigest(view)});return view;
}

export type GovernedWorkspaceJobView=Readonly<{state:'ready';jobId:string;mode:'baseline'|'promoted';changedSinceRun:boolean;feedbackOutcome:'helpful'|'needs_correction'|'incorrect'|null;views:readonly CanonicalModuleJobView[]}|{state:'unavailable'}>;
/** Receipt reopening loads only fresh canonical facts in the supplied read-only source carrier. */
export async function loadGovernedWorkspaceJobTx(ctx:SessionContext,tx:Tx,id:string):Promise<GovernedWorkspaceJobView>{
 const current={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 try{const result=await reopenGovernedModuleReadJobTx(tx,current,id),views:CanonicalModuleJobView[]=[];
  for(const row of result.results){if(!isAgentModuleCode(row.module)||row.scope!=='current-caller'||row.capability!==MODULE_AGENT_CAPABILITIES.find(binding=>binding[0]===row.module)![1])throw Error();
   const presentation=presentCanonicalModuleData(row.module,row.data),assessment=result.specialists.find(item=>item.module===row.module)?.assessment??null;
   const view=Object.freeze({state:'ready' as const,presentation,answerExplanations:assessment?specialistAnswerExplanations(assessment,presentation):Object.freeze([]),checkedAt:Date.now(),viewId:randomUUID(),specialist:assessment,specialistVersion:result.specialists.find(item=>item.module===row.module)?.work});
   owners.set(view,{principal:principal(current),issuedAt:Date.now(),digest:assistantSourceDigest(view)});views.push(view);
  }
  return Object.freeze({state:'ready',jobId:result.jobId,mode:result.mode,changedSinceRun:result.changedSinceRun,feedbackOutcome:result.feedbackOutcome,views:Object.freeze(views)});
 }catch{return Object.freeze({state:'unavailable'});}
}

/** A sealed historical chat lookup reuses its already admitted specialist version. No GET, provider
 * admission or history reopen creates jobs, consumes a permit or accepts model-supplied versions. */
export async function loadGovernedSpecialistToolJob(ctx:SessionContext,tx:Tx,input:unknown,jobId:string,expectedDigest:string):Promise<CanonicalModuleJobView>{
 const current={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};let view:CanonicalModuleJobView;
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!isAgentModuleCode((input as {module?:unknown}).module)||!/^[a-f0-9]{64}$/.test(expectedDigest))view=Object.freeze({state:'unavailable',module:null,checkedAt:Date.now(),viewId:randomUUID()});
 else{
  const module=(input as {module:AgentModuleCode}).module;
  // Storage/current-authority failures propagate to the actual workspace owner and its rollback;
  // they never become a per-card success/continuation in an aborted source transaction.
  const read=await readGovernedSpecialistToolResultTx(tx,current,jobId,module);
  try{if(assistantSourceDigest(read.outcome)!==expectedDigest)throw Error();const presentation=presentGroundedToolOutcome('my_module_work',read.outcome);if(!presentation)throw Error();view=Object.freeze({state:'ready',presentation,checkedAt:Date.now(),viewId:randomUUID(),toolName:'my_module_work',answerExplanations:specialistAnswerExplanations(read.assessment,presentation),specialist:read.assessment,specialistVersion:read.outcome.specialistWork});}
  catch{view=Object.freeze({state:'unavailable',module:null,checkedAt:Date.now(),viewId:randomUUID()});}
 }
 owners.set(view,{principal:principal(current),issuedAt:Date.now(),digest:assistantSourceDigest(view)});return view;
}
