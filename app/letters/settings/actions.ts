'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getSession} from '@/lib/session';
import {saveLetterPolicy,addLetterAsset} from '@/core/letters';
import {validateLetterPolicy,LetterWorkflowError} from '@/lib/letter-workflow';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const value=(form:FormData,key:string)=>typeof form.get(key)==='string'?form.get(key) as string:'';
const number=(form:FormData,key:string)=>/^\d{1,6}$/.test(value(form,key))?Number(value(form,key)):NaN;
export type LetterSettingsActionState={error:string;detail?:string}|null;
const failure=(error:unknown):LetterSettingsActionState=>({error:error instanceof LetterWorkflowError?error.code:'unavailable',...(error instanceof LetterWorkflowError&&error.detail?{detail:error.detail}:{})});
export async function savePolicySettings(_previous:LetterSettingsActionState,form:FormData):Promise<LetterSettingsActionState>{
 const companyId=value(form,'companyId'),category=value(form,'category').trim(),ordinal=value(form,'expectedOrdinal'),encoded=value(form,'stages');
 if(!uuid.test(companyId)||!category||category.length>100||!/^\d{1,9}$/.test(ordinal)||encoded.length>70_000)return {error:'invalid'};
 let stages:unknown;try{stages=JSON.parse(encoded);}catch{return {error:'invalid'};}
 let policy;try{policy=validateLetterPolicy({version:1,stages,signatoryUserId:value(form,'signatoryUserId'),signingMode:value(form,'signingMode'),signatureAssetId:value(form,'signatureAssetId')||null,letterheadAssetId:value(form,'letterheadAssetId')||null,referenceFormat:value(form,'referenceFormat'),retentionDays:number(form,'retentionDays'),sensitiveLinkMinutes:number(form,'sensitiveLinkMinutes'),acknowledgement:value(form,'acknowledgement'),approvalDueHours:number(form,'approvalDueHours'),acknowledgementDueDays:number(form,'acknowledgementDueDays'),reminderHours:number(form,'reminderHours'),escalationUserId:value(form,'escalationUserId')||null,portalNotifications:value(form,'portalNotifications')==='yes',emailNotifications:value(form,'emailNotifications')==='yes'});}catch(error){return failure(error);}
 const ctx=await getSession();try{await saveLetterPolicy(ctx,{companyId,category,enabled:value(form,'enabled')==='yes',expectedOrdinal:Number(ordinal),policy});}catch(error){return failure(error);}
 revalidatePath('/letters/settings');redirect('/letters/settings/policy?'+new URLSearchParams({companyId,category,notice:'saved'}));
}
export async function uploadLetterAsset(_previous:LetterSettingsActionState,form:FormData):Promise<LetterSettingsActionState>{
 const companyId=value(form,'companyId'),kind=value(form,'kind'),name=value(form,'name').trim(),file=form.get('file');
 if(!uuid.test(companyId)||!['letterhead','signature'].includes(kind)||!name||name.length>200||!(file instanceof File)||file.size<24||file.size>2_097_152)return {error:'invalid',detail:'png'};
 const ctx=await getSession();try{await addLetterAsset(ctx,{companyId,kind:kind as 'letterhead'|'signature',name,content:Buffer.from(await file.arrayBuffer())});}catch(error){return failure(error);}
 revalidatePath('/letters/settings');redirect('/letters/settings?'+new URLSearchParams({companyId,q:name,notice:'saved'}));
}
