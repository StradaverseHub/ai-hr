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
import { evaluateProviderCandidate } from '@/core/ai-provider-readiness';
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

function providerOptions(value: string | undefined): unknown {
  if(value===undefined)return undefined;
  if(Buffer.byteLength(value,'utf8')>8192)throw new AiConfigError('Approved AI routing configuration is required.');
  try{return JSON.parse(value);}catch{throw new AiConfigError('Approved AI routing configuration is required.');}
}

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
      providerOptions: providerOptions(str(formData.get('providerOptions'))),
    });
  } catch (e) {
    back(safeError(e));
  }
  back(undefined, 'AI configuration saved');
}

export async function setActiveProviderAction(formData: FormData) {
  const s = await getSession();
  try {
    await setActiveProvider(s, { provider: String(formData.get('provider')), evaluationReceipt: str(formData.get('evaluationReceipt')) });
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
  providerOptions?: unknown;
}): Promise<{ ok: boolean; error?: string }> {
  const s = await getSession();
  try{return await testConnection(s, { provider: input.provider, model: input.model, apiKey: input.apiKey?.trim() || undefined, providerOptions:input.providerOptions });}
  catch{return {ok:false,error:(await getTranslations('admin.ai'))('testFail')};}
}

/** Explicit synthetic evaluation only: never accepts client prompts, model outputs or readiness flags. */
export async function evaluateProviderCandidateAction(input: { accountReview: boolean; consent: boolean }): Promise<
  { ok: true; receipt: string; expiresAt: string } | { ok: false }> {
  const reviewed = input?.accountReview === true, consent = input?.consent === true;
  const s = await getSession();
  try {
    if (!reviewed || !consent) return { ok: false };
    const result = await evaluateProviderCandidate(s, { provider: 'openrouter', review: {
      version: 1, accountDefaultsReviewed: true, externalProcessingReviewed: true,
    }, syntheticProbeConsent: true });
    return { ok: true, receipt: result.receipt, expiresAt: result.expiresAt };
  } catch { return { ok: false }; }
}
