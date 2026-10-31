'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { getBrowserCommandSession } from '@/lib/session';
import { AuthRequiredError } from '@/lib/auth-errors';
import { isAiFeature } from '@/lib/ai/features';
import {setAiSpendBudget} from '@/core/ai-spend-management';
import { setAgentActionPause } from '@/core/ai-inventory';
import { isAgentActionId } from '@/lib/ai/agent-action-registry';
import { aiManagementHref, type AiManagementSection } from './sections';
import { applyBulkAssistantAccess, clearGroupAllowance, setGroupAllowance, AiControlError, clearUserAllowance, parseAiAllowance, setAiAllowance, setAiFeature, setAiFeatureCap, setAssistantPermission } from '@/core/ai-management';

const PAGE = '/control-tower/agents';
/** Refusals return to the section the admin was on, beside its error banner. */
const failedAt = (section:AiManagementSection, message:string, q?:string) => aiManagementHref(section,{q,error:message});
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A successful save returns to the saved row (or its section) on its own sub-menu tab, with a closed
 *  toast code the page translates. Refusals stay at the top of that tab, beside the error banner. Only a well-formed id ever reaches the fragment. */
function savedAt(prefix:string, id:unknown, section:string): string {
  const value = String(id ?? '');
  return ROW_ID.test(value) ? `#${prefix}-${value}` : `#${section}`;
}

/** Only owned validation sentences or closed translated refusals cross this browser boundary. */
async function commandError(error: unknown): Promise<string> {
  if (error instanceof AiControlError) return publicErrorMessage(error);
  const t = await getTranslations('assistant');
  return t(error instanceof AuthRequiredError ? 'denied_no_user' : 'err_provider_error');
}

export async function setAiFeatureAction(formData: FormData) {
  const t = await getTranslations('aiManagement');
  try {
    const s = await getBrowserCommandSession();
    const feature = formData.get('feature');
    const enabled = formData.get('enabled');
    if (!isAiFeature(feature) || !['true','false'].includes(String(enabled))) throw new AiControlError(t('invalid'));
    await setAiFeature(s, feature, enabled === 'true');
  } catch (e) { redirect(failedAt('features', await commandError(e))); }
  revalidatePath(PAGE, 'layout');
  // Performance AI switches are managed only here; their screens read the same settings.
  revalidatePath('/performance', 'layout');
  const saved = formData.get('feature');
  redirect(aiManagementHref('features', {toast:'saved', anchor:isAiFeature(saved) ? `#ai-feature-${saved}` : '#ai-features'}));
}

export async function setAiAllowanceAction(formData: FormData) {
  const t = await getTranslations('aiManagement');
  const search = String(formData.get('q') ?? '').slice(0,100);
  const section:AiManagementSection = 'allowances';
  try {
    const s = await getBrowserCommandSession();
    const kind = String(formData.get('kind'));
    if (kind !== 'company' && kind !== 'user' && kind !== 'user_default') throw new AiControlError(t('invalid'));
    await setAiAllowance(s, {kind,subjectId:kind==='user_default'?null:String(formData.get('subjectId')),enabled:formData.get('enabled')==='true',
      dailyRequests:parseAiAllowance(String(formData.get('dailyRequests')??''),1000000),
      monthlyTokens:parseAiAllowance(String(formData.get('monthlyTokens')??''),1000000000000),
      maxConcurrent:parseAiAllowance(String(formData.get('maxConcurrent')??''),1000000)});
  } catch (e) { redirect(failedAt(section, await commandError(e), search)); }
  revalidatePath(PAGE);
  const kind = String(formData.get('kind'));
  const anchor = kind === 'company' ? savedAt('ai-company', formData.get('subjectId'), 'company-limits')
    : kind === 'user' ? savedAt('ai-user', formData.get('subjectId'), 'user-limits') : '#ai-user-default';
  redirect(aiManagementHref(section, {q:search, toast:'saved', anchor}));
}


export async function setAssistantPermissionAction(formData:FormData){
 const t=await getTranslations('aiManagement');
 const search=String(formData.get('q')??'').slice(0,100);
 try{
  const s=await getBrowserCommandSession();
  const enabled=formData.get('enabled');if(enabled!=='true'&&enabled!=='false')throw new AiControlError(t('invalid'));
  await setAssistantPermission(s,String(formData.get('userId')??''),enabled==='true');
 }catch(e){redirect(failedAt('allowances',await commandError(e),search));}
 revalidatePath(PAGE);revalidatePath('/assistant');
 redirect(aiManagementHref('allowances',{q:search,toast:'saved',anchor:savedAt('ai-user',formData.get('userId'),'user-limits')}));
}

export async function clearUserAllowanceAction(formData:FormData){
 const search=String(formData.get('q')??'').slice(0,100);
 try{const s=await getBrowserCommandSession();await clearUserAllowance(s,String(formData.get('userId')??''));}
 catch(e){redirect(failedAt('allowances',await commandError(e),search));}
 revalidatePath(PAGE);
 redirect(aiManagementHref('allowances',{q:search,toast:'default',anchor:savedAt('ai-user',formData.get('userId'),'user-limits')}));
}

export async function setAiSpendBudgetAction(formData:FormData){
 try{const session=await getBrowserCommandSession();await setAiSpendBudget(session,{kind:'tenant',monthlyUsd:String(formData.get('monthlyUsd')??''),rootUsd:String(formData.get('rootUsd')??'')});}
 catch(error){redirect(failedAt('spending',await commandError(error)));}
 revalidatePath(PAGE);redirect(aiManagementHref('spending',{toast:'saved',anchor:'#ai-spend'}));
}

/** Applies a bulk grant/revoke the admin reviewed. The scope and the confirmed count come from the review
 * page; the owner re-derives the people and refuses if the count no longer matches. */
export async function applyBulkAssistantAction(formData: FormData) {
  try {
    const s = await getBrowserCommandSession();
    const enabled = formData.get('enabled');
    if (enabled !== 'true' && enabled !== 'false') throw new AiControlError('Review the change again.');
    let scope: unknown;
    try { scope = JSON.parse(String(formData.get('scope') ?? '')); } catch { throw new AiControlError('Review the change again.'); }
    await applyBulkAssistantAccess(s, scope, enabled === 'true', Number(formData.get('confirmed')));
  } catch (e) { redirect(failedAt('allowances', await commandError(e))); }
  revalidatePath(PAGE, 'layout'); revalidatePath('/assistant');
  redirect(aiManagementHref('allowances', { toast: 'bulk', anchor: '#ai-bulk' }));
}

/** A group allowance for a role, company or department ('kind:subject' from a closed select). */
export async function setGroupAllowanceAction(formData: FormData) {
  try {
    const s = await getBrowserCommandSession();
    const [kind, subject] = String(formData.get('group') ?? '').split('|');
    await setGroupAllowance(s, { kind, subject, enabled: formData.get('enabled') === 'true',
      dailyRequests: parseAiAllowance(String(formData.get('dailyRequests') ?? ''), 1000000),
      monthlyTokens: parseAiAllowance(String(formData.get('monthlyTokens') ?? ''), 1000000000000),
      maxConcurrent: parseAiAllowance(String(formData.get('maxConcurrent') ?? ''), 1000000) });
  } catch (e) { redirect(failedAt('allowances', await commandError(e))); }
  revalidatePath(PAGE, 'layout');
  redirect(aiManagementHref('allowances', { toast: 'saved', anchor: '#ai-groups' }));
}
export async function clearGroupAllowanceAction(formData: FormData) {
  try {
    const s = await getBrowserCommandSession();
    const [kind, subject] = String(formData.get('group') ?? '').split('|');
    await clearGroupAllowance(s, { kind, subject });
  } catch (e) { redirect(failedAt('allowances', await commandError(e))); }
  revalidatePath(PAGE, 'layout');
  redirect(aiManagementHref('allowances', { toast: 'saved', anchor: '#ai-groups' }));
}

/** WP12 (R8): pause or resume ONE agent action (`hr_assistant:<actionId>`). Group administrators only; the owner and
 *  the database re-check. Returns to the action's inventory row. */
export async function setAgentActionPauseAction(formData: FormData) {
  const t = await getTranslations('aiManagement');
  const action = formData.get('action'), paused = String(formData.get('paused'));
  try {
    const s = await getBrowserCommandSession();
    if (!isAgentActionId(action) || !['true','false'].includes(paused)) throw new AiControlError(t('invalid'));
    await setAgentActionPause(s, action, paused === 'true');
  } catch (e) { redirect(failedAt('inventory', await commandError(e))); }
  revalidatePath(PAGE, 'layout');
  redirect(aiManagementHref('inventory', {toast:'saved', anchor:isAgentActionId(action) ? `#ai-component-action-${String(action).replace(/[^a-z0-9_-]/gi,'-')}` : '#ai-inventory'}));
}

/** WP14 / R19 — a tenant-wide cap on one AI feature (group administrators; the owner re-checks). */
export async function setAiFeatureCapAction(formData: FormData) {
  const t = await getTranslations('aiManagement');
  const feature = formData.get('feature');
  try {
    const s = await getBrowserCommandSession();
    if (!isAiFeature(feature)) throw new AiControlError(t('invalid'));
    await setAiFeatureCap(s, { feature,
      dailyRequests: parseAiAllowance(String(formData.get('dailyRequests') ?? ''), 1000000),
      monthlyTokens: parseAiAllowance(String(formData.get('monthlyTokens') ?? ''), 1000000000000),
      maxConcurrent: parseAiAllowance(String(formData.get('maxConcurrent') ?? ''), 1000000) });
  } catch (e) { redirect(failedAt('allowances', await commandError(e))); }
  revalidatePath(PAGE, 'layout');
  redirect(aiManagementHref('allowances', { toast: 'saved', anchor: isAiFeature(feature) ? `#ai-feature-cap-${feature}` : '#feature-limits' }));
}
