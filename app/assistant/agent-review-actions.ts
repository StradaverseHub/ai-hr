'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getBrowserCommandSession} from '@/lib/session';
import {createPromptAgentCandidate,evaluatePromptAgentCandidate,promotePromptAgentCandidate,rollbackRoutingAgent,runPromptPlannedSyntheticJob} from '@/core/module-agent-releases';
import {MODULE_AGENT_SOURCE_DIGEST} from '@/lib/ai/module-agent-source-manifest';
import {PROMPT_HOLDOUTS} from '@/lib/ai/module-agent-prompt-candidate';
const failed=()=>redirect('/assistant?error=agent_review');
const finish=()=>{revalidatePath('/assistant');redirect('/assistant');};
export async function createAgentCandidateAction(form:FormData){
 const ctx=await getBrowserCommandSession();
 try{await createPromptAgentCandidate(ctx,{version:Number(form.get('version')),configuration:{kind:'read_plan_prompt_v1',variant:String(form.get('variant')??'')}});}catch{failed();}finish();
}
export async function evaluateAgentCandidateAction(form:FormData){
 const ctx=await getBrowserCommandSession();if(form.get('consented')!=='yes')failed();
 try{await evaluatePromptAgentCandidate(ctx,{candidateId:String(form.get('candidateId')??''),consent:{synthetic:true,maxRequests:PROMPT_HOLDOUTS.length,sourceDigest:MODULE_AGENT_SOURCE_DIGEST}});}catch{failed();}finish();
}
export async function promoteAgentCandidateAction(form:FormData){
 const ctx=await getBrowserCommandSession();
 try{await promotePromptAgentCandidate(ctx,{candidateId:String(form.get('candidateId')??''),maxJobs:Number(form.get('maxJobs')),hours:Number(form.get('hours'))});}catch{failed();}finish();
}
export async function rollbackAgentCandidateAction(form:FormData){
 const ctx=await getBrowserCommandSession();try{await rollbackRoutingAgent(ctx,{promotionId:String(form.get('promotionId')??''),reason:'human'});}catch{failed();}finish();
}
export async function tryAgentCandidateAction(form:FormData){
 const ctx=await getBrowserCommandSession();if(form.get('consented')!=='yes')failed();
 try{await runPromptPlannedSyntheticJob(ctx,{fixtureId:String(form.get('fixtureId')??''),consent:{synthetic:true,maxRequests:1,sourceDigest:MODULE_AGENT_SOURCE_DIGEST}});}catch{failed();}finish();
}
