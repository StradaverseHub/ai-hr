'use server';
import { getSession } from '@/lib/session';
import { getTranslations } from 'next-intl/server';
import { performanceAiErrorMessage } from '@/packs/performance/onehr/ai-refusal';
import { rewriteAssessmentField } from '@/packs/performance/service';
import type { AssessmentRewriteTarget } from '@/packs/performance/onehr/rewrite-model';

export async function rewriteAssessmentFieldAction(reviewId:string,target:AssessmentRewriteTarget,draft:string,instruction:string,requestId:string){
 const session=await getSession();
 try{return await rewriteAssessmentField(session,reviewId,target,draft,instruction,requestId);}
 catch(error){return {error:await performanceAiErrorMessage(error,async key=>(await getTranslations('assistant'))(key))};}
}
