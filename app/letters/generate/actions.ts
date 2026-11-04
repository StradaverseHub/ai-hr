'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getSession} from '@/lib/session';
import {createLetterDraftBatch,getLetterTemplate,getStaffLetter,refreshLetterDraft,withdrawLetterDraft,submitLetterBatch} from '@/core/letters';
import {WorkforceAccessError} from '@/core/workforce-access';
import {LetterModelError,type LetterField} from '@/lib/letter-model';
import {LetterWorkflowError} from '@/lib/letter-workflow';
import {letterCustomValues} from '@/lib/letter-form-values';
import {declineLetterRequest,LetterRequestError} from '@/core/letter-requests';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const value=(form:FormData,key:string)=>typeof form.get(key)==='string'?form.get(key) as string:'';
export type GenerationActionState={error:string;field?:string}|null;
function failure(error:unknown,fields:LetterField[]=[]):GenerationActionState{
 if(error instanceof WorkforceAccessError)return {error:'permission'};
 if(error instanceof LetterModelError){const code=error.code==='missingField'?'missingField':error.code==='unknownField'?'invalidField':error.code==='confidential'?'permission':error.code==='limit'?'limit':'invalid';const field=fields.find(field=>field.key===error.path);return {error:code,...(field?{field:field.label}:{})};}
 return {error:error instanceof LetterWorkflowError?error.code:'unavailable'};
}
export async function createGeneration(_previous:GenerationActionState,form:FormData):Promise<GenerationActionState>{
 const reissueOf=value(form,'reissueOf');if(reissueOf&&!uuid.test(reissueOf))return {error:'invalid'};
 const requestId=value(form,'requestId');if(requestId&&(!uuid.test(requestId)||reissueOf))return {error:'invalid'};
 const companyId=value(form,'companyId'),templateVersionId=value(form,'versionId'),operationKey=value(form,'operationKey'),selected=form.getAll('employmentId');
 if(!uuid.test(companyId)||!uuid.test(templateVersionId)||!uuid.test(operationKey)||!selected.length||selected.length>500||selected.some(id=>typeof id!=='string'||!uuid.test(id)))return {error:'invalid'};
 const ctx=await getSession();let saved;let fields:LetterField[]=[];
 try{
  const template=await getLetterTemplate(ctx,templateVersionId);if(!template||template.root.companyId!==companyId)return {error:'permission'};fields=template.fields.map(field=>field.definition);
  if(reissueOf){const original=await getStaffLetter(ctx,reissueOf);if(!original||original.record.companyId!==companyId||!['issued','void'].includes(original.record.state)||selected.length!==1||selected[0]!==original.record.employmentId)return {error:'permission'};}
  const custom=letterCustomValues(form,fields),customValues=Object.fromEntries((selected as string[]).map(id=>[id,custom]));
  saved=await createLetterDraftBatch(ctx,{companyId,templateVersionId,employmentIds:selected as string[],operationKey,customValues,...(reissueOf?{reissueOf}:{}),...(requestId?{requestId}:{})});
 }catch(error){return failure(error,fields);}
 revalidatePath('/letters/generate');redirect('/letters/generate/'+saved!.batchId+'?notice=created');
}
export async function updateGeneration(_previous:GenerationActionState,form:FormData):Promise<GenerationActionState>{
 const action=value(form,'action'),letterId=value(form,'letterId'),batchId=value(form,'batchId'),lock=value(form,'expectedLockVersion');
 if(!['submit','refresh','withdraw'].includes(action)||action==='submit'&&!uuid.test(batchId)||action!=='submit'&&(!uuid.test(letterId)||!/^\d{1,9}$/.test(lock)))return {error:'invalid'};
 const ctx=await getSession();let target=batchId;let fields:LetterField[]=[];
 try{
  if(action==='submit')await submitLetterBatch(ctx,batchId);
  else{
   const detail=await getStaffLetter(ctx,letterId);if(!detail)return {error:'permission'};target=detail.record.batchId;
   if(action==='withdraw')await withdrawLetterDraft(ctx,{letterId,expectedLockVersion:Number(lock),reason:value(form,'reason')});
   else{
    const template=await getLetterTemplate(ctx,detail.batch.templateVersionId);if(!template)return {error:'permission'};
    fields=template.fields.map(field=>field.definition).filter(field=>!detail.record.currentRevisionId||field.editable);
    await refreshLetterDraft(ctx,{letterId,expectedLockVersion:Number(lock),customValues:letterCustomValues(form,fields)});
   }
  }
 }catch(error){return failure(error,fields);}
 revalidatePath('/letters/generate');redirect('/letters/generate/'+target+'?notice='+action);
}
/** AI v2 Phase 1 slice 3 — HR declines an employee's letter request, with a reason that stays with HR and an optional
 * message shown to the employee. The owner service
 * re-checks the caller's `generate` capability for the request's company and the request's version. */
export async function declineLetterRequestAction(form:FormData){
 const companyId=value(form,'companyId'),requestId=value(form,'requestId'),version=value(form,'expectedVersion');
 if(!uuid.test(companyId))redirect('/letters/generate?requestError=invalid');
 // Back to the list it was declined from: the company's, or every company's (Today's link).
 const all=value(form,'requests')==='all';
 const back=(key:'requestNotice'|'requestError',code:string)=>'/letters/generate?'+new URLSearchParams({companyId,...(all?{requests:'all'}:{}),[key]:code})+'#letter-requests';
 let code:string|null=null;
 try{if(!uuid.test(requestId)||!/^\d{1,9}$/.test(version))throw new LetterRequestError('invalid');
  await declineLetterRequest(await getSession(),{requestId,reason:value(form,'reason'),employeeMessage:value(form,'employeeMessage'),expectedVersion:Number(version)});}
 catch(error){code=error instanceof LetterRequestError&&['invalid','permission','state','stale'].includes(error.code)?error.code:'unavailable';}
 if(code)redirect(back('requestError',code));
 revalidatePath('/letters/generate');redirect(back('requestNotice','declined'));
}
