'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { getBrowserCommandSession } from '@/lib/session';
import { AuthRequiredError } from '@/lib/auth-errors';
import { setWorkerSwitch, WorkerControlRefused } from '@/core/agent-registry/controls';
import { aiManagementHref } from './sections';

/** AI centre › Workers: the switch for the two workers whose switch lives in the worker registry
 * (approver recommendations, explainers). The registry service is the authority: it refuses anyone but a
 * group administrator, and any worker whose switch lives elsewhere. Only closed refusal words reach the page. */
export async function setWorkerSwitchAction(formData: FormData) {
  const t = await getTranslations('aiCentre.registry');
  const workerId = String(formData.get('workerId') ?? '');
  try {
    const session = await getBrowserCommandSession();
    await setWorkerSwitch(session, { workerId, enabled: formData.get('enabled') === 'true' });
  } catch (error) {
    const reason = error instanceof WorkerControlRefused ? error.reason : error instanceof AuthRequiredError ? 'not_administrator' : 'failed';
    redirect(aiManagementHref('features', { error: t(`refused.${reason}`), anchor: '#ai-registry' }));
  }
  revalidatePath('/control-tower/agents', 'layout');
  redirect(aiManagementHref('features', { toast: 'saved', anchor: /^[a-z_]{1,64}$/.test(workerId) ? `#worker-${workerId}` : '#ai-registry' }));
}
