'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import {
  archivePayComponent,
  createPayComponent,
  deletePayComponent,
  isStatutoryRelevantChange,
  isUnsupportedTaxableComponent,
  unsupportedTaxableReason,
  validateStatutoryClassification,
  listPayRulePreviewCandidates,
  PayComponentCodeExistsError,
  PayComponentInUseError,
  PayComponentStatutoryConfigError,
  PayRuleInvalidError,
  previewPayRule,
  seedPayComponentCatalog,
  upsertPayComponent,
  type PayComponentInput,
  type PcbRemunerationType,
} from '@/core/pay-components';
// 017d9c25 — the pack facade, not core/payroll directly (ADR-0080 pack import ratchet).
import { markRunsAffectedByPayComponent } from '@/packs/payroll/service';
import { draftPayRule, PayRuleDraftError } from '@/core/pay-rule-ai';
import type { PayRule, PayRuleTraceStep } from '@/core/pay-rule';

const PAGE = '/admin/pay-components';
// NOTE — redirect() throws NEXT_REDIRECT by design. back()/fail() must therefore be called OUTSIDE any
// try/catch: a back() inside a try is caught, re-thrown through fail(e), and toasts the raw redirect
// sentinel instead of the intended message (the pre-existing bug this file used to carry).
const back = (toast: string) => redirect(`${PAGE}?toast=${encodeURIComponent(toast)}`);
const fail = (e: unknown) => redirect(`${PAGE}?error=${encodeURIComponent(publicErrorMessage(e))}`);

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
    // Feedback 09b554e9 — LHDN PCB 2026 classification. The form ALWAYS supplies these (nulls when the
    // panels hide them), so the service's mandatory-pair / wrong-list / epf-bonus-without-epf validation is
    // authoritative on every save (PayComponentStatutoryConfigError → localised message below).
    epfBonus2012: bool(formData, 'epfBonus2012'),
    pcbRemunerationType: (String(formData.get('pcbRemunerationType') ?? '') || null) as PcbRemunerationType | null,
    pcbExemptionCode: String(formData.get('pcbExemptionCode') ?? '') || null,
    // Feedback 3c473773 — the Payroll Category (which box on the payslip this item prints in). The form
    // ALWAYS supplies it, so a save is authoritative; blank ⇒ null ⇒ the box falls back to the pre-0393
    // inference. It changes DISPLAY only — no statutory flag, base or form reads it.
    displayCategory: String(formData.get('displayCategory') ?? '') || null,
    // 711adcd2 — the two ORP tick boxes. The form ALWAYS renders both, so an absent field means UNTICKED
    // rather than "not supplied", and a save is authoritative for both columns. That is why neither
    // checkbox may ever be rendered disabled: a disabled control posts nothing, which reads here as a
    // deliberate untick and would silently drop a pay item out of somebody's overtime rate.
    orpUnpaidLeave: bool(formData, 'orpUnpaidLeave'),
    orpOvertime: bool(formData, 'orpOvertime'),
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
  // Feedback 09b554e9 — incomplete/inconsistent statutory classification (mandatory PCB pair, wrong-list
  // exemption code, EPF Bonus 2012 without EPF). Stable code → localised message, like PayRuleInvalidError.
  if (e instanceof PayComponentStatutoryConfigError) {
    return t(`errorStatutory_${e.code}`);
  }
  return publicErrorMessage(e);
}

/**
 * f35f758a note 8 — THE COMBINATION THAT COULD BE SAVED AND THEN STOPPED A PAYROLL RUN.
 *
 * `isUnsupportedTaxableComponent` is the kernel's own fail-closed condition (core/payroll.ts `earningsOf`
 * throws `UnsupportedPayComponentError` on it), and it was already enforced on the batch picker,
 * `setPayrollBatchComponent` and the CSV importer — but NOT here, on the screen an operator actually uses
 * to define a pay item. So Non-payable + "subject to PCB" with no Remuneration Type saved cleanly, was
 * assignable to an employee, and then blew up the whole payroll run for everybody carrying it, with an
 * English exception message and nothing pointing at the pay item that caused it.
 *
 * Refused HERE instead, with the reason, in the reader's own language. Returns the message rather than
 * throwing because `redirect()` signals by THROWING (NEXT_REDIRECT) and must be called outside a
 * try/catch — see the note at the head of this file.
 *
 * STATE-BASED, so this never traps a row: a pay item already carrying the bad combination can still be
 * opened and edited back into a good one, because the check reads what is being SAVED.
 */
function unsupportedTaxableMessage(
  input: PayComponentInput,
  t: Awaited<ReturnType<typeof getTranslations>>,
): string | null {
  // Check the actual submitted pair first: Normal must never be reported as missing merely because
  // a benefit category was dropped by a projection. Legacy service callers retain their own semantics.
  const classification = validateStatutoryClassification(input);
  if (!classification.ok) return t(`errorStatutory_${classification.code}`);
  if (!isUnsupportedTaxableComponent(input)) return null;
  const reason = unsupportedTaxableReason(input);
  return reason === 'unrecognised_taxable_item'
    ? t('errorUnsupportedTaxable', { code: input.code })
    : t(`errorBenefit_${reason}`, { code: input.code });
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
  const input = componentFields(formData);
  const saveAndNew = formData.get('intent') === 'saveAndNew';
  // Outside the try/catch on purpose: redirect() throws NEXT_REDIRECT, and a redirect inside the try is
  // caught below and toasted as the raw sentinel (the bug this file's header note records).
  const unsupported = unsupportedTaxableMessage(input, t);
  if (unsupported) redirect(`${PAGE}/new?error=${encodeURIComponent(unsupported)}`);
  try {
    await createPayComponent(s, input);
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
  // Same fail-closed guard as create, and outside the try/catch for the same redirect() reason.
  const unsupported = unsupportedTaxableMessage(input, t);
  if (unsupported) redirect(`${PAGE}/${encodeURIComponent(input.code)}?error=${encodeURIComponent(unsupported)}`);
  try {
    const { id, changed } = await upsertPayComponent(s, input);
    // ── Feedback 017d9c25 (r187) — a statutory edit marks the runs it makes stale ──────────────────
    // Keying a one-off transaction against a processed run already does this; changing a Pay Item did
    // not, which is why the reporter's January figures sat there looking settled after they unticked
    // EPF. Only fires when a field that MOVES MONEY changed (isStatutoryRelevantChange) — a rename
    // must not make every open run in the tenant look stale. Marking is idempotent (a set union) and
    // markBatchNeedsRecalc itself no-ops on anything but a processed run, so a draft and a closed run
    // are both untouched. Inside the try so a failure surfaces on the form rather than half-saving.
    if (isStatutoryRelevantChange(changed)) {
      await markRunsAffectedByPayComponent(s, { componentId: id, code: input.code });
    }
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
    return { error: publicErrorMessage(e) };
  }
}

/**
 * 61bf109d — evaluate the CANDIDATE Input Type / formula for one real employee, before saving.
 *
 * Read-only by construction: previewPayRule opens a tenant transaction, reads, and returns a number — it
 * writes nothing and appends no event. It runs the SAME resolvePayComponentSet the payroll kernel runs, so
 * a preview that disagrees with the run is unrepresentable rather than merely unlikely.
 *
 * Rejections come back as a LOCALISED message (the stable PayRuleErrorCode mapped to payRule.errors.*), so
 * the admin is told "these pay items depend on each other in a loop" rather than shown a raw code — and the
 * preview refuses exactly what Save would refuse, because both call the same two validators.
 */
export async function previewPayRuleAction(p: {
  code: string;
  kind: string;
  prorates: boolean;
  rule: PayRule | null;
  employmentId: string;
}): Promise<
  | {
      ok: true;
      amount: number;
      scope: { basic: number; days: number; hours: number };
      inputs: { code: string; amount: number }[];
      /** 2da9937a — already LOCALISED here rather than in the client: the divisor is a FormulaOperandRef
       *  (`hours`, `fixed_allowances`, …), and the admin must read it as the same words the operand picker
       *  showed them, not as an internal token. Null when nothing divided by zero. */
      zeroDivisor: string | null;
      /** e318eaec — the fold, step by step, straight from the evaluator. The CLIENT renders each step's
       *  operand, with the same formatPayRuleOperand and the same `payRule.operand_*` catalog entries the
       *  live formula line uses — so the working and the formula above it are worded identically. */
      steps: PayRuleTraceStep[];
    }
  | { ok: false; message: string }
> {
  const s = await getSession();
  const tr = await getTranslations('payRule');
  const kind = (['allowance', 'deduction', 'contribution', 'non_payable'] as const).includes(p.kind as never)
    ? (p.kind as PayComponentInput['kind'])
    : 'allowance';
  try {
    const res = await previewPayRule(s, {
      code: p.code,
      rule: p.rule,
      kind,
      prorates: p.prorates,
      employmentId: p.employmentId,
    });
    if (!res.ok) return { ok: false, message: tr(`errors.${res.code}`) };
    return {
      ok: true,
      amount: res.amount,
      scope: res.scope,
      inputs: res.inputs,
      zeroDivisor: res.zeroDivisor
        ? tr('previewZeroDivisor', { divisor: tr(`operand_${res.zeroDivisor.divisor}`), step: res.zeroDivisor.step })
        : null,
      steps: res.steps,
    };
  } catch {
    return { ok: false, message: tr('previewFailed') };
  }
}

/**
 * e318eaec — search the employees the rule can be checked against, by name or employee ID.
 *
 * SERVER-SIDE because the list is capped: filtering the cap in the browser would only ever search the rows
 * already loaded, which is the defect the ticket reports ("the list is the fifty most recently hired, with
 * no search"). Read-only, and it returns the same shape the page's initial load does, so the picker's
 * options come from one definition rather than two.
 *
 * GUARDED LIKE THE PAGE THAT HOSTS IT. component-form.tsx loads the initial list behind `requireAdmin`, and
 * a server action is reachable by any authenticated caller regardless of which route it lives under — so
 * the check is repeated here rather than inherited. It REFUSES BY RETURNING NOTHING instead of calling
 * requireAdmin(): that helper signals with `redirect()`, which throws NEXT_REDIRECT, and a data-returning
 * action that throws a navigation at a non-admin is a worse answer than an empty picker. RLS is still the
 * backstop underneath (withTenant), so this narrows the caller set; it is not what keeps tenants apart.
 */
export async function searchPreviewEmployeesAction(
  query: string,
): Promise<{ employmentId: string; name: string; employeeCode: string | null }[]> {
  const s = await getSession();
  if (!isAdmin(s)) return [];
  const rows = await listPayRulePreviewCandidates(s, { query });
  return rows.map((r) => ({ employmentId: r.employmentId, name: r.name, employeeCode: r.employeeCode }));
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
    const msg = e instanceof PayComponentInUseError ? t('errorInUse', { refs: e.refs }) : publicErrorMessage(e);
    return fail(new Error(msg));
  }
  revalidatePath(PAGE);
  back(t('toastDeleted'));
}
