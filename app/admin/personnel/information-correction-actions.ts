'use server';
import {revalidatePath} from 'next/cache';
import {unstable_rethrow} from 'next/navigation';
import {requireAdmin} from '@/lib/authz';
import {publicErrorMessage} from '@/lib/public-error';
import {previewInformationCorrection,correctInformation,informationCorrectionOptions,informationCorrectionHistory} from '@/core/information-correction';
import {previewInformationUpload,confirmInformationUpload} from '@/core/information-correction-import';
import type {InformationChanges,InformationActionResult} from '@/lib/information-correction';
/** A thrown server-action error reaches a production browser only as "Minified React error #441", so every
 *  refusal comes back as data carrying its reader-facing sentence; database detail stays behind publicErrorMessage. */
async function run<T>(work:()=>Promise<T>):Promise<InformationActionResult<T>>{
 try{return {ok:true,value:await work()};}catch(error){unstable_rethrow(error);return {ok:false,error:publicErrorMessage(error)};}
}
export async function informationContextAction(employmentId:string){return run(async()=>{
 const ctx=await requireAdmin();
 const preview=await previewInformationCorrection(ctx,{employmentId,changes:{},reason:'Read current information'});
 return {preview,options:await informationCorrectionOptions(ctx),history:await informationCorrectionHistory(ctx,employmentId)};
});}
export async function previewInformationAction(input:{employmentId:string;changes:InformationChanges;reason:string}){return run(async()=>previewInformationCorrection(await requireAdmin(),{employmentId:input.employmentId,changes:input.changes,reason:input.reason}));}
export async function saveInformationAction(input:{employmentId:string;changes:InformationChanges;reason:string;fingerprint:string}){return run(async()=>{
 const result=await correctInformation(await requireAdmin(),{employmentId:input.employmentId,changes:input.changes,reason:input.reason,fingerprint:input.fingerprint,method:'manual'});
 revalidatePath('/admin/personnel');revalidatePath('/admin/personnel/'+input.employmentId);revalidatePath('/admin/personnel/[employmentId]/movement/[mode]','page');revalidatePath('/admin/personnel/[employmentId]/movement/[mode]/[movementId]','page');return result;
});}
export async function previewInformationUploadAction(data:FormData){return run(async()=>{
 const ctx=await requireAdmin(),file=data.get('file');
 if(!(file instanceof File)||file.size>10485760)throw new Error('Choose an Excel file no larger than 10 MB.');
 const result=await previewInformationUpload(ctx,{name:file.name,content:Buffer.from(await file.arrayBuffer()),operationKey:String(data.get('operationKey')??'')});
 return result;
});}
export async function confirmInformationUploadAction(input:{attemptId:string;previewHash:string}){return run(async()=>{
 const result=await confirmInformationUpload(await requireAdmin(),{attemptId:input.attemptId,previewHash:input.previewHash});
 revalidatePath('/admin/personnel');revalidatePath('/admin/personnel/[employmentId]','page');revalidatePath('/admin/personnel/[employmentId]/movement/[mode]','page');revalidatePath('/admin/personnel/[employmentId]/movement/[mode]/[movementId]','page');revalidatePath('/admin/personnel/import');revalidatePath('/admin/personnel/import/history');return result;
});}
