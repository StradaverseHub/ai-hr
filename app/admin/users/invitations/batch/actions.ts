'use server';
/** Board 0735d1b7 — By Batch Send Invitation. Each action admits or stops a background job through its core owner
 * (core/account-invitation-batch.ts, core/bulk-job.ts) and returns where to go (lib/action-navigation.ts): no
 * revalidatePath, no redirect from an <ActionNavigateForm>. A plain form submission is sent to the same address. */
import {redirect} from 'next/navigation';
import {getSession} from '@/lib/session';
import {requestsClientNavigation,type ActionNavigation} from '@/lib/action-navigation';
import {ACCOUNT_INVITATION_BATCH_JOB,InvitationBatchError,startInvitationBatch,startInvitationBatchRetry} from '@/core/account-invitation-batch';
import {requestBulkJobCancel} from '@/core/bulk-job';

const BASE='/admin/users/invitations/batch';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const go=(form:FormData,navigate:string):ActionNavigation=>{if(requestsClientNavigation(form))return {navigate};redirect(navigate);};
const problem=(base:string,error:unknown,extra:Record<string,string>={})=>{
 const params=new URLSearchParams(extra);
 params.set('problem',error instanceof InvitationBatchError?error.code:'failed');
 if(error instanceof InvitationBatchError&&error.count!==undefined)params.set('count',String(error.count));
 return `${base}?${params}`;
};

export async function startInvitationBatchAction(form:FormData):Promise<ActionNavigation>{
 const search=String(form.get('search')??'').slice(0,100);
 let target:string;
 try{
  if(form.get('confirmed')!=='on')throw new InvitationBatchError('invalid');
  const selection=form.get('selection')==='all'?'all':'ids';
  const started=await startInvitationBatch(await getSession(),{selection,
   personIds:form.getAll('personIds').map(String),search,role:String(form.get('role')??'employee'),
   companyId:String(form.get('companyId')??'group'),emailLocale:String(form.get('emailLocale')??'en'),
   expectedCount:Number(form.get('expectedCount')),operationKey:UUID.test(String(form.get('operationKey')??''))?String(form.get('operationKey')):undefined});
  target=`${BASE}/${started.jobId}${started.dropped?`?dropped=${started.dropped}`:''}`;
 }catch(error){target=problem(BASE,error,search?{q:search}:{});}
 return go(form,target);
}

export async function retryFailedInvitationsAction(form:FormData):Promise<ActionNavigation>{
 const jobId=String(form.get('jobId')??'');
 let target:string;
 try{
  const started=await startInvitationBatchRetry(await getSession(),{jobId,operationKey:UUID.test(String(form.get('operationKey')??''))?String(form.get('operationKey')):undefined});
  target=`${BASE}/${started.jobId}`;
 }catch(error){target=problem(UUID.test(jobId)?`${BASE}/${jobId}`:BASE,error);}
 return go(form,target);
}

export async function cancelInvitationBatchAction(form:FormData):Promise<ActionNavigation>{
 const jobId=String(form.get('jobId')??'');
 if(!UUID.test(jobId))return go(form,BASE);
 let target=`${BASE}/${jobId}`;
 try{await requestBulkJobCancel(await getSession(),jobId,ACCOUNT_INVITATION_BATCH_JOB);}
 catch{target=`${BASE}/${jobId}?problem=notStoppable`;}
 return go(form,target);
}
