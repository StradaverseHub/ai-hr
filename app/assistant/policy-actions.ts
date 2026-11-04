'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getBrowserCommandSession } from '@/lib/session';
import {
  PolicyRefused, applyScheduledValue, approvePolicyVersion, createPolicy, decidePolicyValue, draftFromVersion, markTextOnly, prepareFromDrift,
  readPolicyValues, returnPolicyVersion, saveDraft, submitPolicyVersion,
} from '@/core/handbook/policies';
import { gatewayPolicyValueModel } from '@/core/handbook/provider-model';

/** AI v2 Phase 2, P2-5 — AI Centre › Policies (the Living Handbook): the writes behind the page.
 *
 * Each is a person's own action under their own login; the service checks the administrator or group administrator
 * again, and migration 2009's row-level security and triggers refuse anything else (a settings change approved by
 * anyone who contributed to it, a value applied before approval, a draft edited by someone who does not administer
 * every company it applies to). "Read the values" asks the model through the governed gateway; the model only
 * proposes, and nothing is applied until a person confirms each value and a group administrator approves. Every action
 * returns to the Policies page (/policies) with a closed result code the page translates; no other text crosses. */
const PAGE = '/policies';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: FormDataEntryValue | null) => (typeof value === 'string' ? value : '');
type Outcome = { policy?: string | null; saved?: string; extra?: Record<string, string> };

async function run(formData: FormData, act: (s: Awaited<ReturnType<typeof getBrowserCommandSession>>) => Promise<Outcome>) {
  const back = new URLSearchParams();
  const policy = text(formData.get('policy'));
  if (UUID.test(policy)) back.set('policy', policy);
  try {
    const s = await getBrowserCommandSession();
    const outcome = await act(s);
    if (outcome.policy) back.set('policy', outcome.policy);
    if (outcome.saved) back.set('saved', outcome.saved);
    for (const [key, value] of Object.entries(outcome.extra ?? {})) back.set(key, value);
  } catch (e) {
    back.set('error', e instanceof PolicyRefused ? e.reason : 'failed');
    if (formData.get('returnTo') === 'edit') back.set('edit', '1');
    if (formData.get('returnTo') === 'new') back.set('new', '1');
  }
  revalidatePath(PAGE);
  const search = back.toString();
  redirect(search ? `${PAGE}?${search}` : PAGE);
}

export async function createPolicyAction(formData: FormData) {
  await run(formData, async s => {
    const created = await createPolicy(s, { area: text(formData.get('area')), title: text(formData.get('title')), body: text(formData.get('body')),
      effectiveFrom: text(formData.get('effectiveFrom')), companyIds: formData.getAll('companies').map(String) });
    return { policy: created.documentId, saved: 'created' };
  });
}

export async function saveDraftAction(formData: FormData) {
  await run(formData, async s => {
    await saveDraft(s, { versionId: text(formData.get('versionId')), body: text(formData.get('body')), effectiveFrom: text(formData.get('effectiveFrom')),
      companyIds: formData.getAll('companies').map(String) });
    return { saved: 'draft' };
  });
}

export async function readPolicyValuesAction(formData: FormData) {
  await run(formData, async s => {
    const read = await readPolicyValues(s, { versionId: text(formData.get('versionId')) }, gatewayPolicyValueModel(s));
    return { saved: read.unparseable ? 'unread' : 'read', extra: { n: String(read.accepted), r: String(read.rejected) } };
  });
}

export async function decidePolicyValueAction(formData: FormData) {
  await run(formData, async s => {
    const decided = await decidePolicyValue(s, { valueId: text(formData.get('valueId')), decision: text(formData.get('decision')) });
    return { saved: decided.decision };
  });
}

export async function submitPolicyAction(formData: FormData) {
  await run(formData, async s => {
    const sent = await submitPolicyVersion(s, { versionId: text(formData.get('versionId')) });
    return { saved: sent.changesSettings ? 'sent_settings' : 'sent_text' };
  });
}

export async function approvePolicyAction(formData: FormData) {
  await run(formData, async s => {
    const approved = await approvePolicyVersion(s, { versionId: text(formData.get('versionId')) });
    return { saved: approved.applications.some(a => a.status === 'refused') ? 'approved_refused' : 'approved' };
  });
}

export async function returnPolicyAction(formData: FormData) {
  await run(formData, async s => {
    await returnPolicyVersion(s, { versionId: text(formData.get('versionId')) });
    return { saved: 'returned' };
  });
}

export async function applyScheduledPolicyValueAction(formData: FormData) {
  await run(formData, async s => {
    const applied = await applyScheduledValue(s, { versionId: text(formData.get('versionId')), valueId: text(formData.get('valueId')) });
    return { saved: applied.applications.some(a => a.status === 'refused') ? 'approved_refused' : 'applied' };
  });
}

export async function prepareFromDriftAction(formData: FormData) {
  await run(formData, async s => {
    const resolution = text(formData.get('resolution'));
    const prepared = await prepareFromDrift(s, { versionId: text(formData.get('versionId')), valueId: text(formData.get('valueId')), resolution });
    return { saved: resolution === 'update_handbook' ? (prepared.textRewritten ? 'drift_text' : 'drift_text_manual') : 'drift_settings' };
  });
}

export async function draftFromVersionAction(formData: FormData) {
  await run(formData, async s => {
    await draftFromVersion(s, { versionId: text(formData.get('versionId')) });
    return { saved: 'draft_made', extra: { edit: '1' } };
  });
}

/** "Keep as text only" (or withdraw it) for one enforceable setting a draft's text mentions. */
export async function markTextOnlyAction(formData: FormData) {
  await run(formData, async s => {
    const marked = text(formData.get('marked')) === 'true';
    await markTextOnly(s, { versionId: text(formData.get('versionId')), setting: text(formData.get('setting')), marked });
    return { saved: marked ? 'text_only' : 'text_only_withdrawn' };
  });
}
