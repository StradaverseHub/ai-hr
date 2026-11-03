'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getTranslations} from 'next-intl/server';
import {getSession} from '@/lib/session';
import {createMyLetterAccess,acknowledgeMyLetter} from '@/core/letters';
import {LetterWorkflowError} from '@/lib/letter-workflow';
import {LetterRequestError,submitLetterRequest} from '@/core/letter-requests';
const identity=(value:FormDataEntryValue|null)=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)?value:null;
function back(id:string|null,error:string){redirect(`${id?'/me/letters/'+id:'/me/letters'}?error=${encodeURIComponent(error)}`);}
export async function openMyLetter(form:FormData){
 const id=identity(form.get('letterId'));if(!id)back(null,'invalid');const ctx=await getSession();let access;
 try{access=await createMyLetterAccess(ctx,id!);}catch(error){back(id,error instanceof LetterWorkflowError?error.code:'unavailable');}
 redirect(`/me/letters/${id}/document?token=${encodeURIComponent(access!.token)}&inline=${form.get('disposition')==='attachment'?'0':'1'}`);
}
export async function confirmMyLetter(form:FormData){
 const id=identity(form.get('letterId')),action=form.get('action'),expectedArtifactHash=form.get('artifactHash');if(!id||!['acknowledge','signature'].includes(String(action))||form.get('confirm')!=='yes'||typeof expectedArtifactHash!=='string'||!/^[0-9a-f]{64}$/.test(expectedArtifactHash))back(id,'invalid');
 const ctx=await getSession(),t=await getTranslations('letters.mine');let recorded;
 try{recorded=await acknowledgeMyLetter(ctx,{letterId:id!,expectedArtifactHash:expectedArtifactHash as string,action:action as 'acknowledge'|'signature',intent:action==='signature'?t('signatureIntent'):t('acknowledgementIntent')});}catch(error){back(id,error instanceof LetterWorkflowError?error.code:'unavailable');}
 revalidatePath('/me/letters');revalidatePath('/me/letters/'+id);redirect(`/me/letters/${id}?notice=${recorded!.alreadyRecorded?'alreadyRecorded':'recorded'}`);
}
/** AI v2 Phase 1 slice 3 — the person sends their own letter request (an explicit press of "Send request"). `choice` is
 * "<employmentId>.<templateId>" from the form's own list; the owner service and the database decide the rest. */
export async function requestLetterAction(form:FormData){
 const choice=form.get('choice'),purpose=form.get('purpose');
 const [employmentId,templateId]=typeof choice==='string'?choice.split('.'):[];
 const ctx=await getSession();let code:string|null=null;
 try{if(!identity(employmentId??null)||!identity(templateId??null))throw new LetterRequestError('invalid');
  await submitLetterRequest(ctx,{employmentId,templateId,purpose:typeof purpose==='string'?purpose:null});}
 catch(error){code=error instanceof LetterRequestError&&['invalid','not_requestable','duplicate'].includes(error.code)?error.code:'unavailable';}
 if(code)redirect('/me/letters?'+new URLSearchParams({request:'1',requestError:code,...(identity(templateId??null)?{template:templateId}:{})})+'#request-letter');
 revalidatePath('/me/letters');redirect('/me/letters?notice=requested');
}
