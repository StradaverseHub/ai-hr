'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getBrowserCommandSession} from '@/lib/session';
import {createPromptAgentCandidate,evaluatePromptAgentCandidate,promotePromptAgentCandidate,rollbackAssistantPromotion,runPromptPlannedSyntheticJob,createConversationAgentCandidate,evaluateConversationAgentCandidate,promoteConversationAgentCandidate,eraseOwnConversationStrategyMetadata} from '@/core/module-agent-releases';
import {resolveOwnNotificationServerIdentity} from '@/core/assistant-actions/own-notification-preferences-source';
import {MODULE_AGENT_SOURCE_DIGEST} from '@/lib/ai/module-agent-source-manifest';
import {PROMPT_HOLDOUT_REQUEST_LIMIT} from '@/lib/ai/module-agent-prompt-candidate';
// Candidate review lives on AI management › Assistant (group administrators), not on the employee page.
const REVIEW_PAGE='/control-tower/agents/assistant';
const failed=()=>redirect(REVIEW_PAGE+'?error=agent_review');
const finish=()=>{revalidatePath(REVIEW_PAGE);revalidatePath('/assistant');redirect(REVIEW_PAGE);};
export async function createAgentCandidateAction(form:FormData){
 const version=Number(form.get('version')),variant=String(form.get('variant')??''),signalIds=form.getAll('signalId').map(value=>String(value)),nativeSignalId=String(form.get('nativeSignalId')??''),nativeSignalIds=nativeSignalId?[nativeSignalId]:[];
 try{const ctx=await getBrowserCommandSession(),input={version,configuration:{kind:'read_plan_prompt_v1',variant},signalIds,...(nativeSignalIds.length?{nativeSignalIds}:{})};
  if(nativeSignalIds.length)await createPromptAgentCandidate(ctx,input,{notificationIdentity:await resolveOwnNotificationServerIdentity()});else await createPromptAgentCandidate(ctx,input);
 }catch{failed();}finish();
}
export async function evaluateAgentCandidateAction(form:FormData){
 const candidateId=String(form.get('candidateId')??'');if(form.get('consented')!=='yes')failed();
 try{const ctx=await getBrowserCommandSession();await evaluatePromptAgentCandidate(ctx,{candidateId,consent:{synthetic:true,maxRequests:PROMPT_HOLDOUT_REQUEST_LIMIT,sourceDigest:MODULE_AGENT_SOURCE_DIGEST}});}catch{failed();}finish();
}
export async function promoteAgentCandidateAction(form:FormData){
 const candidateId=String(form.get('candidateId')??''),maxJobs=Number(form.get('maxJobs')),hours=Number(form.get('hours'));
 try{const ctx=await getBrowserCommandSession();await promotePromptAgentCandidate(ctx,{candidateId,maxJobs,hours});}catch{failed();}finish();
}
export async function rollbackAgentCandidateAction(form:FormData){
 const promotionId=String(form.get('promotionId')??'');try{const ctx=await getBrowserCommandSession();await rollbackAssistantPromotion(ctx,{promotionId,reason:'human'});}catch{failed();}finish();
}
export async function tryAgentCandidateAction(form:FormData){
 const fixtureId=String(form.get('fixtureId')??'');if(form.get('consented')!=='yes')failed();
 try{const ctx=await getBrowserCommandSession();await runPromptPlannedSyntheticJob(ctx,{fixtureId,consent:{synthetic:true,maxRequests:1,sourceDigest:MODULE_AGENT_SOURCE_DIGEST}});}catch{failed();}finish();
}

/** Separate conversation commands; posted variants never become raw system prompts. */
export async function createConversationCandidateAction(form:FormData){
 const version=Number(form.get('version')),variant=String(form.get('variant')??''),signalIds=form.getAll('signalId').map(String),native=String(form.get('nativeSignalId')??'');
 try{const ctx=await getBrowserCommandSession(),input={version,configuration:{kind:'assistant_answer_prompt_v1',variant},signalIds,...(native?{nativeSignalIds:[native]}:{})};await createConversationAgentCandidate(ctx,input,native?{notificationIdentity:await resolveOwnNotificationServerIdentity()}:{});}catch{failed();}finish();
}
export async function evaluateConversationCandidateAction(form:FormData){
 const candidateId=String(form.get('candidateId')??''),consented=form.get('consented')==='yes';if(!consented)failed();try{await evaluateConversationAgentCandidate(await getBrowserCommandSession(),{candidateId,consent:{synthetic:true,maxRequests:12,sourceDigest:MODULE_AGENT_SOURCE_DIGEST}});}catch{failed();}finish();
}
export async function promoteConversationCandidateAction(form:FormData){
 const candidateId=String(form.get('candidateId')??''),maxJobs=Number(form.get('maxJobs')),hours=Number(form.get('hours'));try{await promoteConversationAgentCandidate(await getBrowserCommandSession(),{candidateId,maxJobs,hours});}catch{failed();}finish();
}
export async function eraseConversationMetadataAction(){try{await eraseOwnConversationStrategyMetadata(await getBrowserCommandSession());}catch{redirect('/assistant?ownClear=unavailable');}revalidatePath('/assistant');redirect('/assistant?ownClear=conversation');}
