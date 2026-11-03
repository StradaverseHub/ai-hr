'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getSession} from '@/lib/session';
import {openPrivateCase,PrivateCaseError} from '@/core/private-cases';

/** AI v2 W11 — the person submits their own private case (an explicit press of "Send to HR"). The owner service and the
 * database decide everything else; the text never leaves this request except encrypted into the case. */
export async function openPrivateCaseAction(form:FormData){
 const companyId=form.get('companyId'),ctx=await getSession();
 let caseId:string|null=null,code='unavailable';
 try{
  ({caseId}=await openPrivateCase(ctx,{companyId,category:form.get('category'),text:form.get('text'),
   excludedUserIds:form.getAll('excludedUserIds'),sendTo:form.get('sendTo')==='group_admin'?'group_admin':'handlers'}));
 }catch(error){code=error instanceof PrivateCaseError?error.code:'unavailable';}
 if(!caseId){
  const company=typeof companyId==='string'&&/^[0-9a-f-]{36}$/.test(companyId)?`&companyId=${companyId}`:'';
  redirect(`/me/cases/new?error=${encodeURIComponent(code)}${company}`);
 }
 revalidatePath('/me/cases');
 redirect(`/me/cases/${caseId}?notice=sent`);
}
