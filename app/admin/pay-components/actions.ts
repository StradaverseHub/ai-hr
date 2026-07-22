'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import {
  archivePayComponent,
  createPayComponent,
  deletePayComponent,
  PayComponentCodeExistsError,
  PayComponentInUseError,
  PayRuleInvalidError,
  seedPayComponentCatalog,
  upsertPayComponent,
  type PayComponentInput,
} from '@/core/pay-components';
import { draftPayRule, PayRuleDraftError } from '@/core/pay-rule-ai';
import type { PayRule } from '@/core/pay-rule';

const PAGE = '/admin/pay-components';
// NOTE — redirect() throws NEXT_REDIRECT by design. back()/fail() must therefore be called OUTSIDE any
// try/catch: a back() inside a try is caught, re-thrown through fail(e), and toasts the raw redirect
// sentinel instead of the intended message (the pre-existing bug this file used to carry).
const back = (toast: string) => redirect(`${PAGE}?toast=${encodeURIComponent(toast)}`);
const fail = (e: unknown) => redirect(`${PAGE}?error=${encodeURIComponent((e as Error).message)}`);

/** Parse the serialised rule from the form's hidden `rule` field. Empty ⇒ null (fixed/legacy). Structurally
 *  invalid JSON ⇒ null (the service revalidates anyway; this is a tolerant parse). */
function parseRule(raw: string): PayRule | null {
  if (!raw.trim()) return null;
  try {
    const r = JSON.parse(raw) as PayRule;
    return r;
  } catch {
    return null;
  }
}

export async function seedCatalogAction() {
  const s = await getSession();
  const t = await getTranslations('payComponents');
  let created: number;
  try {
    const r = await seedPayComponentCatalog(s);
    created = r.created;
    revalidatePath(PAGE);
  } catch (e) {
    return fail(e);
  }
  back(t('toastSeeded', { created }));
}

const bool = (fd: FormData, name: string) => fd.get(name) === 'on';

/** The maintenance form's fields → a typed service input (shared by create and update). */
function componentFields(formData: FormData): PayComponentInput {
  const rawKind = String(formData.get('kind') ?? 'allowance');
  const kind = (['allowance', 'deduction', 'contribution', 'non_payable'] as const).includes(rawKind as never)
    ? (rawKind as 'allowance' | 'deduction' | 'contribution' | 'non_payable')
    : 'allowance';
  return {
    code: String(formData.get('code') ?? '').trim().toUpperCase(),
    name: String(formData.get('name') ?? '').trim(),
    // Optional short display name; the service trims and stores blank as null.
    label: String(formData.get('label') ?? ''),
    kind,
    includedInEpf: bool(formData, 'includedInEpf'),
    includedInSocsoEis: bool(formData, 'includedInSocsoEis'),
    includedInPcb: bool(formData, 'includedInPcb'),
    includedInHrdfBase: bool(formData, 'includedInHrdfBase'),
    isNonPayable: kind === 'non_payable',
    prorates: bool(formData, 'prorates'),
    // Hidden passthrough — the EA line left the maintenance SCREEN (moving to a dedicated statutory
    // module later); the form re-submits the row's current value so existing mappings survive a save.
    eaFormLine: String(formData.get('eaFormLine') ?? '') || null,
    roundingMethod: String(formData.get('roundingMethod') ?? 'none'),
    rule: parseRule(String(formData.get('rule') ?? '')),
  };
}

/** Map a service rejection to a LOCALISED message (no raw English error codes on screen). */
async function messageOf(e: unknown, t: Awaited<ReturnType<typeof getTranslations>>): Promise<string> {
  // A bad rule ⇒ map the stable error CODE to a localised payRule.errors.* message.
  if (e instanceof PayRuleInvalidError) {
    const tr = await getTranslations('payRule');
    return tr(`errors.${e.code}`);
  }
  // Duplicate code on create ⇒ one message for an active hit, another for "deactivated — reactivate it".
  if (e instanceof PayComponentCodeExistsError) {
    return e.archived ? t('errorCodeDuplicateArchived', { code: e.code }) : t('errorCodeDuplicate', { code: e.code });
  }
  return (e as Error).message;
}

/** Save & New ⇒ back to a BLANK /new: the toast survives ToastFromQuery only strips toast/error, and the
 *  `fresh` nonce keys the /new page so the whole form — PayRuleEditor island included — remounts blank. */
const saveAndNewTarget = (toast: string) => `${PAGE}/new?toast=${encodeURIComponent(toast)}&fresh=${Date.now()}`;

/**
 * 911b2886 — CREATE from the dedicated /new maintenance screen. Delegates to createPayComponent, which
 * REFUSES an existing code (active or archived) instead of silently upserting into it. Error path
 * redirects back to /new with the localised message; success redirect sits OUTSIDE the try/catch
 * (redirect() throws NEXT_REDIRECT — the deleteComponentAction pattern).
 */
export async function createComponentAction(formData: FormData) {
  const s = await getSession();
  const t = await getTranslations('payComponents');
  const saveAndNew = formData.get('intent') === 'saveAndNew';
  try {
    await createPayComponent(s, componentFields(formData));
    revalidatePath(PAGE);
  } catch (e) {
    redirect(`${PAGE}/new?error=${encodeURIComponent(await messageOf(e, t))}`);
  }
  if (saveAndNew) redirect(saveAndNewTarget(t('toastSaved')));
  back(t('toastSaved'));
}

/**
 * 911b2886 — UPDATE from the dedicated /[code] maintenance screen (the Pay Code field is read-only there,
 * so the by-code upsert targets the row being edited). Error path redirects back to that component's own
 * edit route; success redirect sits OUTSIDE the try/catch.
 */
export async function updateComponentAction(formData: FormData) {
  const s = await getSession();
  const t = await getTranslations('payComponents');
  const input = componentFields(formData);
  const saveAndNew = formData.get('intent') === 'saveAndNew';
  try {
    await upsertPayComponent(s, input);
    revalidatePath(PAGE);
  } catch (e) {
    redirect(`${PAGE}/${encodeURIComponent(input.code)}?error=${encodeURIComponent(await messageOf(e, t))}`);
  }
  if (saveAndNew) redirect(saveAndNewTarget(t('toastSaved')));
  back(t('toastSaved'));
}

/**
 * AI-assist: draft a pay-rule from a plain-language description. DRAFT-ONLY — returns the rule + explanation
 * for the client to populate the form; it never writes the component (the admin still clicks Save). Degrades
 * to a localised message when AI is unconfigured or the model can't produce a valid rule.
 */
export async function draftPayRuleAction(p: {
  description: string;
  componentCode: string | null;
  componentProrates: boolean;
}): Promise<{ rule?: PayRule; explanation?: string; error?: string }> {
  const s = await getSession();
  const t = await getTranslations('payRule');
  try {
    const { rule, explanation } = await draftPayRule(s, {
      description: p.description,
      componentCode: p.componentCode,
      componentProrates: p.componentProrates,
    });
    return { rule, explanation };
  } catch (e) {
    if (e instanceof PayRuleDraftError) {
      return { error: e.reason === 'not_configured' ? t('assistUnconfigured') : t('assistFailed') };
    }
    return { error: (e as Error).message };
  }
}

/** Deactivate OR reactivate (feedback 4994a48f) — one toggle action over the house-shaped service toggle. */
export async function archiveComponentAction(formData: FormData) {
  const s = await getSession();
  const t = await getTranslations('payComponents');
  const archived = String(formData.get('archived')) === 'true';
  try {
    await archivePayComponent(s, { id: String(formData.get('id')), archived });
    revalidatePath(PAGE);
  } catch (e) {
    return fail(e);
  }
  back(archived ? t('toastDeactivated') : t('toastReactivated'));
}

/** Hard delete (guarded). Friendly message when the component is still referenced (#21). */
export async function deleteComponentAction(formData: FormData) {
  const s = await getSession();
  const t = await getTranslations('payComponents');
  try {
    await deletePayComponent(s, String(formData.get('id')));
  } catch (e) {
    const msg = e instanceof PayComponentInUseError ? t('errorInUse', { refs: e.refs }) : (e as Error).message;
    return fail(new Error(msg));
  }
  revalidatePath(PAGE);
  back(t('toastDeleted'));
}
