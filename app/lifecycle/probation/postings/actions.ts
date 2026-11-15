'use server';
import {revalidatePath} from 'next/cache';
import {redirect,unstable_rethrow} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {publicErrorMessage} from '@/lib/public-error';
import {approvePersonnelPosting,editPersonnelPosting,postingLabel,personnelPosting} from '@/packs/personnel-postings/service';

const QUEUE='/lifecycle/probation/postings';
const text=(data:FormData,name:string)=>String(data.get(name)??'').trim();

/** Approve on the queue. The database decides whether this user is in the approver group. */
export async function approvePostingAction(data:FormData){
 const session=await requireScopedLifecycleModule();
 const id=text(data,'postingId'),revision=Number(text(data,'revision'));
 let message:string;
 try{
  const posting=await personnelPosting(session,id);
  await approvePersonnelPosting(session,{id,revision});
  const t=await getTranslations('personnelPostings');
  message=t('saved.approved',{posting:posting?.label??''});
  if(posting)revalidatePath('/admin/personnel/'+posting.employmentId);
 }catch(error){
  unstable_rethrow(error);
  redirect(QUEUE+'?error='+encodeURIComponent(publicErrorMessage(error)));
 }
 revalidatePath(QUEUE);
 redirect(QUEUE+'?toast='+encodeURIComponent(message));
}

/**
 * The movement page with ?posting=: "Save event and approve" (approver group) applies the event and approves in one
 * transaction; "Save changes for approval" keeps the corrections on the posting and writes no movement. The posted
 * intent only chooses which command runs; each command checks its own authority.
 */
export async function savePostingEventAction(_previous:string|null,data:FormData):Promise<string|null>{
 const session=await requireAdmin();
 const id=text(data,'postingId'),revision=Number(text(data,'postingRevision')),intent=text(data,'postingIntent');
 const values:Record<string,unknown>={effectiveDate:text(data,'effectiveDate'),remarks:text(data,'remarks')||null};
 if(data.has('endDate'))values.endDate=text(data,'endDate')||null;
 let message:string;
 try{
  const posting=await personnelPosting(session,id);
  if(!posting||posting.employmentId!==text(data,'employmentId'))throw new Error('Posting not found.');
  if(posting.eventType==='confirmation')delete values.endDate;
  const t=await getTranslations('personnelPostings');
  if(intent==='approve'){
   await approvePersonnelPosting(session,{id,revision,values});
   message=t('saved.approved',{posting:postingLabel(posting.number)});
  }else if(intent==='edit'){
   await editPersonnelPosting(session,{id,revision,values});
   message=t('saved.edited',{posting:postingLabel(posting.number)});
  }else throw new Error('Choose how to save this posting.');
  revalidatePath('/admin/personnel/'+posting.employmentId);
 }catch(error){
  unstable_rethrow(error);
  return publicErrorMessage(error);
 }
 revalidatePath(QUEUE);
 redirect(QUEUE+'?toast='+encodeURIComponent(message));
}
