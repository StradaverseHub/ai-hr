'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getSession} from '@/lib/session';
import {LetterRequestError,saveLetterRequestOptions} from '@/core/letter-requests';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** AI v2 Phase 1 slice 3 — letter settings: which templates employees may request. The form lists every published template
 * (`templateId`) and posts the ticked ones (`requestable`); the owner service changes only those that differ and re-checks
 * the caller's `settings` capability for the company. */
export async function saveLetterRequestOptionsAction(form:FormData){
 const companyId=form.get('companyId'),listed=form.getAll('templateId'),ticked=new Set(form.getAll('requestable'));
 if(typeof companyId!=='string'||!uuid.test(companyId))redirect('/letters/settings?requestOptions=invalid');
 const back=(code:string)=>'/letters/settings?'+new URLSearchParams({companyId:companyId as string,requestOptions:code})+'#letter-request-options';
 let code='saved';
 try{
  if(listed.length>200||listed.some(id=>typeof id!=='string'||!uuid.test(id))||[...ticked].some(id=>!listed.includes(id)))throw new LetterRequestError('invalid');
  await saveLetterRequestOptions(await getSession(),{companyId,changes:listed.map(templateId=>({templateId,requestable:ticked.has(templateId)}))});
 }catch(error){code=error instanceof LetterRequestError&&['invalid','permission'].includes(error.code)?error.code:'unavailable';}
 if(code==='saved')revalidatePath('/letters/settings');
 redirect(back(code));
}
