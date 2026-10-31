'use server';
/** Explicit human commands only; no prefetch/provider dispatch and no client-authored factual data. */
import {redirect} from 'next/navigation';
import {getLocale} from 'next-intl/server';
import {getBrowserCommandSession} from '../../../lib/session';
import {MODULE_AGENT_SOURCE_DIGEST} from '../../../lib/ai/module-agent-source-manifest';
import {proposeOwnModuleReadPlan,eraseOwnModulePlanProposals,evaluateHumanQuestionPlannerCandidate} from '../../../core/module-agent-releases';
export async function proposeModulePlanAction(form:FormData){
 const permit=String(form.get('requestPermit')??''),question=String(form.get('question')??''),consented=form.get('consented')==='yes';
 let proposalId:string|null=null;
 try{if(!consented)throw Error();const ctx=await getBrowserCommandSession(),locale=await getLocale();const result=await proposeOwnModuleReadPlan(ctx,{permit,question,locale,consent:{questionOnly:true,oneRequest:true,sourceDigest:MODULE_AGENT_SOURCE_DIGEST}});if('proposalId' in result)proposalId=result.proposalId;}catch{redirect('/assistant?planning=unavailable');}
 redirect(proposalId?'/assistant?proposal='+encodeURIComponent(proposalId):'/assistant?planning=chooser');
}
export async function eraseModuleProposalsAction(){try{const ctx=await getBrowserCommandSession();await eraseOwnModulePlanProposals(ctx);}catch{redirect('/assistant?ownClear=unavailable');}redirect('/assistant?ownClear=proposals');}
export async function evaluateHumanPlannerAction(form:FormData){
 const candidateId=String(form.get('candidateId')??''),consented=form.get('consented')==='yes';
 try{if(!consented)throw Error();const ctx=await getBrowserCommandSession();await evaluateHumanQuestionPlannerCandidate(ctx,{candidateId,consent:{synthetic:true,maxRequests:12,sourceDigest:MODULE_AGENT_SOURCE_DIGEST}});}catch{redirect('/control-tower/agents/assistant?planning=unavailable');}redirect('/control-tower/agents/assistant?planning=evaluated');
}
