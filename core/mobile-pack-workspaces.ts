import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import {canonicalJson,withMobileCommandReceipt} from './mobile-command-receipt';
import {myEmployment} from './read';
import {listPendingTasks} from './approvals-inbox';
import {isModuleEnabled} from './entitlements';
import {prepareMobilePerformanceReview,getPerformanceAttachment,PerfError} from '../packs/performance/service';
import {prepareMobileRewardReview,RewardError} from '../packs/rewards/service';
import {validPackValues,projectPackPeople,type PreparedPackReview} from '../lib/mobile-api/pack-form';
import {PackWorkspace,PackWorkspaceDecisionResult,type PackWorkspaceKind,type PackWorkspaceCommand} from '../lib/mobile-api/v2/pack-workspaces';
import {todayInKualaLumpur} from '../lib/hr-date';
import {decisionRefusal,type TaskDocument} from './mobile-approvals';
import {hasMobileBinarySignature,isMobileBinaryType,MOBILE_ATTACHMENT_TYPES} from '../lib/mobile-api/binary-types';
const refused=(code:'not_assigned'|'stale_step'|'decision_refused')=>({outcome:'refused' as const,code});
class Refused extends Error{constructor(readonly code:'not_assigned'|'stale_step'|'decision_refused'){super(code);}}
async function prepare(ctx:SessionContext,kind:PackWorkspaceKind,id:string,tx?:Tx):Promise<(PreparedPackReview&{workspace:PackWorkspace})|null>{
 const modules={attendance:false,claims:false,performance:isModuleEnabled(ctx,'performance'),rewards:isModuleEnabled(ctx,'rewards')};
 const task=(await listPendingTasks(ctx,undefined,modules)).find(t=>t.kind===kind&&t.id===id);if(!task)return null;
 const p=kind==='rewardReview'?await prepareMobileRewardReview(ctx,id,tx):await prepareMobilePerformanceReview(ctx,kind,id,task.linkPath,tx);if(!p)return null;
 const base={...p.view,kind,id,today:todayInKualaLumpur()},digest=createHash('sha256').update(canonicalJson(base)).digest('hex');
 return {...p,workspace:{...base,expected:{digest}}};
}
export async function readPackWorkspace(ctx:SessionContext,kind:PackWorkspaceKind,id:string,navigation:{focus?:string;offset:number}={offset:0}){
 const p=await prepare(ctx,kind,id);if(!p)return refused('not_assigned');
 const w=projectPackPeople(p.workspace,p.people??[],navigation);if(!w)return refused('not_assigned');
 return {outcome:'found' as const,workspace:PackWorkspace.parse(w)};
}
export async function decidePackWorkspace(ctx:SessionContext,kind:PackWorkspaceKind,id:string,c:PackWorkspaceCommand){
 const me=await myEmployment(ctx);if(!me)return {outcome:'refused' as const,code:'employment_required' as const};
 try{return await withMobileCommandReceipt(ctx,{kind:'pack.decision',requestId:c.requestId,actorEmploymentId:me.employmentId,response:PackWorkspaceDecisionResult,intent:{kind,id,action:c.action,values:c.values,expected:c.expected}},async(tx:Tx)=>{
  const p=await prepare(ctx,kind,id,tx);if(!p)throw new Refused('not_assigned');if(p.workspace.expected.digest!==c.expected.digest)throw new Refused('stale_step');
  const a=p.workspace.actions.find(a=>a.id===c.action);if(!a||!validPackValues(a,c.values))throw new Refused('decision_refused');
  // Every owner receives this exact receipt transaction; canonical revisions and permission checks run again there.
  let status:string;try{status=await p.run(tx,c.action,c.values);}catch(e){if(e instanceof PerfError||e instanceof RewardError||e instanceof z.ZodError||e instanceof Error&&e.constructor===Error)throw new Refused('decision_refused');throw e;}
  return {outcome:'accepted' as const,status};
 });}catch(e){if(e instanceof Refused)return refused(e.code);return decisionRefusal(e);}
}
export async function packWorkspaceDocument(ctx:SessionContext,kind:PackWorkspaceKind,id:string,attachment:string):Promise<TaskDocument|{outcome:'refused';code:'not_assigned'|'no_document'|'unsupported_document'}>{
 const p=await prepare(ctx,kind,id);if(!p)return {outcome:'refused',code:'not_assigned'};
 if(kind==='rewardReview'||!p.workspace.documents.some(d=>d.id===attachment))return {outcome:'refused',code:'no_document'};
 const file=await getPerformanceAttachment(ctx,attachment);if(!file)return {outcome:'refused',code:'no_document'};
 const bytes=new Uint8Array(file.content),type=file.mimeType.toLowerCase();if(!isMobileBinaryType(type,MOBILE_ATTACHMENT_TYPES)||!hasMobileBinarySignature(type,bytes))return {outcome:'refused',code:'unsupported_document'};
 return {outcome:'file',bytes,contentType:type,fileName:file.fileName};
}
