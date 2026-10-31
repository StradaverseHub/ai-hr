'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { currentProviderSession } from '@/lib/identity/provider';
import { notificationEmailLocales } from '@/lib/notification-email-model';
import { saveNotificationEmailPreferences } from '@/core/notification-email';
import {saveLetterEmailPreferences} from '@/core/letter-email-preferences';
export async function saveMyWorkflowEmailPreferences(form:FormData) {
  const session=await getSession();
  const locale=notificationEmailLocales.find(l=>l===form.get('locale'));
  if(!locale)redirect('/me/notifications?error=save');
  try {
    // Missing provider proof cannot add consent; the owner still permits withdrawal without it.
    const provider=await currentProviderSession().catch(()=>null);
    const identity=provider?.emailVerified===true&&provider.issuer&&provider.subject
      ? {issuer:provider.issuer,subject:provider.subject,email:provider.email,emailVerified:true}
      : null;
    await saveNotificationEmailPreferences(session,String(form.get('employmentId')??''),form.getAll('category').map(String),locale,identity);
  }catch{redirect('/me/notifications?error=save');}
  revalidatePath('/me/notifications');redirect('/me/notifications?saved=1');
}

export async function saveMyLetterEmailPreferences(form:FormData){
 const session=await getSession(),locales=form.getAll('locale'),values=form.getAll('enabled');
 const locale=notificationEmailLocales.find(value=>value===locales[0]);
 if(locales.length!==1||!locale||values.length>1||values.some(value=>value!=='true'))redirect('/me/notifications?error=save');
 try{
  const provider=await currentProviderSession().catch(()=>null),identity=provider?.emailVerified===true&&provider.issuer&&provider.subject?{issuer:provider.issuer,subject:provider.subject,email:provider.email,emailVerified:true}:null;
  await saveLetterEmailPreferences(session,{enabled:values.length===1,locale},identity);
 }catch{redirect('/me/notifications?error=save');}
 revalidatePath('/me/notifications');redirect('/me/notifications?saved=1');
}
