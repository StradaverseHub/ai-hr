'use server';
import { getSession } from '@/lib/session';
import { publicErrorMessage } from '@/lib/public-error';
import { rewriteAssessmentField } from '@/packs/performance/service';
import type { AssessmentRewriteTarget } from '@/packs/performance/onehr/rewrite-model';

export async function rewriteAssessmentFieldAction(reviewId:string,target:AssessmentRewriteTarget,draft:string,instruction:string,requestId:string){
 const session=await getSession();
 try{return await rewriteAssessmentField(session,reviewId,target,draft,instruction,requestId);}
 catch(error){return {error:publicErrorMessage(error)};}
}
