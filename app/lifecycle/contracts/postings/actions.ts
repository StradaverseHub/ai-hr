'use server';
import {revalidatePath} from 'next/cache';
import {redirect,unstable_rethrow} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {publicErrorMessage} from '@/lib/public-error';
import {approveContractSharedPosting,editContractSharedPosting,confirmContractSharedPay,readContractSharedPosting} from '@/packs/contracts/service';
const QUEUE='/lifecycle/contracts/postings';
const text=(form:FormData,key:string)=>String(form.get(key)??'').trim();
async function refresh(employmentId:string,caseId:string){revalidatePath(QUEUE);revalidatePath('/lifecycle/contracts');revalidatePath('/lifecycle/contracts/'+caseId);revalidatePath('/admin/personnel/'+employmentId);revalidatePath('/tasks');revalidatePath('/');}
export async function approveContractPostingAction(form:FormData){
 const session=await requireScopedLifecycleModule(),id=text(form,'postingId');
 try{
  const result=await approveContractSharedPosting(session,{id,revision:Number(text(form,'revision'))});
  const posting=await readContractSharedPosting(session,id);
  if(posting)await refresh(result.employmentId,posting.caseId);
 }catch(error){unstable_rethrow(error);redirect(QUEUE+'?error='+encodeURIComponent(publicErrorMessage(error)));}
 redirect(QUEUE+'?status=approved&saved=approved#posting-'+encodeURIComponent(id));
}
export async function confirmContractPayrollAction(form:FormData){
 const session=await requireScopedLifecycleModule(),id=text(form,'postingId');
 try{
  const posting=await readContractSharedPosting(session,id);
  if(!posting)throw new Error('Personnel posting unavailable.');
  await confirmContractSharedPay(session,{caseId:posting.caseId,expectedRevision:Number(text(form,'caseRevision')),confirmed:text(form,'confirmed')==='on'});
  await refresh(posting.employmentId,posting.caseId);
 }catch(error){unstable_rethrow(error);redirect(QUEUE+'?status=approved&error='+encodeURIComponent(publicErrorMessage(error)));}
 redirect(QUEUE+'?status=approved&saved=pay#posting-'+encodeURIComponent(id));
}
/** Same posting command on the Personnel Movement editor; it never sends a general movement payload. */
export async function saveContractPostingAction(_previous:string|null,form:FormData):Promise<string|null>{
 const session=await requireScopedLifecycleModule(),id=text(form,'postingId');
 let approved=false;
 try{
  const posting=await readContractSharedPosting(session,id);
  if(!posting||posting.employmentId!==text(form,'employmentId'))throw new Error('Personnel posting unavailable.');
  const values:Record<string,unknown>={effectiveDate:text(form,'effectiveDate'),previousEndDate:text(form,'previousEndDate'),remarks:text(form,'remarks')||null};
  if(posting.eventType==='contractRenewal'){values.endDate=text(form,'endDate');values.contractNumber=text(form,'contractNumber');}
  const input={id,revision:Number(text(form,'revision')),values};
  if(text(form,'intent')==='approve'){await approveContractSharedPosting(session,input);approved=true;}
  else if(text(form,'intent')==='edit')await editContractSharedPosting(session,{...input,eventType:posting.eventType});
  else throw new Error('Choose how to save this posting.');
  await refresh(posting.employmentId,posting.caseId);
 }catch(error){unstable_rethrow(error);return publicErrorMessage(error);}
 redirect(QUEUE+'?status='+(approved?'approved':'pending')+'&saved='+(approved?'approved':'edited')+'#posting-'+encodeURIComponent(id));
}
