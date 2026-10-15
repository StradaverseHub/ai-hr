'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  AiConfigError,
  disableAi,
  removeAiProviderConfig,
  saveAiProviderConfig,
  setActiveProvider,
  testConnection,
} from '@/core/ai-config';
import { SecretConfigError } from '@/lib/ai';
import { getTranslations } from 'next-intl/server';
import { ASSESSMENT_AI_FEATURES, setAssessmentAiSwitch, type AssessmentAiFeature } from '@/packs/performance/service';

export async function setAssessmentAiSwitchAction(formData: FormData) {
  const s = await getSession();
  const t = await getTranslations('admin.ai.assessment');
  const feature = String(formData.get('feature')) as AssessmentAiFeature;
  const on = String(formData.get('on'));
  if (!ASSESSMENT_AI_FEATURES.includes(feature) || !['true', 'false'].includes(on)) back(t('failed'));
  try { await setAssessmentAiSwitch(s, feature, on === 'true'); }
  catch { back(t('failed')); }
  revalidatePath('/performance', 'layout');
  back(undefined, t('saved'));
}

const str = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim();
  return s.length ? s : undefined;
};

/** Only our own, user-safe error messages reach the browser; a raw Postgres/RLS error (e.g. a write
 *  blocked by the FORCE-RLS policy, or a constraint violation) is mapped to a generic string so no
 *  internal SQL/schema text is disclosed in the ErrorBanner. */
function safeError(e: unknown): string {
  if (e instanceof AiConfigError || e instanceof SecretConfigError) return e.message;
  return 'Could not update AI configuration. Please try again.';
}

function back(error?: string, toast?: string): never {
  if (error) redirect(`/admin/ai?error=${encodeURIComponent(error)}`);
  revalidatePath('/admin/ai');
  redirect(`/admin/ai?toast=${encodeURIComponent(toast ?? 'Saved')}`);
}

export async function saveAiProviderConfigAction(formData: FormData) {
  const s = await getSession();
  try {
    await saveAiProviderConfig(s, {
      provider: String(formData.get('provider')),
      model: String(formData.get('model')),
      apiKey: str(formData.get('apiKey')),
      makeActive: formData.get('makeActive') != null,
    });
  } catch (e) {
    back(safeError(e));
  }
  back(undefined, 'AI configuration saved');
}

export async function setActiveProviderAction(formData: FormData) {
  const s = await getSession();
  try {
    await setActiveProvider(s, { provider: String(formData.get('provider')) });
  } catch (e) {
    back(safeError(e));
  }
  back(undefined, 'Active provider updated');
}

export async function disableAiAction() {
  const s = await getSession();
  try {
    await disableAi(s);
  } catch (e) {
    back(safeError(e));
  }
  back(undefined, 'AI drafting turned off');
}

export async function removeAiProviderConfigAction(formData: FormData) {
  const s = await getSession();
  try {
    await removeAiProviderConfig(s, { provider: String(formData.get('provider')) });
  } catch (e) {
    back(safeError(e));
  }
  back(undefined, 'Provider removed');
}

/**
 * RPC-shaped (not a redirecting form action) so the inline result can render on the card. Returns
 * only ok/false + a GENERIC reason — provider error text is mapped to generic at the gateway.
 */
export async function testConnectionAction(input: {
  provider: string;
  model: string;
  apiKey?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const s = await getSession();
  return testConnection(s, { provider: input.provider, model: input.model, apiKey: input.apiKey?.trim() || undefined });
}
