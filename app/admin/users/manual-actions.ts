'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createManualAccount,resumeManualAccount,cancelManualAccount } from '@/core/manual-identity';
import { requireManualIdentityAdmin } from '@/lib/identity/manual-admin';
import { manualIdentityError } from '@/lib/identity/manual-model';

export async function createManualAccountAction(form:FormData) {
  const ctx=await requireManualIdentityAdmin();
  try {
    await createManualAccount(ctx,{id:String(form.get('id')??''),personId:String(form.get('personId')??''),username:String(form.get('username')??''),
      email:String(form.get('email')??''),role:String(form.get('role')??''),companyId:String(form.get('companyId')??'')||null,
      password:String(form.get('password')??''),ownershipAttested:form.get('ownershipAttested')==='true'});
  } catch(e) {redirect(`/admin/users?manualError=${manualIdentityError(e).code}`);}
  revalidatePath('/admin/users');redirect('/admin/users?manualSuccess=created');
}
export async function resumeManualAccountAction(form:FormData) {
  const ctx=await requireManualIdentityAdmin();
  try {await resumeManualAccount(ctx,String(form.get('id')??''),String(form.get('password')??''));}
  catch(e) {redirect(`/admin/users?manualError=${manualIdentityError(e).code}`);}
  revalidatePath('/admin/users');redirect('/admin/users?manualSuccess=created');
}
export async function cancelManualAccountAction(form:FormData) {
  const ctx=await requireManualIdentityAdmin();
  try {await cancelManualAccount(ctx,String(form.get('id')??''));}
  catch(e) {redirect(`/admin/users?manualError=${manualIdentityError(e).code}`);}
  revalidatePath('/admin/users');redirect('/admin/users?manualSuccess=cancelled');
}
