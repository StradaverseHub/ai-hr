'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import {saveProfileVisibilityPolicy,saveOwnPhotoSubmissionSetting} from '@/core/profile-edit-policy';
import {profileTabPolicyKey,profileSectionPolicyKey} from '@/lib/profile-edit-policy-value';
import {essVisibleFields} from '@/lib/personnel-ess-contract';
import {
  TenantSettingError,
  setTenantSetting,
} from '@/core/tenant-settings';
import {
  PROFILE_REQUEST_APPROVERS,
  PROFILE_REQUEST_APPROVER_SETTING_KEY,
  type ProfileRequestApprover,
} from '@/lib/profile-requestable-fields';

const PAGE = '/admin/settings/profile-requests';
const RULES_PAGE=PAGE+'/rules';

/** A typed refusal names WHICH condition of 0313's write policy failed; anything else reports itself. */
async function refuse(e: unknown): Promise<never> {
  const t = await getTranslations('profileRequestSettings');
  const msg = e instanceof TenantSettingError ? t(`refused.${e.reason}`) : (await getTranslations('essProfile'))('settingsFailure');
  redirect(`${PAGE}?error=${encodeURIComponent(msg)}`);
}

/**
 * WHICH FIELDS an employee may ask to change — the plan's first stage-three promise.
 *
 * ⚠️ THE POSTED NAMES ARE INTERSECTED WITH THE DECLARATION, never trusted. The form posts one `field`
 * entry per ticked box, and a hand-rolled POST could name anything at all; only keys
 * `lib/profile-requestable-fields.ts` declares survive, so this form can never store a permission over a
 * field that does not exist — or, worse, over one deliberately left out of the declaration (an HR
 * determination, or something on the withheld list an employee may not even see).
 *
 * ── AND THE PENDING REQUESTS ARE DEALT WITH IN THE SAME BREATH ──────────────────────────────────────
 * A field that was allowed and is now not is a LOCKED field, and every request waiting on one is
 * rejected with a reason the employee can read. The order matters: the setting is written FIRST, so a
 * failure part-way cannot leave requests withdrawn under a permission that was never actually changed.
 * The reason sentence is composed HERE rather than in the service because it is customer-facing prose
 * and belongs in the six catalogues, not in a core module.
 */
export async function saveProfileRequestFieldsAction(formData: FormData) {
  const s = await getSession();
  const t = await getTranslations('profileRequestSettings');

  const fields:Record<string,'editable'|'viewOnly'|'hide'>={};
  for(const field of essVisibleFields()){
    const posted=formData.getAll(`permission:${field.id}`);
    if(posted.length!==1||!['editable','viewOnly','hide'].includes(String(posted[0])))await refuse(new TenantSettingError('wrong_type'));
    fields[field.id]=posted[0] as 'editable'|'viewOnly'|'hide';
  }
  const groups:Record<string,'editable'|'viewOnly'|'hide'>={};
  const groupIds=new Set(essVisibleFields().flatMap(field=>[profileTabPolicyKey(field.tab),profileSectionPolicyKey(field.tab,field.section)]));
  for(const id of groupIds){const values=formData.getAll(`groupPermission:${id}`);if(values.length!==1||!['editable','viewOnly','hide'].includes(String(values[0])))await refuse(new TenantSettingError('wrong_type'));groups[id]=values[0] as 'editable'|'viewOnly'|'hide';}
  const primaryOnly=formData.getAll('primaryOnly');
  if(primaryOnly.some(id=>typeof id!=='string'))await refuse(new TenantSettingError('wrong_type'));
  const expectedFingerprint=String(formData.get('policyFingerprint')??'');
  if(!/^[0-9a-f]{64}$/.test(expectedFingerprint))await refuse(new TenantSettingError('wrong_type'));
  const approvals:Record<string,{required:boolean;attachmentRequired:boolean}>={};
  for(const field of essVisibleFields().filter(field=>field.ess.binding&&['immediate','approval'].includes(field.ess.edit))){
   const required=formData.getAll(`approvalRequired:${field.id}`),attachment=formData.getAll(`attachmentRequired:${field.id}`);
   if(required.length>1||required.length===1&&required[0]!=='on'||attachment.length!==1||!['true','false'].includes(String(attachment[0])))await refuse(new TenantSettingError('wrong_type'));
   approvals[field.id]={required:required.length===1,attachmentRequired:required.length===1&&attachment[0]==='true'};
  }
  let withdrawn=0;
  try{({withdrawn}=await saveProfileVisibilityPolicy(s,{policy:{version:5,fields,groups,primaryOnly,approvals},expectedFingerprint,withdrawnReason:t('withdrawnReason')}));}
  catch(e){await refuse(e);}

  revalidatePath(PAGE);
  revalidatePath('/me');
  revalidatePath('/approvals');
  const toast = withdrawn > 0 ? t('savedFieldsWithdrew', { count: withdrawn }) : t('savedFields');
  redirect(`${PAGE}?toast=${encodeURIComponent(toast)}`);
}

/**
 * WHO APPROVES — the plan's second stage-three promise, and SINGLE-LEVEL, as the reporter approved it.
 *
 * The value is matched against the closed list rather than passed through: a setting that decides who
 * may approve a pay-affecting change must never be able to hold a word nothing in the product
 * understands. An unrecognised value would resolve to `admin` on read anyway (the narrow answer), but
 * refusing it here means the stored row and the enforced rule always say the same thing.
 */
export async function saveProfileRequestApproverAction(formData: FormData) {
  const s = await getSession();
  const t = await getTranslations('profileRequestSettings');
  const raw = String(formData.get('approver') ?? '');
  const approver = PROFILE_REQUEST_APPROVERS.find((a) => a === raw) as ProfileRequestApprover | undefined;
  if (!approver) redirect(`${PAGE}?error=${encodeURIComponent(t('unknownApprover'))}`);

  try {
    await setTenantSetting(s, { key: PROFILE_REQUEST_APPROVER_SETTING_KEY, value: approver });
  } catch (e) {
    await refuse(e);
  }

  revalidatePath(PAGE);
  revalidatePath('/approvals');
  redirect(`${PAGE}?toast=${encodeURIComponent(t('savedApprover'))}`);
}

export async function saveOwnPhotoSettingAction(formData:FormData){
 const s=await getSession(),t=await getTranslations('profileRequestSettings');
 try{await saveOwnPhotoSubmissionSetting(s,{enabled:formData.get('enabled')==='on',withdrawnReason:t('withdrawnReason')});}catch(e){await refuse(e);}
 revalidatePath(PAGE);revalidatePath('/me');redirect(PAGE);
}

export async function saveNamedProfileRoutingAction(data:FormData){
 const s=await getSession(),t=await getTranslations('essProfile');
 try{
  const raw=String(data.get('policy')??'');if(raw.length>512000)throw new Error('invalid');
  const input=JSON.parse(raw) as {expectedRevision:string;enabled:boolean;rules:import('@/lib/profile-routing-policy').ProfileRouteRule[];version?:1|2|3;previewFingerprint?:string};
  const {saveProfileRoutingPolicy}=await import('@/core/profile-routing');
  await saveProfileRoutingPolicy(s,input);
 }catch{redirect(`${RULES_PAGE}?error=${encodeURIComponent(t('routingSaveFailed'))}`);}
 revalidatePath(PAGE);revalidatePath(RULES_PAGE);revalidatePath('/admin/personnel/profile-changes');revalidatePath('/', 'layout');redirect(RULES_PAGE);
}

export async function previewNamedProfileRoutingAction(data:FormData):Promise<{ok:true;matched:number;missing:number;overlapping:number;ineligible:number;fingerprint:string}|{ok:false;error:string}>{
 const s=await getSession(),t=await getTranslations('essProfile');
 try{
  const raw=String(data.get('policy')??'');if(raw.length>512000)throw new Error('invalid');
  const parsed=JSON.parse(raw) as {enabled:boolean;rules:import('@/lib/profile-routing-policy').ProfileRouteRule[];version?:1|2|3;previewFingerprint?:string};
  const {previewProfileRoutingPolicy}=await import('@/core/profile-routing');
  return {ok:true,...await previewProfileRoutingPolicy(s,{enabled:parsed.enabled,rules:parsed.rules,version:parsed.version})};
 }catch{return {ok:false,error:t('routingSaveFailed')};}
}
