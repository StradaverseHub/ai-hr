'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getBrowserCommandSession} from '@/lib/session';
import {resolveOwnNotificationServerIdentity} from '@/core/assistant-actions/own-notification-preferences-source';
import {isAgentModuleCode} from '@/lib/ai/module-agents';
import {createCanonicalSpecialistCandidate,evaluateCanonicalSpecialistCandidate,promoteCanonicalSpecialistCandidate,rollbackAssistantPromotion,runGovernedSpecialistJob} from '@/core/module-agent-releases';
import {isAgentPromotionScope} from '@/lib/ai/agent-promotion-scope';

// Specialist candidate review lives on AI management › Assistant; running a specialist job stays on the
// employee Assistant page.
const REVIEW_PAGE='/control-tower/agents/assistant';
const fail=():never=>redirect(REVIEW_PAGE+'?error=agent_review');
const finish=():never=>{revalidatePath(REVIEW_PAGE);revalidatePath('/assistant');redirect(REVIEW_PAGE);};
const jobFail=():never=>redirect('/assistant?error=agent_review');
/** Posted choices nominate a closed module only. Every owner rechecks actual current authority. */
export async function createSpecialistCandidateAction(form:FormData){
 const choice=String(form.get('moduleVersion')??'').split(':'),module=choice[0],version=Number(choice[1]);
 const signalIds=form.getAll('signalId').map(value=>String(value)),nativeSignalId=String(form.get('nativeSignalId')??''),nativeSignalIds=nativeSignalId?[nativeSignalId]:[],playbook=String(form.get('playbook')??'canonical_domain_v1');
 if(choice.length!==2||!isAgentModuleCode(module)||!Number.isSafeInteger(version)||version<1)return fail();
 try{const ctx=await getBrowserCommandSession(),input={module,version,signalIds,...(nativeSignalIds.length?{nativeSignalIds}:{}),playbook:playbook as 'canonical_domain_v1'|'canonical_followup_v1'};
  if(module==='notifications'&&nativeSignalIds.length)await createCanonicalSpecialistCandidate(ctx,input,{notificationIdentity:await resolveOwnNotificationServerIdentity()});else await createCanonicalSpecialistCandidate(ctx,input);
 }catch{fail();}finish();
}
export async function evaluateSpecialistCandidateAction(form:FormData){
 const candidateId=String(form.get('candidateId')??'');if(form.get('consented')!=='yes')fail();
 try{const ctx=await getBrowserCommandSession();await evaluateCanonicalSpecialistCandidate(ctx,candidateId);}catch{fail();}finish();
}
/** WP11: the approver's scope choice is posted as `scope` (user | company | tenant) and, for company,
 * `companyId`. Absent means 'user', the pre-WP11 behaviour. The owner rechecks everything. */
export async function promoteSpecialistCandidateAction(form:FormData){
 const candidateId=String(form.get('candidateId')??''),maxJobs=Number(form.get('maxJobs')),hours=Number(form.get('hours')),posted=String(form.get('scope')??'user'),companyId=String(form.get('companyId')??'');
 if(!isAgentPromotionScope(posted))return fail();const scope=posted;
 try{const ctx=await getBrowserCommandSession();await promoteCanonicalSpecialistCandidate(ctx,{candidateId,maxJobs,hours,...(scope==='user'?{}:{scope}),...(scope==='company'?{companyId}:{})});}catch{fail();}finish();
}
export async function rollbackSpecialistCandidateAction(form:FormData){
 const promotionId=String(form.get('promotionId')??'');
 try{const ctx=await getBrowserCommandSession();await rollbackAssistantPromotion(ctx,{promotionId,reason:'human'});}catch{fail();}finish();
}
export async function runSpecialistJobAction(form:FormData){
 const module=String(form.get('module')??''),nonce=String(form.get('commandNonce')??'');if(!isAgentModuleCode(module))return jobFail();
 let jobId:string;
 try{const ctx=await getBrowserCommandSession(),result=await runGovernedSpecialistJob(ctx,{module},{nonce});jobId=result.jobId;}catch{return jobFail();}
 revalidatePath('/assistant');redirect('/assistant?governed='+encodeURIComponent(jobId));
}
