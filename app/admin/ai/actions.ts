'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getBrowserCommandSession } from '@/lib/session';
import {
  AiConfigError,
  disableAi,
  discardPendingAiProviderChange,
  removeAiProviderConfig,
  saveAiProviderConfig,
  setActiveProvider,
  testConnection,
} from '@/core/ai-config';
import { evaluateProviderCandidate } from '@/core/ai-provider-readiness';
import { acceptProviderBaselineFailure, runProviderBaseline } from '@/core/ai-provider-baseline';
import { getTranslations } from 'next-intl/server';


const str = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim();
  return s.length ? s : undefined;
};

function providerOptions(value: string | undefined): unknown {
  if(value===undefined)return undefined;
  if(Buffer.byteLength(value,'utf8')>8192)throw new AiConfigError('Approved AI routing configuration is required.');
  try{return JSON.parse(value);}catch{throw new AiConfigError('Approved AI routing configuration is required.');}
}

/** Error constructors are not a disclosure boundary. Even typed provider/configuration errors
 * can carry arbitrary details; only code-owned translated copy reaches redirects. */
async function commandFailure():Promise<never>{const t=await getTranslations('admin.ai');return back(t('commandFailed'));}

function back(error?: string, toast?: string): never {
  if (error) redirect(`/control-tower/agents/provider?error=${encodeURIComponent(error)}`);
  revalidatePath('/control-tower/agents', 'layout');
  redirect(`/control-tower/agents/provider?toast=${encodeURIComponent(toast ?? 'Saved')}`);
}

export async function saveAiProviderConfigAction(formData: FormData) {
  try {
    const input={
      provider: String(formData.get('provider')),
      model: String(formData.get('model')),
      apiKey: str(formData.get('apiKey')),
      makeActive: formData.get('makeActive') != null,
      providerOptions: providerOptions(str(formData.get('providerOptions'))),
    };const s=await getBrowserCommandSession();await saveAiProviderConfig(s,input);
  } catch {
    await commandFailure();
  }
  back(undefined, 'AI configuration saved');
}

export async function setActiveProviderAction(formData: FormData) {
  try {
    const input={provider:String(formData.get('provider')),evaluationReceipt:str(formData.get('evaluationReceipt')),pendingVersion:str(formData.get('pendingVersion'))};
    const s=await getBrowserCommandSession();await setActiveProvider(s,input);
  } catch {
    await commandFailure();
  }
  back(undefined, 'Active provider updated');
}

export async function disableAiAction() {
  try {
    const s=await getBrowserCommandSession();await disableAi(s);
  } catch {
    await commandFailure();
  }
  back(undefined, (await getTranslations('admin.ai'))('providerDeactivated'));
}

/** WP14: drop a direct provider's pending change; the live configuration is unchanged. */
export async function discardPendingProviderChangeAction(formData: FormData) {
  try {
    const input={provider:String(formData.get('provider'))};const s=await getBrowserCommandSession();await discardPendingAiProviderChange(s,input);
  } catch {
    await commandFailure();
  }
  back(undefined, 'Pending change discarded');
}

/** WP14: run or continue the fixed baseline holdout suites against one pending target, on the administrator's own
 * allowance. Only closed target fields and an explicit consent cross; no prompt, output or verdict is accepted. */
export async function runProviderBaselineAction(formData: FormData) {
  try {
    const kind=String(formData.get('kind'));
    if(kind!=='pending'&&kind!=='openrouter_candidate'&&kind!=='environment')throw new AiConfigError('Unknown baseline target.');
    const input={kind,provider:str(formData.get('provider')),targetId:str(formData.get('targetId'))??null,targetVersion:str(formData.get('targetVersion'))??null,consent:formData.get('consent')==='true'} as const;
    const s=await getBrowserCommandSession();await runProviderBaseline(s,input);
  } catch {
    await commandFailure();
  }
  back(undefined, 'Baseline checks recorded');
}

/** WP14: a group administrator accepts a failed or unfinished baseline run with a recorded reason. */
export async function acceptProviderBaselineAction(formData: FormData) {
  try {
    const input={runId:String(formData.get('runId')??''),reason:String(formData.get('reason')??'')};
    const s=await getBrowserCommandSession();await acceptProviderBaselineFailure(s,input);
  } catch {
    await commandFailure();
  }
  back(undefined, 'Baseline failure accepted');
}

export async function removeAiProviderConfigAction(formData: FormData) {
  try {
    const input={provider:String(formData.get('provider'))};const s=await getBrowserCommandSession();await removeAiProviderConfig(s,input);
  } catch {
    await commandFailure();
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
  try{const captured=structuredClone(input),s=await getBrowserCommandSession();const result=await testConnection(s,{provider:captured.provider,model:captured.model,apiKey:captured.apiKey?.trim()||undefined,providerOptions:captured.providerOptions});if(result.ok===true)return{ok:true};}
  catch{/* Raw owner/session/provider reasons never reach this RPC result. */}
  return {ok:false,error:(await getTranslations('admin.ai'))('testFail')};
}

/** Explicit synthetic evaluation only: never accepts client prompts, model outputs or readiness flags. */
export async function evaluateProviderCandidateAction(input: { accountReview: boolean; consent: boolean; candidateId: string; candidateVersion: string }): Promise<
  { ok: true; receipt: string; expiresAt: string; candidateId: string; candidateVersion: string; summary: import('@/lib/ai/provider-protocol').ProviderProtocolSummary } | { ok: false }> {
  const reviewed = input?.accountReview === true, consent = input?.consent === true, candidateId = input?.candidateId, candidateVersion = input?.candidateVersion;
  try {
    const s = await getBrowserCommandSession();
    if (!reviewed || !consent) return { ok: false };
    const result = await evaluateProviderCandidate(s, { provider: 'openrouter', candidateId, candidateVersion, review: {
      version: 1, accountDefaultsReviewed: true, externalProcessingReviewed: true,
    }, syntheticProbeConsent: true });
    return { ok: true, receipt: result.receipt, expiresAt: result.expiresAt, candidateId: result.candidateId, candidateVersion: result.candidateVersion, summary:result.summary };
  } catch { return { ok: false }; }
}
