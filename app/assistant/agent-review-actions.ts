'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getBrowserCommandSession} from '@/lib/session';
import {createPromptAgentCandidate,evaluatePromptAgentCandidate,promotePromptAgentCandidate,rollbackRoutingAgent,runPromptPlannedSyntheticJob} from '@/core/module-agent-releases';
import {MODULE_AGENT_SOURCE_DIGEST} from '@/lib/ai/module-agent-source-manifest';
import {PROMPT_HOLDOUT_REQUEST_LIMIT} from '@/lib/ai/module-agent-prompt-candidate';
const failed=()=>redirect('/assistant?error=agent_review');
const finish=()=>{revalidatePath('/assistant');redirect('/assistant');};
export async function createAgentCandidateAction(form:FormData){
 const version=Number(form.get('version')),variant=String(form.get('variant')??'');
 try{const ctx=await getBrowserCommandSession();await createPromptAgentCandidate(ctx,{version,configuration:{kind:'read_plan_prompt_v1',variant}});}catch{failed();}finish();
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
 const promotionId=String(form.get('promotionId')??'');try{const ctx=await getBrowserCommandSession();await rollbackRoutingAgent(ctx,{promotionId,reason:'human'});}catch{failed();}finish();
}
export async function tryAgentCandidateAction(form:FormData){
 const fixtureId=String(form.get('fixtureId')??'');if(form.get('consented')!=='yes')failed();
 try{const ctx=await getBrowserCommandSession();await runPromptPlannedSyntheticJob(ctx,{fixtureId,consent:{synthetic:true,maxRequests:1,sourceDigest:MODULE_AGENT_SOURCE_DIGEST}});}catch{failed();}finish();
}
