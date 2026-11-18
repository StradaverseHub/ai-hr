'use server';
import {deleteProbationLetterTemplate} from '@/core/probation-letter';
import {revalidatePath} from 'next/cache';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {previewProbationLetter,probationCase} from '@/packs/probation/service';
import {saveProbationLetterTemplateWithRouting,type ProbationRoutedTemplate} from '@/core/probation-letter-routing';

async function execute<T>(work:()=>Promise<T>){
 try{const result=await work();return{ok:true as const,result};}
 catch(error){return{ok:false as const,code:error instanceof Error&&error.name==='ProbationError'?'review':'unavailable',detail:error instanceof Error&&error.name==='ProbationError'?error.message:undefined};}
}

/** Saves a letter template version with its signing and review routing (empty routing: exactly as today). */
export async function saveRoutedLetterTemplate(input:{companyId:string;template:ProbationRoutedTemplate;publish:boolean;expectedVersion:number}){
 const result=await execute(async()=>saveProbationLetterTemplateWithRouting(await requireScopedLifecycleModule(),input));
 if(result.ok){revalidatePath('/lifecycle/probation','layout');revalidatePath('/lifecycle/v9/templates');}
 return result;
}

export type TemplatePreviewValues={merge:Record<string,string>|null;reason:'ready'|'noOutcome'|'unavailable'};
/**
 * Merge values of a chosen case for the template preview. The existing letter preview service decides access and
 * which outcome and published version it can preview; anything it refuses shows placeholders with a reason.
 */
export async function previewTemplateForCase(input:{caseId:string;templateVersionId:string}){
 return execute<TemplatePreviewValues>(async()=>{
  const ctx=await requireScopedLifecycleModule(),view=await probationCase(ctx,input.caseId);
  const outcome=[...view.outcomes].sort((a,b)=>b.revision-a.revision)[0];
  if(!outcome)return{merge:null,reason:'noOutcome'};
  try{const preview=await previewProbationLetter(ctx,{outcomeId:outcome.id,templateId:input.templateVersionId,edits:{},revision:outcome.revision});return{merge:preview.merge,reason:'ready'};}
  // The preview service refuses drafts and versions that do not match this case's outcome: show placeholders.
  catch{return{merge:null,reason:'unavailable'};}
 });
}

export async function deleteLetterTemplate(input:{companyId:string;key:string;expectedVersion:number;reason:string}){
 const result=await execute(async()=>deleteProbationLetterTemplate(await requireScopedLifecycleModule(),input));
 if(result.ok){revalidatePath('/lifecycle/probation','layout');revalidatePath('/lifecycle/v9/templates');}return result;
}
