'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { saveNotificationEmailPolicy, retryNotificationEmail } from '@/core/notification-email';
import {retryAccountEmail} from '@/core/auth';
import {requireIdentityEmailAdmin} from '@/lib/identity/email-settings';
export async function saveWorkflowEmailPolicy(form:FormData) {
  const session=await getSession();
  try{await saveNotificationEmailPolicy(session,form.getAll('category').map(String));}catch{redirect('/admin/settings/notifications?error=save');}
  revalidatePath('/admin/settings/notifications');redirect('/admin/settings/notifications?saved=1');
}
export async function retryWorkflowEmail(form:FormData) {
  const session=await getSession();
  try{await retryNotificationEmail(session,String(form.get('deliveryId')??''),form.get('acknowledged')==='true');}catch{redirect('/admin/settings/notifications?error=retry');}
  revalidatePath('/admin/settings/notifications');redirect('/admin/settings/notifications?saved=1');
}
export async function retryAccountEmailAction(form:FormData){
  const path=form.get('returnTo')==='/admin/settings/email'?'/admin/settings/email':'/admin/settings/notifications';
  // A form kind selects the stronger guard; it grants no capability. Core/RLS refuse recovery
  // without the verified installation actor, even if a caller claims this is an invitation.
  const identity=form.get('kind')==='recovery'?await requireIdentityEmailAdmin():null;
  const session=identity?.session??await getSession();
  try{
    await retryAccountEmail(session,String(form.get('deliveryId')??''),form.get('acknowledged')==='true',identity?.actor);
  }catch{redirect(`${path}?error=account-retry`);}
  revalidatePath('/admin/users');revalidatePath('/admin/settings/email');revalidatePath('/admin/settings/notifications');
  redirect(`${path}?accountRetry=1`);
}
