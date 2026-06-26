'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import {
  archivePayComponent,
  deletePayComponent,
  PayComponentInUseError,
  PayRuleInvalidError,
  seedPayComponentCatalog,
  upsertPayComponent,
} from '@/core/pay-components';
import { draftPayRule, PayRuleDraftError } from '@/core/pay-rule-ai';
import type { PayRule } from '@/core/pay-rule';

const PAGE = '/admin/pay-components';
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
  try {
    const r = await seedPayComponentCatalog(s);
    revalidatePath(PAGE);
    back(`Seeded default catalog (${r.created} added)`);
  } catch (e) {
    fail(e);
  }
}

const bool = (fd: FormData, name: string) => fd.get(name) === 'on';

export async function upsertComponentAction(formData: FormData) {
  const s = await getSession();
  const rawKind = String(formData.get('kind') ?? 'allowance');
  const kind = (['allowance', 'deduction', 'contribution', 'non_payable'] as const).includes(rawKind as never)
    ? (rawKind as 'allowance' | 'deduction' | 'contribution' | 'non_payable')
    : 'allowance';
  const rule = parseRule(String(formData.get('rule') ?? ''));
  try {
    await upsertPayComponent(s, {
      code: String(formData.get('code') ?? '').trim().toUpperCase(),
      name: String(formData.get('name') ?? '').trim(),
      kind,
      includedInEpf: bool(formData, 'includedInEpf'),
      includedInSocsoEis: bool(formData, 'includedInSocsoEis'),
      includedInPcb: bool(formData, 'includedInPcb'),
      includedInHrdfBase: bool(formData, 'includedInHrdfBase'),
      isNonPayable: kind === 'non_payable',
      prorates: bool(formData, 'prorates'),
      eaFormLine: String(formData.get('eaFormLine') ?? '') || null,
      roundingMethod: String(formData.get('roundingMethod') ?? 'none'),
      rule,
    });
    revalidatePath(PAGE);
    back('Component saved');
  } catch (e) {
    // A bad rule ⇒ map the stable error CODE to a localised payRule.errors.* message (no raw English).
    if (e instanceof PayRuleInvalidError) {
      const t = await getTranslations('payRule');
      return fail(new Error(t(`errors.${e.code}`)));
    }
    fail(e);
  }
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

export async function archiveComponentAction(formData: FormData) {
  const s = await getSession();
  try {
    await archivePayComponent(s, String(formData.get('id')));
    revalidatePath(PAGE);
    back('Component archived');
  } catch (e) {
    fail(e);
  }
}

/** Hard delete (guarded). Friendly message when the component is still referenced (#21). */
export async function deleteComponentAction(formData: FormData) {
  const s = await getSession();
  try {
    await deletePayComponent(s, String(formData.get('id')));
  } catch (e) {
    const msg =
      e instanceof PayComponentInUseError
        ? `This component is used by ${e.refs} record(s) — archive it instead of deleting.`
        : (e as Error).message;
    return fail(new Error(msg));
  }
  revalidatePath(PAGE);
  back('Component deleted');
}
