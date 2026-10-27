'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { getBrowserCommandSession } from '@/lib/session';
import { AuthRequiredError } from '@/lib/auth-errors';
import { isAiFeature } from '@/lib/ai/features';
import {setAiSpendBudget} from '@/core/ai-spend-management';
import { AiControlError, clearUserAllowance, parseAiAllowance, setAiAllowance, setAiFeature, setAssistantPermission } from '@/core/ai-management';

const PAGE = '/control-tower/agents';

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
  } catch (e) { redirect(`${PAGE}?error=${encodeURIComponent(await commandError(e))}`); }
  revalidatePath(PAGE);
  revalidatePath('/admin/ai');
  redirect(`${PAGE}?toast=${encodeURIComponent(t('saved'))}`);
}

export async function setAiAllowanceAction(formData: FormData) {
  const t = await getTranslations('aiManagement');
  const search = String(formData.get('q') ?? '').slice(0,100);
  const query = search ? `q=${encodeURIComponent(search)}&` : '';
  try {
    const s = await getBrowserCommandSession();
    const kind = String(formData.get('kind'));
    if (kind !== 'company' && kind !== 'user' && kind !== 'user_default') throw new AiControlError(t('invalid'));
    await setAiAllowance(s, {kind,subjectId:kind==='user_default'?null:String(formData.get('subjectId')),enabled:formData.get('enabled')==='true',
      dailyRequests:parseAiAllowance(String(formData.get('dailyRequests')??''),1000000),
      monthlyTokens:parseAiAllowance(String(formData.get('monthlyTokens')??''),1000000000000),
      maxConcurrent:parseAiAllowance(String(formData.get('maxConcurrent')??''),1000000)});
  } catch (e) { redirect(`${PAGE}?${query}error=${encodeURIComponent(await commandError(e))}`); }
  revalidatePath(PAGE);
  redirect(`${PAGE}?${query}toast=${encodeURIComponent(t('saved'))}`);
}


export async function setAssistantPermissionAction(formData:FormData){
 const t=await getTranslations('aiManagement');
 const search=String(formData.get('q')??'').slice(0,100),query=search?`q=${encodeURIComponent(search)}&`:'';
 try{
  const s=await getBrowserCommandSession();
  const enabled=formData.get('enabled');if(enabled!=='true'&&enabled!=='false')throw new AiControlError(t('invalid'));
  await setAssistantPermission(s,String(formData.get('userId')??''),enabled==='true');
 }catch(e){redirect(`${PAGE}?${query}error=${encodeURIComponent(await commandError(e))}`);}
 revalidatePath(PAGE);revalidatePath('/assistant');
 redirect(`${PAGE}?${query}toast=${encodeURIComponent(t('saved'))}`);
}

export async function clearUserAllowanceAction(formData:FormData){
 const t=await getTranslations('aiManagement');
 const search=String(formData.get('q')??'').slice(0,100),query=search?`q=${encodeURIComponent(search)}&`:'';
 try{const s=await getBrowserCommandSession();await clearUserAllowance(s,String(formData.get('userId')??''));}
 catch(e){redirect(`${PAGE}?${query}error=${encodeURIComponent(await commandError(e))}`);}
 revalidatePath(PAGE);
 redirect(`${PAGE}?${query}toast=${encodeURIComponent(t('usesDefault'))}`);
}

export async function setAiSpendBudgetAction(formData:FormData){
 const t=await getTranslations('aiManagement');
 try{const session=await getBrowserCommandSession();await setAiSpendBudget(session,{kind:'tenant',monthlyUsd:String(formData.get('monthlyUsd')??''),rootUsd:String(formData.get('rootUsd')??'')});}
 catch(error){redirect(`${PAGE}?error=${encodeURIComponent(await commandError(error))}`);}
 revalidatePath(PAGE);redirect(`${PAGE}?toast=${encodeURIComponent(t('saved'))}`);
}
