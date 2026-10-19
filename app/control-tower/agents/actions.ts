'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { isAiFeature } from '@/lib/ai/features';
import { AiControlError, clearUserAllowance, parseAiAllowance, setAiAllowance, setAiFeature, setAssistantPermission } from '@/core/ai-management';

const PAGE = '/control-tower/agents';

export async function setAiFeatureAction(formData: FormData) {
  const s = await getSession();
  const t = await getTranslations('aiManagement');
  try {
    const feature = formData.get('feature');
    const enabled = formData.get('enabled');
    if (!isAiFeature(feature) || !['true','false'].includes(String(enabled))) throw new AiControlError(t('invalid'));
    await setAiFeature(s, feature, enabled === 'true');
  } catch (e) { redirect(`${PAGE}?error=${encodeURIComponent(publicErrorMessage(e))}`); }
  revalidatePath(PAGE);
  revalidatePath('/admin/ai');
  redirect(`${PAGE}?toast=${encodeURIComponent(t('saved'))}`);
}

export async function setAiAllowanceAction(formData: FormData) {
  const s = await getSession();
  const t = await getTranslations('aiManagement');
  const search = String(formData.get('q') ?? '').slice(0,100);
  const query = search ? `q=${encodeURIComponent(search)}&` : '';
  try {
    const kind = String(formData.get('kind'));
    if (kind !== 'company' && kind !== 'user' && kind !== 'user_default') throw new AiControlError(t('invalid'));
    await setAiAllowance(s, {kind,subjectId:kind==='user_default'?null:String(formData.get('subjectId')),enabled:formData.get('enabled')==='true',
      dailyRequests:parseAiAllowance(String(formData.get('dailyRequests')??''),1000000),
      monthlyTokens:parseAiAllowance(String(formData.get('monthlyTokens')??''),1000000000000)});
  } catch (e) { redirect(`${PAGE}?${query}error=${encodeURIComponent(publicErrorMessage(e))}`); }
  revalidatePath(PAGE);
  redirect(`${PAGE}?${query}toast=${encodeURIComponent(t('saved'))}`);
}


export async function setAssistantPermissionAction(formData:FormData){
 const s=await getSession(),t=await getTranslations('aiManagement');
 const search=String(formData.get('q')??'').slice(0,100),query=search?`q=${encodeURIComponent(search)}&`:'';
 try{
  const enabled=formData.get('enabled');if(enabled!=='true'&&enabled!=='false')throw new AiControlError(t('invalid'));
  await setAssistantPermission(s,String(formData.get('userId')??''),enabled==='true');
 }catch(e){redirect(`${PAGE}?${query}error=${encodeURIComponent(publicErrorMessage(e))}`);}
 revalidatePath(PAGE);revalidatePath('/assistant');
 redirect(`${PAGE}?${query}toast=${encodeURIComponent(t('saved'))}`);
}

export async function clearUserAllowanceAction(formData:FormData){
 const s=await getSession(),t=await getTranslations('aiManagement');
 const search=String(formData.get('q')??'').slice(0,100),query=search?`q=${encodeURIComponent(search)}&`:'';
 try{await clearUserAllowance(s,String(formData.get('userId')??''));}
 catch(e){redirect(`${PAGE}?${query}error=${encodeURIComponent(publicErrorMessage(e))}`);}
 revalidatePath(PAGE);
 redirect(`${PAGE}?${query}toast=${encodeURIComponent(t('usesDefault'))}`);
}
