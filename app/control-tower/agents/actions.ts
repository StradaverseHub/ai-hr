'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { AI_AGENT_SETTINGS, TenantSettingError, setTenantSetting } from '@/core/tenant-settings';

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
    const msg = e instanceof TenantSettingError ? t(`refused.${e.reason}`) : (e as Error).message;
    redirect(`${PAGE}?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath(PAGE);
  revalidatePath('/control-tower/how-it-works');
  redirect(`${PAGE}?toast=${encodeURIComponent(on ? t('switchedOn') : t('switchedOff'))}`);
}
