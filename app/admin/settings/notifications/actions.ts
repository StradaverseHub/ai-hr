'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { saveNotificationEmailPolicy, retryNotificationEmail } from '@/core/notification-email';
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
