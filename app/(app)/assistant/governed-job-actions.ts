'use server';
/** Human-only command. Next server-action POST protection and strict authenticated command session apply. */
import {redirect} from 'next/navigation';
import {getBrowserCommandSession} from '@/lib/session';
import {runGovernedModuleReadPlan} from '@/core/module-agent-releases';
export async function runGovernedPlanAction(form:FormData){
 const nonce=String(form.get('commandNonce')??''),proposalId=String(form.get('proposalId')??''),modules=form.getAll('module').map(value=>String(value)).filter(Boolean);
 let jobId:string;
 try{const ctx=await getBrowserCommandSession();const result=await runGovernedModuleReadPlan(ctx,{version:1,modules},{nonce,...(proposalId?{proposalId}:{})});jobId=result.jobId;}catch{redirect('/assistant?error=governed_job');}
 redirect('/assistant?governed='+encodeURIComponent(jobId));
}
