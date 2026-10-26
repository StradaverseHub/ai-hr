'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getSession} from '@/lib/session';
import {saveLetterTemplate,decideLetterTemplate,setLetterTemplateActive,getLetterTemplate,previewLetterTemplate} from '@/core/letters';
import {WorkforceAccessError} from '@/core/workforce-access';
import {LETTER_LANGUAGES,LetterModelError,type LetterDocument} from '@/lib/letter-model';
import {LetterWorkflowError} from '@/lib/letter-workflow';
import {letterCustomValues} from '@/lib/letter-form-values';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const value=(form:FormData,key:string)=>typeof form.get(key)==='string'?form.get(key) as string:'';
export type TemplateActionState={error:string;field?:string}|null;
export type TemplatePreviewState={document:LetterDocument;error?:never;field?:never}|{error:string;field?:string;document?:never}|null;
function failure(error:unknown):TemplateActionState{
 if(error instanceof LetterModelError)return error.code==='unknownField'&&/^[a-z][a-zA-Z0-9_.]{0,79}$/.test(error.path)?{error:'invalidField',field:error.path}:{error:'invalid'};
 return {error:error instanceof LetterWorkflowError?error.code:'unavailable'};
}
export async function saveTemplate(_previous:TemplateActionState,form:FormData):Promise<TemplateActionState>{
 const companyId=value(form,'companyId'),templateId=value(form,'templateId'),revision=value(form,'expectedRevision'),language=value(form,'language'),raw=value(form,'editor'),signatoryUserId=value(form,'signatoryUserId'),letterheadAssetId=value(form,'letterheadAssetId'),intent=value(form,'intent'),fields=form.getAll('fieldVersionId');
 if(!uuid.test(companyId)||templateId&&(!uuid.test(templateId)||!/^\d{1,9}$/.test(revision))||!(LETTER_LANGUAGES as readonly string[]).includes(language)||!['draft','submit'].includes(intent)||!uuid.test(signatoryUserId)||letterheadAssetId&&!uuid.test(letterheadAssetId)||raw.length>1000000||fields.length>200||fields.some(field=>typeof field!=='string'||!uuid.test(field)))return {error:'invalid'};
 let editor:unknown;try{editor=JSON.parse(raw);}catch{return {error:'invalid'};}
 const ctx=await getSession();let saved;
 try{saved=await saveLetterTemplate(ctx,{companyId,...(templateId?{templateId,expectedRevision:Number(revision)}:{}),code:value(form,'code'),name:value(form,'name'),category:value(form,'category'),effectiveFrom:value(form,'effectiveFrom'),editor,language:language as typeof LETTER_LANGUAGES[number],fieldVersionIds:fields as string[],presentation:{letterheadAssetId:letterheadAssetId||null,signatoryUserId},submit:intent==='submit'});}catch(error){return failure(error);}
 revalidatePath('/letters/templates');redirect('/letters/templates/'+saved!.versionId+'?notice='+(intent==='submit'?'submitted':'saved'));
}
export async function updateTemplate(_previous:TemplateActionState,form:FormData):Promise<TemplateActionState>{
 const versionId=value(form,'versionId'),templateId=value(form,'templateId'),revision=value(form,'expectedRevision'),action=value(form,'action');
 if(!uuid.test(versionId)||!['submit','approve','reject','activate','deactivate'].includes(action)||(['activate','deactivate'].includes(action)&&(!uuid.test(templateId)||!/^\d{1,9}$/.test(revision))))return {error:'invalid'};
 const ctx=await getSession();try{
  if(action==='activate'||action==='deactivate')await setLetterTemplateActive(ctx,{templateId,expectedRevision:Number(revision),active:action==='activate'});
  else await decideLetterTemplate(ctx,{versionId,expectedStatus:action==='submit'?'draft':'submitted',action:action as 'submit'|'approve'|'reject',reason:value(form,'reason')});
 }catch(error){return failure(error);}
 revalidatePath('/letters/templates');redirect('/letters/templates/'+versionId+'?notice=updated');
}
export async function previewTemplate(_previous:TemplatePreviewState,form:FormData):Promise<TemplatePreviewState>{
 const templateVersionId=value(form,'versionId'),employmentId=value(form,'employmentId');if(!uuid.test(templateVersionId)||!uuid.test(employmentId))return {error:'invalid'};
 const ctx=await getSession();try{
  const template=await getLetterTemplate(ctx,templateVersionId);if(!template)return {error:'permission'};
  const customValues=letterCustomValues(form,template.fields.map(field=>field.definition));
  const preview=await previewLetterTemplate(ctx,{templateVersionId,employmentId,customValues});return {document:preview.document};
 }catch(error){
  if(error instanceof WorkforceAccessError)return {error:'permission'};
  if(error instanceof LetterModelError){if(error.code==='limit')return {error:'limit'};if(error.code==='confidential')return {error:'permission'};if(error.code==='missingField'&&/^[a-z][a-zA-Z0-9_.]{0,79}$/.test(error.path))return {error:'missingField',field:error.path};}
  return failure(error);
 }
}
