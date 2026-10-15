'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { AI_AGENT_SETTINGS, TenantSettingError, setTenantSetting } from '@/core/tenant-settings';

import { isAiFeature } from '@/lib/ai/features';
import { AiControlError, parseAiAllowance, setAiAllowance, setAiFeature, setAssistantPermission } from '@/core/ai-management';

const PAGE = '/control-tower/agents';

/**
 * Turn one unattended agent on or off for this tenant.
 *
 * ⚠️ THE KEY IS NOT TAKEN FROM THE FORM. A form field naming a setting key would let anybody who can
 * open this screen write ANY tenant-scoped catalogued setting — including the two payroll risk switches,
 * which reopen a finalised run. The form posts an AGENT ID, and the key is looked up from the same
 * closed list the screen renders; an id that is not one of the three is refused before anything is read.
 */
export async function setAgentSwitchAction(formData: FormData) {
  const s = await getSession();
  const t = await getTranslations('payroll.controlTower.agents');
  const id = String(formData.get('agentId') ?? '');
  const on = String(formData.get('on') ?? '') === 'true';

  const agent = AI_AGENT_SETTINGS.find((a) => a.id === id);
  if (!agent) redirect(`${PAGE}?error=${encodeURIComponent(t('unknownAgent'))}`);

  try {
    await setTenantSetting(s, { key: agent.key, value: on });
  } catch (e) {
    // A typed refusal says WHICH condition failed; anything else is reported as itself rather than
    // flattened into a generic failure the operator cannot act on.
    const msg = e instanceof TenantSettingError ? t(`refused.${e.reason}`) : publicErrorMessage(e);
    redirect(`${PAGE}?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath(PAGE);
  revalidatePath('/control-tower/how-it-works');
  redirect(`${PAGE}?toast=${encodeURIComponent(on ? t('switchedOn') : t('switchedOff'))}`);
}

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
    if (kind !== 'company' && kind !== 'user') throw new AiControlError(t('invalid'));
    await setAiAllowance(s, {kind,subjectId:String(formData.get('subjectId')),enabled:formData.get('enabled')==='true',
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
