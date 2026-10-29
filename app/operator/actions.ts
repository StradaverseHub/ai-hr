'use server';

import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { renameOperatorCustomer,requestOperatorModuleChange } from '@/core/operator-customers';
import { publicErrorMessage } from '@/lib/public-error';
import type { OperatorActionState } from './action-state';
import { claimActivationUrl, createProvisionRequest, requestReissue } from '@/core/operator';
import { requestOperatorMobileSetupImport, requestOperatorMobileSetupIssue } from '@/core/operator-mobile-setup';

/**
 * Operator console server actions.
 *
 * Every one of them re-resolves the session and hands it to the service, which asserts the operator
 * tier and refuses on the demo deployment before RLS gets the final word. Nothing here trusts a value
 * that came from the form without service validation of the customer metadata, code and selected modules.
 */

export async function createCustomerAction(formData: FormData): Promise<void> {
  const s = await getSession();
  await createProvisionRequest(s, {
    customerName: String(formData.get('customerName') ?? ''),
    organizationCode: String(formData.get('organizationCode') ?? ''),
    adminEmail: String(formData.get('adminEmail') ?? ''),
    country: String(formData.get('country') ?? 'MY'),
    // Carried through so the console's Retry can replay a recorded plan. The create form has no plan
    // picker yet (slice 5 adds the commercial record), so this is null on a first submission.
    plan: String(formData.get('plan') ?? '') || undefined,
    // getAll: the module picker is a checkbox group, so an unticked form sends nothing and a
    // multi-tick sends repeats of the same key. Retry re-posts the same key once per replayed module.
    // core/operator validates the codes — nothing here trusts them, matching this file's posture.
    modules: formData.getAll('modules').map(String).filter(Boolean),
  });
  revalidatePath('/operator');
}

/**
 * Reveal the activation link. Returns null when it was already revealed — a normal outcome the UI
 * renders as "already revealed, use Reissue", NOT an error.
 *
 * THIS IS DESTRUCTIVE AND MUST ONLY EVER BE BOUND TO AN EXPLICIT BUTTON CLICK. The console refreshes
 * itself on a timer, so calling this during a render would burn the one-time link before any human saw
 * it. It deliberately does not revalidate the path either: the returned URL lives in client state for
 * the operator to copy, and a re-render would throw it away.
 */
export async function revealActivationUrlAction(requestId: string): Promise<string | null> {
  const s = await getSession();
  return claimActivationUrl(s, requestId);
}

export async function requestReissueAction(requestId: string): Promise<void> {
  const s = await getSession();
  await requestReissue(s, requestId);
  revalidatePath('/operator');
}

export async function submitCustomerAction(_previous:OperatorActionState,formData:FormData):Promise<OperatorActionState> {
  try {await createCustomerAction(formData);return {ok:true,error:null};}
  catch(error){return {ok:false,error:publicErrorMessage(error)};}
}
export async function renameCustomerAction(_previous:OperatorActionState,formData:FormData):Promise<OperatorActionState> {
  try {
    await renameOperatorCustomer(await getSession(),String(formData.get('tenantId')??''),String(formData.get('customerName')??''));
    revalidatePath('/operator');revalidatePath(`/operator/customers/${String(formData.get('tenantId')??'')}`);return {ok:true,error:null};
  }catch(error){return {ok:false,error:publicErrorMessage(error)};}
}
export async function changeCustomerModuleAction(_previous:OperatorActionState,formData:FormData):Promise<OperatorActionState> {
  try {
    const disposition:Record<string,string>={};
    for(const [key,value] of formData)if(key.startsWith('disposition:'))disposition[key.slice(12)]=String(value);
    await requestOperatorModuleChange(await getSession(),{
      tenantId:String(formData.get('tenantId')??''),moduleCode:String(formData.get('moduleCode')??''),
      action:String(formData.get('action')??''),purchaseReference:String(formData.get('purchaseReference')??''),disposition,
    });
    revalidatePath('/operator');revalidatePath(`/operator/customers/${String(formData.get('tenantId')??'')}`);return {ok:true,error:null};
  }catch(error){
    revalidatePath('/operator');revalidatePath(`/operator/customers/${String(formData.get('tenantId')??'')}`);
    return {ok:false,error:publicErrorMessage(error)};
  }
}
/** ADR-0161 — records an intent only. The provisioning runner signs; this process never loads the key. */
export async function requestMobileSetupIssueAction(_previous:OperatorActionState,formData:FormData):Promise<OperatorActionState> {
  const tenantId=String(formData.get('tenantId')??'');
  try {
    await requestOperatorMobileSetupIssue(await getSession(),tenantId);
    revalidatePath(`/operator/customers/${tenantId}`);return {ok:true,error:null};
  }catch(error){return {ok:false,error:publicErrorMessage(error)};}
}
/** ADR-0161 — an uploaded company.aihr.json, verified here for an immediate answer and again by the runner. */
export async function importMobileSetupAction(_previous:OperatorActionState,formData:FormData):Promise<OperatorActionState> {
  const tenantId=String(formData.get('tenantId')??''),file=formData.get('setupFile');
  try {
    if(!(file instanceof File)||file.size<1||file.size>16_384)throw new Error('Choose a signed workplace setup file (company.aihr.json) of at most 16 KB.');
    await requestOperatorMobileSetupImport(await getSession(),tenantId,await file.text());
    revalidatePath(`/operator/customers/${tenantId}`);return {ok:true,error:null};
  }catch(error){return {ok:false,error:publicErrorMessage(error)};}
}
