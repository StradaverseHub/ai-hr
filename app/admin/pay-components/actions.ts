'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import {
  archivePayComponent,
  deletePayComponent,
  lookupPayComponentByCode,
  PayComponentInUseError,
  PayRuleInvalidError,
  seedPayComponentCatalog,
  upsertPayComponent,
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

export async function upsertComponentAction(formData: FormData) {
  const s = await getSession();
  const t = await getTranslations('payComponents');
  const rawKind = String(formData.get('kind') ?? 'allowance');
  const kind = (['allowance', 'deduction', 'contribution', 'non_payable'] as const).includes(rawKind as never)
    ? (rawKind as 'allowance' | 'deduction' | 'contribution' | 'non_payable')
    : 'allowance';
  const rule = parseRule(String(formData.get('rule') ?? ''));
  const code = String(formData.get('code') ?? '').trim().toUpperCase();
  try {
    // Create-mode duplicate guard (the Pay Code field is read-only on edit): the service upsert is
    // by-code, so without this a typed-in existing code would silently OVERWRITE that code's entire
    // statutory configuration — or, colliding with a deactivated code, appear to save into the void.
    if (String(formData.get('mode') ?? '') === 'create') {
      const hit = await lookupPayComponentByCode(s, code);
      if (hit) throw new Error(hit.archivedAt ? t('errorCodeDuplicateArchived', { code }) : t('errorCodeDuplicate', { code }));
    }
    await upsertPayComponent(s, {
      code,
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
      rule,
    });
    revalidatePath(PAGE);
  } catch (e) {
    // A bad rule ⇒ map the stable error CODE to a localised payRule.errors.* message (no raw English).
    if (e instanceof PayRuleInvalidError) {
      const tr = await getTranslations('payRule');
      return fail(new Error(tr(`errors.${e.code}`)));
    }
    return fail(e);
  }
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
