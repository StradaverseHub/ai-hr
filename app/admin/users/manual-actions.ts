'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createManualAccount,resumeManualAccount,cancelManualAccount } from '@/core/manual-identity';
import { requireManualIdentityAdmin } from '@/lib/identity/manual-admin';
import { manualIdentityError } from '@/lib/identity/manual-model';

export async function createManualAccountAction(form:FormData) {
  const ctx=await requireManualIdentityAdmin();
  try {
    await createManualAccount(ctx,{id:String(form.get('id')??''),personId:form.get('accountType')==='standalone'?null:String(form.get('personId')??''),fullName:String(form.get('fullName')??''),username:String(form.get('username')??''),
      email:String(form.get('email')??''),role:String(form.get('role')??''),companyId:form.get('companyId')==='group'?null:String(form.get('companyId')??'')||null,
      password:String(form.get('password')??''),ownershipAttested:form.get('ownershipAttested')==='true'});
  } catch(e) {redirect(`/admin/users/create?manualError=${manualIdentityError(e).code}`);}
  revalidatePath('/admin/users');revalidatePath('/admin/users/create');redirect('/admin/users/create?manualSuccess=created');
}
export async function resumeManualAccountAction(form:FormData) {
  const ctx=await requireManualIdentityAdmin();
  try {await resumeManualAccount(ctx,String(form.get('id')??''),String(form.get('password')??''));}
  catch(e) {redirect(`/admin/users/create?manualError=${manualIdentityError(e).code}`);}
  revalidatePath('/admin/users');revalidatePath('/admin/users/create');redirect('/admin/users/create?manualSuccess=created');
}
export async function cancelManualAccountAction(form:FormData) {
  const ctx=await requireManualIdentityAdmin();
  try {await cancelManualAccount(ctx,String(form.get('id')??''));}
  catch(e) {redirect(`/admin/users/create?manualError=${manualIdentityError(e).code}`);}
  revalidatePath('/admin/users');revalidatePath('/admin/users/create');redirect('/admin/users/create?manualSuccess=cancelled');
}
