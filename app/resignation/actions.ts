'use server';
import {revalidatePath} from 'next/cache';
import {getSession} from '@/lib/session';
import {getTranslations} from 'next-intl/server';
import {resignationForOffboardingCase,resignationCase,commandResignationJourney,submitResignationJourney,uploadResignationFile} from '@/packs/lifecycle/service';
import type {ResignationCommandInput,ResignationCaseView,ResignationOffboardingDocuments} from '@/lib/resignation-journey';
import {validateLeaveDocument} from '@/packs/leave/service';
export type ResignationActionResult={ok:true;value:ResignationCaseView}|{ok:false;error:string;conflict?:boolean};
export type ResignationOffboardingResult={ok:true;value:ResignationOffboardingDocuments|null}|{ok:false;error:string;conflict?:boolean};
export async function loadResignationOffboarding(offboardingCaseId:string):Promise<ResignationOffboardingResult>{try{return {ok:true,value:await resignationForOffboardingCase(await getSession(),offboardingCaseId)};}catch(error){return refusal(error);}}
function refresh(){for(const path of ['/me','/approvals','/tasks','/lifecycle/offboarding','/lifecycle/v9'])revalidatePath(path);revalidatePath('/','layout');}
async function refusal(error:unknown):Promise<Extract<ResignationActionResult,{ok:false}>>{const t=await getTranslations('resignationJourney');const code=error&&typeof error==='object'&&'code' in error?error.code:null;return {ok:false,error:code==='conflict'?t('changed'):error instanceof Error&&['LeaveDocumentTypeError','LeaveDocumentSizeError'].includes(error.name)?t('fileHint'):error instanceof Error&&error.name==='ResignationJourneyError'?error.message:t('failed'),conflict:code==='conflict'};}
export async function runResignationCommand(input:ResignationCommandInput):Promise<ResignationActionResult>{try{const value=await commandResignationJourney(await getSession(),input);refresh();return {ok:true,value};}catch(error){return refusal(error);}}
export async function reloadResignationCase(caseId:string):Promise<ResignationActionResult>{try{return {ok:true,value:await resignationCase(await getSession(),caseId)};}catch(error){return refusal(error);}}
export async function submitOwnResignation(form:FormData):Promise<ResignationActionResult>{
 try{const files=form.getAll('document').filter((f):f is File=>f instanceof File&&f.size>0);if(files.length>10||files.reduce((sum,file)=>sum+file.size,0)>10*1024*1024)return {ok:false,error:(await getTranslations('resignationJourney'))('fileHint')};for(const file of files)validateLeaveDocument({allowedMimeTypes:['application/pdf','image/jpeg','image/png'],maxDocBytes:10*1024*1024},{mimeType:file.type,sizeBytes:file.size});
  const value=await submitResignationJourney(await getSession(),{employmentId:String(form.get('employmentId')??''),lastWorkingDay:String(form.get('lastWorkingDay')??''),reason:String(form.get('reason')??''),documents:await Promise.all(files.map(async file=>({name:file.name,mimeType:file.type,content:new Uint8Array(await file.arrayBuffer())})))});refresh();return {ok:true,value};
 }catch(error){return refusal(error);}
}

export async function uploadOwnResignationFile(form:FormData):Promise<ResignationActionResult>{
 try{const file=form.get('file');if(!(file instanceof File)||!file.size)throw new Error('Choose a file.');validateLeaveDocument({allowedMimeTypes:['application/pdf','image/jpeg','image/png'],maxDocBytes:10*1024*1024},{mimeType:file.type,sizeBytes:file.size});const value=await uploadResignationFile(await getSession(),{caseId:String(form.get('caseId')??''),revision:Number(form.get('revision')),taskId:String(form.get('taskId')??''),name:file.name,mimeType:file.type,content:new Uint8Array(await file.arrayBuffer())});refresh();return {ok:true,value};}catch(error){return refusal(error);}
}

export async function loadResignationCommunications(input:{caseId?:string;offboardingCaseId?:string}):Promise<{ok:true;value:import('@/lib/resignation-communications').ResignationCommunications|null}|{ok:false;error:string}>{
 try{const service=await import('@/packs/lifecycle/resignation/service'),ctx=await getSession();return{ok:true,value:input.offboardingCaseId?await service.resignationOffboardingCommunications(ctx,input.offboardingCaseId):input.caseId?await service.resignationCaseCommunications(ctx,{caseId:input.caseId}):null};}catch(error){return refusal(error);}
}
export async function testResignationMessage(input:import('@/lib/resignation-communications').ResignationMessageTestInput):Promise<{ok:true;value:import('@/lib/resignation-communications').ResignationMessageTestResult}|{ok:false;error:string}>{
 try{const{requestResignationMessageTest}=await import('@/packs/lifecycle/resignation/service');return{ok:true,value:await requestResignationMessageTest(await getSession(),input)};}catch(error){return refusal(error);}
}
export async function editResignationMessage(input:{caseId:string;revision:number;runId:string;stepId:string;subject:string;body:string;offboardingCaseId?:string}):Promise<{ok:true;value:import('@/lib/resignation-communications').ResignationCommunications}|{ok:false;error:string}>{
 try{const{editResignationCaseMessage}=await import('@/packs/lifecycle/resignation/service');const value=await editResignationCaseMessage(await getSession(),input);refresh();return{ok:true,value};}catch(error){return refusal(error);}
}
