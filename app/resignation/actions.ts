'use server';
import {revalidatePath} from 'next/cache';
import {getSession} from '@/lib/session';
import {getTranslations} from 'next-intl/server';
import {resignationCase,commandResignationJourney,submitResignationJourney,uploadResignationFile} from '@/packs/lifecycle/resignation/service';
import type {ResignationCommandInput,ResignationCaseView} from '@/lib/resignation-journey';
import {validateLeaveDocument} from '@/packs/leave/service';
export type ResignationActionResult={ok:true;value:ResignationCaseView}|{ok:false;error:string;conflict?:boolean};
function refresh(){for(const path of ['/me','/approvals','/tasks','/lifecycle/offboarding'])revalidatePath(path);revalidatePath('/','layout');}
async function refusal(error:unknown):Promise<ResignationActionResult>{const t=await getTranslations('resignationJourney');const code=error&&typeof error==='object'&&'code' in error?error.code:null;return {ok:false,error:code==='conflict'?t('changed'):error instanceof Error&&['LeaveDocumentTypeError','LeaveDocumentSizeError'].includes(error.name)?t('fileHint'):error instanceof Error&&error.name==='ResignationJourneyError'?error.message:t('failed'),conflict:code==='conflict'};}
export async function runResignationCommand(input:ResignationCommandInput):Promise<ResignationActionResult>{try{const value=await commandResignationJourney(await getSession(),input);refresh();return {ok:true,value};}catch(error){return refusal(error);}}
export async function reloadResignationCase(caseId:string):Promise<ResignationActionResult>{try{return {ok:true,value:await resignationCase(await getSession(),caseId)};}catch(error){return refusal(error);}}
export async function submitOwnResignation(form:FormData):Promise<ResignationActionResult>{
 try{const files=form.getAll('document').filter((f):f is File=>f instanceof File&&f.size>0);if(files.length>10)throw new Error('Too many attachments.');for(const file of files)validateLeaveDocument({allowedMimeTypes:['application/pdf','image/jpeg','image/png'],maxDocBytes:10*1024*1024},{mimeType:file.type,sizeBytes:file.size});
  const value=await submitResignationJourney(await getSession(),{employmentId:String(form.get('employmentId')??''),lastWorkingDay:String(form.get('lastWorkingDay')??''),reason:String(form.get('reason')??''),documents:await Promise.all(files.map(async file=>({name:file.name,mimeType:file.type,content:new Uint8Array(await file.arrayBuffer())})))});refresh();return {ok:true,value};
 }catch(error){return refusal(error);}
}

export async function uploadOwnResignationFile(form:FormData):Promise<ResignationActionResult>{
 try{const file=form.get('file');if(!(file instanceof File)||!file.size)throw new Error('Choose a file.');validateLeaveDocument({allowedMimeTypes:['application/pdf','image/jpeg','image/png'],maxDocBytes:10*1024*1024},{mimeType:file.type,sizeBytes:file.size});const value=await uploadResignationFile(await getSession(),{caseId:String(form.get('caseId')??''),revision:Number(form.get('revision')),taskId:String(form.get('taskId')??''),name:file.name,mimeType:file.type,content:new Uint8Array(await file.arrayBuffer())});refresh();return {ok:true,value};}catch(error){return refusal(error);}
}
