'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getSession} from '@/lib/session';
import {saveLetterField} from '@/core/letters';
import {LETTER_SOURCES,LetterModelError} from '@/lib/letter-model';
import {LetterWorkflowError} from '@/lib/letter-workflow';
const value=(form:FormData,key:string)=>typeof form.get(key)==='string'?form.get(key) as string:'';
export type FieldSaveState={error:string}|null;
export async function saveField(_previous:FieldSaveState,form:FormData):Promise<FieldSaveState>{
 const companyId=value(form,'companyId'),source=value(form,'source'),ordinal=value(form,'expectedOrdinal');
 const validCompany=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId);
 if(!validCompany||!Object.hasOwn(LETTER_SOURCES,source)||!/^\d{1,9}$/.test(ordinal))return {error:'invalid'};
 const mapping=LETTER_SOURCES[source as keyof typeof LETTER_SOURCES],ctx=await getSession();let saved;
 try{saved=await saveLetterField(ctx,{companyId,expectedOrdinal:Number(ordinal),active:form.get('active')==='yes',definition:{key:value(form,'key'),label:value(form,'label'),description:value(form,'description'),source,kind:mapping.kind,required:form.get('required')==='yes',editable:form.get('editable')==='yes',sensitive:mapping.sensitive||form.get('sensitive')==='yes'}});}catch(error){
  const code=error instanceof LetterWorkflowError?error.code:error instanceof LetterModelError?'invalid':'unavailable';return {error:code};
 }
 revalidatePath('/letters/fields');redirect('/letters/fields/'+saved!.id+'?notice=saved');
}
