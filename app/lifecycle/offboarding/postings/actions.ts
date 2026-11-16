'use server';
import {revalidatePath} from 'next/cache';
import {redirect,unstable_rethrow} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {publicErrorMessage} from '@/lib/public-error';
import {approvePersonnelPosting,editPersonnelPosting,personnelPosting,rejectOffboardingPosting,offboardingPostingChoices,isPersonnelPostingEvent} from '@/packs/personnel-postings/service';
import {commandResignationJourney} from '@/packs/lifecycle/resignation/service';
const QUEUE='/lifecycle/offboarding/postings';
const text=(data:FormData,name:string)=>String(data.get(name)??'').trim();
export async function approveOffboardingPostingAction(data:FormData){
 const ctx=await requireScopedLifecycleModule(),id=text(data,'postingId'),revision=Number(text(data,'revision'));
 try{const posting=await personnelPosting(ctx,id);if(!posting||posting.source!=='offboarding')throw new Error('Posting not found.');await approvePersonnelPosting(ctx,{id,revision});revalidatePath('/me');revalidatePath('/tasks');revalidatePath('/admin/personnel/'+posting.employmentId);}
 catch(error){unstable_rethrow(error);redirect(QUEUE+'?error='+encodeURIComponent(publicErrorMessage(error)));}
 revalidatePath(QUEUE);redirect(QUEUE);
}
export async function rejectOffboardingPostingAction(data:FormData){
 const ctx=await requireScopedLifecycleModule();
 try{await rejectOffboardingPosting(ctx,{id:text(data,'postingId'),revision:Number(text(data,'revision')),reason:text(data,'reason')});}
 catch(error){unstable_rethrow(error);redirect(QUEUE+'?error='+encodeURIComponent(publicErrorMessage(error)));}
 revalidatePath(QUEUE);redirect(QUEUE);
}
export async function retryOffboardingPostingAction(data:FormData){
 const ctx=await requireScopedLifecycleModule();
 try{
  const posting=await personnelPosting(ctx,text(data,'postingId'));if(!posting||posting.source!=='offboarding'||!posting.canRetry)throw new Error('Posting not found.');
  const {resignationCase}=await import('@/packs/lifecycle/resignation/service');const c=await resignationCase(ctx,posting.sourceRef);
  await commandResignationJourney(ctx,{caseId:c.id,revision:c.revision,command:{type:'retry'}});
 }catch(error){unstable_rethrow(error);redirect(QUEUE+'?error='+encodeURIComponent(publicErrorMessage(error)));}
 revalidatePath(QUEUE);redirect(QUEUE);
}
export async function saveOffboardingPostingAction(_previous:string|null,data:FormData):Promise<string|null>{
 const ctx=await requireScopedLifecycleModule(),id=text(data,'postingId'),revision=Number(text(data,'revision'));
 try{
  const posting=await personnelPosting(ctx,id);if(!posting||posting.source!=='offboarding'||!posting.canEdit)throw new Error('Posting not found.');
  const values:Record<string,unknown>={effectiveDate:text(data,'effectiveDate')};
  if(posting.eventType==='termination'){values.exitReason=text(data,'exitReason');values.resignationDate=posting.current.resignationDate;}
  else{
   const positions=await offboardingPostingChoices(ctx,id,text(data,'positionId')),grades=await offboardingPostingChoices(ctx,id,text(data,'gradeId'));
   if(data.get('changePosition')==='on'){const p=positions.positions.find(p=>p.id===text(data,'positionId'));if(!p)throw new Error('Choose an available Position.');values.positionId=p.id;values.position=p.name;}
   if(data.get('changeGrade')==='on'){const g=grades.grades.find(g=>g.id===text(data,'gradeId'));if(!g)throw new Error('Choose an available Job Grade.');values.gradeId=g.id;values.jobGrade=g.code;}
   if(data.get('changeSalary')==='on')values.basicSalary=text(data,'basicSalary');
  }
  if(text(data,'remarks'))values.remarks=text(data,'remarks');
  const eventType=text(data,'eventType')||posting.eventType;if(!isPersonnelPostingEvent(eventType))throw new Error('Choose an available event type.');
  if(text(data,'intent')==='approve')await approvePersonnelPosting(ctx,{id,revision,values,eventType});
  else if(text(data,'intent')==='save')await editPersonnelPosting(ctx,{id,revision,values,eventType});else throw new Error('Choose how to save this posting.');
  revalidatePath('/admin/personnel/'+posting.employmentId);
 }catch(error){unstable_rethrow(error);return publicErrorMessage(error);}
 revalidatePath(QUEUE);redirect(QUEUE);
}
