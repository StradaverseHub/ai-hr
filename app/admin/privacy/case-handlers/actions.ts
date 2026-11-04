'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {requireAdmin} from '@/lib/authz';
import {designateCaseHandler,PrivateCaseError,revokeCaseHandler} from '@/core/private-cases';

/** AI v2 W11 — designating and removing private case handlers. The owner service audits each change; the database
 * admits it only for a company this administrator administers. */
const company=(form:FormData)=>{const id=form.get('companyId');return typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)?id:'';};
const back=(form:FormData,query:string)=>{const id=company(form);redirect(`/admin/privacy/case-handlers?${id?`companyId=${id}&`:''}${query}`);};
const code=(error:unknown)=>error instanceof PrivateCaseError?error.code:'unavailable';

export async function designateCaseHandlerAction(form:FormData){
 const ctx=await requireAdmin();let failure:string|null=null;
 try{await designateCaseHandler(ctx,{companyId:form.get('companyId'),appUserId:form.get('appUserId')});}catch(error){failure=code(error);}
 revalidatePath('/admin/privacy/case-handlers');
 back(form,failure?`error=${encodeURIComponent(failure)}`:'notice=added');
}

export async function revokeCaseHandlerAction(form:FormData){
 const ctx=await requireAdmin();let failure:string|null=null;
 try{await revokeCaseHandler(ctx,{handlerId:form.get('handlerId')});}catch(error){failure=code(error);}
 revalidatePath('/admin/privacy/case-handlers');
 back(form,failure?`error=${encodeURIComponent(failure)}`:'notice=removed');
}
