/** Deterministic user jobs: one fresh closed Assistant carrier, no provider/model or shared cache. */
import {randomUUID} from 'node:crypto';
import type {SpecialistAssessment} from '../lib/ai/module-specialists';
import type {SessionContext,Tx} from '../db/client';
import {reopenGovernedModuleReadJobTx} from './module-agent-releases';
import {withAssistantRead} from './assistant-read-session';
import {isAgentModuleCode,MODULE_AGENT_CAPABILITIES,type AgentModuleCode} from '../lib/ai/module-agents';
import {toolsFor} from './assistant-tools';
import type {AssistantReadSession} from './assistant-read-session';
import {assistantPublicToolResult} from '../lib/ai/assistant-public-replies';
import {presentGroundedToolOutcome,isGroundedToolName,type GroundedToolName} from '../lib/ai/grounded-tool-presentation';
import {presentCanonicalModuleData} from '../lib/ai/module-job-presentation';
import {assistantSourceDigest} from '../lib/ai/assistant-disclosure';
import type {JobPresentation} from '../lib/ai/module-jobs';
const owners=new WeakMap<object,{principal:string;issuedAt:number;digest:string}>();
const principal=(ctx:SessionContext)=>JSON.stringify([ctx.tenantId,ctx.userId,ctx.personId??null,ctx.roles??null,ctx.grants??null]);
export type CanonicalModuleJobView=Readonly<{state:'ready';presentation:JobPresentation;checkedAt:number;viewId:string;toolName?:GroundedToolName;specialist?:SpecialistAssessment|null}|{state:'unavailable';module:AgentModuleCode|null;checkedAt:number;viewId:string}>;
export async function loadCanonicalModuleJob(ctx:SessionContext,input:unknown):Promise<CanonicalModuleJobView>{
 const captured={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 const request=input&&typeof input==='object'&&!Array.isArray(input)?input as Record<string,unknown>:null;
 const module=request&&Object.keys(request).length===1&&isAgentModuleCode(request.module)?request.module:null;
 let view:CanonicalModuleJobView;
 try{if(!module)throw Error();
  const presentation=await withAssistantRead(captured,module,async read=>{
   const result=await read.moduleWork(module),expected=MODULE_AGENT_CAPABILITIES.find(row=>row[0]===module)![1];
   if(result.module!==module||result.capability!==expected||result.scope!=='current-caller')throw Error();
   return presentCanonicalModuleData(module,result.data);
  });
  view=Object.freeze({state:'ready',presentation,checkedAt:Date.now(),viewId:randomUUID()});
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
  const presentation=await withAssistantRead(current,tool.module,async read=>{
   const result=assistantPublicToolResult(await tool.run(current,input,read));
   if(assistantSourceDigest(result)!==expectedDigest)throw Error();return presentGroundedToolOutcome(name,result);
  },session);
  if(!presentation)throw Error();view=Object.freeze({state:'ready',presentation,checkedAt:Date.now(),viewId:randomUUID(),toolName:name});
 }catch{view=Object.freeze({state:'unavailable',module:null,checkedAt:Date.now(),viewId:randomUUID()});}
 owners.set(view,{principal:principal(current),issuedAt:Date.now(),digest:assistantSourceDigest(view)});return view;
}

export type GovernedWorkspaceJobView=Readonly<{state:'ready';jobId:string;mode:'baseline'|'promoted';changedSinceRun:boolean;feedbackOutcome:'helpful'|'needs_correction'|'incorrect'|null;views:readonly CanonicalModuleJobView[]}|{state:'unavailable'}>;
/** Receipt reopening loads only fresh canonical facts in the supplied read-only source carrier. */
export async function loadGovernedWorkspaceJobTx(ctx:SessionContext,tx:Tx,id:string):Promise<GovernedWorkspaceJobView>{
 const current={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 try{const result=await reopenGovernedModuleReadJobTx(tx,current,id),views:CanonicalModuleJobView[]=[];
  for(const row of result.results){if(!isAgentModuleCode(row.module)||row.scope!=='current-caller'||row.capability!==MODULE_AGENT_CAPABILITIES.find(binding=>binding[0]===row.module)![1])throw Error();
   const view=Object.freeze({state:'ready' as const,presentation:presentCanonicalModuleData(row.module,row.data),checkedAt:Date.now(),viewId:randomUUID(),...(result.specialist===undefined?{}:{specialist:result.specialist?.module===row.module?result.specialist:null})});
   owners.set(view,{principal:principal(current),issuedAt:Date.now(),digest:assistantSourceDigest(view)});views.push(view);
  }
  return Object.freeze({state:'ready',jobId:result.jobId,mode:result.mode,changedSinceRun:result.changedSinceRun,feedbackOutcome:result.feedbackOutcome,views:Object.freeze(views)});
 }catch{return Object.freeze({state:'unavailable'});}
}
