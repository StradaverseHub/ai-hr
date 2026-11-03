'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getSession} from '@/lib/session';
import {addPrivateCaseNote,PrivateCaseError,setPrivateCaseStatus} from '@/core/private-cases';

/** AI v2 W11 — a handler's two acts on a private case. The owner service and row-level security decide who may act;
 * these only carry the form and return to the case. */
const caseOf=(form:FormData)=>{const id=form.get('caseId');return typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)?id:null;};
const code=(error:unknown)=>error instanceof PrivateCaseError?error.code:'unavailable';

export async function setPrivateCaseStatusAction(form:FormData){
 const caseId=caseOf(form),ctx=await getSession();
 if(!caseId)redirect('/cases');
 let erased=false,failure:string|null=null;
 try{({erased}=await setPrivateCaseStatus(ctx,{caseId,expected:form.get('expected'),status:form.get('status')}));}catch(error){failure=code(error);}
 revalidatePath('/cases');
 if(failure==='not_found')redirect('/cases');
 if(failure)redirect(`/cases/${caseId}?error=${encodeURIComponent(failure)}`);
 // A case its author's erasure was waiting on is gone once closed.
 if(erased)redirect('/cases?notice=erased');
 redirect(`/cases/${caseId}?notice=status`);
}

export async function addPrivateCaseNoteAction(form:FormData){
 const caseId=caseOf(form),ctx=await getSession();
 if(!caseId)redirect('/cases');
 let failure:string|null=null;
 try{await addPrivateCaseNote(ctx,{caseId,text:form.get('text')});}catch(error){failure=code(error);}
 if(failure==='not_found')redirect('/cases');
 if(failure)redirect(`/cases/${caseId}?error=${encodeURIComponent(failure)}`);
 redirect(`/cases/${caseId}?notice=note`);
}
