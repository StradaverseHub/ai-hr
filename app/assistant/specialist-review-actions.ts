'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getBrowserCommandSession} from '@/lib/session';
import {isAgentModuleCode} from '@/lib/ai/module-agents';
import {createCanonicalSpecialistCandidate,evaluateCanonicalSpecialistCandidate,promoteCanonicalSpecialistCandidate,rollbackRoutingAgent,runGovernedSpecialistJob} from '@/core/module-agent-releases';

const fail=():never=>redirect('/assistant?error=agent_review');
const finish=():never=>{revalidatePath('/assistant');redirect('/assistant');};
/** Posted choices nominate a closed module only. Every owner rechecks actual current authority. */
export async function createSpecialistCandidateAction(form:FormData){
 const choice=String(form.get('moduleVersion')??'').split(':'),module=choice[0],version=Number(choice[1]);
 const signalIds=form.getAll('signalId').map(value=>String(value));
 if(choice.length!==2||!isAgentModuleCode(module)||!Number.isSafeInteger(version)||version<1)return fail();
 try{const ctx=await getBrowserCommandSession();await createCanonicalSpecialistCandidate(ctx,{module,version,signalIds,playbook:String(form.get('playbook')??'canonical_domain_v1') as 'canonical_domain_v1'|'canonical_followup_v1'});}catch{fail();}finish();
}
export async function evaluateSpecialistCandidateAction(form:FormData){
 const candidateId=String(form.get('candidateId')??'');if(form.get('consented')!=='yes')fail();
 try{const ctx=await getBrowserCommandSession();await evaluateCanonicalSpecialistCandidate(ctx,candidateId);}catch{fail();}finish();
}
export async function promoteSpecialistCandidateAction(form:FormData){
 const candidateId=String(form.get('candidateId')??''),maxJobs=Number(form.get('maxJobs')),hours=Number(form.get('hours'));
 try{const ctx=await getBrowserCommandSession();await promoteCanonicalSpecialistCandidate(ctx,{candidateId,maxJobs,hours});}catch{fail();}finish();
}
export async function rollbackSpecialistCandidateAction(form:FormData){
 const promotionId=String(form.get('promotionId')??'');
 try{const ctx=await getBrowserCommandSession();await rollbackRoutingAgent(ctx,{promotionId,reason:'human'});}catch{fail();}finish();
}
export async function runSpecialistJobAction(form:FormData){
 const module=String(form.get('module')??''),nonce=String(form.get('commandNonce')??'');if(!isAgentModuleCode(module))return fail();
 let jobId:string;
 try{const ctx=await getBrowserCommandSession(),result=await runGovernedSpecialistJob(ctx,{module},{nonce});jobId=result.jobId;}catch{return fail();}
 revalidatePath('/assistant');redirect('/assistant?governed='+encodeURIComponent(jobId));
}
