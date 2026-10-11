'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { keycloakSelected } from '@/lib/identity/config';
import { currentIdentitySession } from '@/lib/identity/session';
import { notificationEmailLocales } from '@/lib/notification-email-model';
import { saveNotificationEmailPreferences } from '@/core/notification-email';
export async function saveMyWorkflowEmailPreferences(form:FormData) {
  const session=await getSession();
  const locale=notificationEmailLocales.find(l=>l===form.get('locale'));
  if(!locale)redirect('/me/notifications?error=save');
  try {
    const identity=keycloakSelected()?await currentIdentitySession():null;
    await saveNotificationEmailPreferences(session,String(form.get('employmentId')??''),form.getAll('category').map(String),locale,identity);
  }catch{redirect('/me/notifications?error=save');}
  revalidatePath('/me/notifications');redirect('/me/notifications?saved=1');
}
