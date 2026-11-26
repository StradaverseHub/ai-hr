'use server';

import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { deleteCp38, setCp38, updateCp38 } from '@/packs/payroll/service';
import { cp38ErrorKey, cp38FormValues } from '@/lib/cp38-form';
import { inAppHref } from '@/lib/action-navigation';
import { publicErrorMessage } from '@/lib/public-error';

/**
 * 038c304b — the Payroll > Transaction Entry > CP38 Deduction pop-up's save and delete (cp38-dialog.tsx).
 *
 * VALUE-RETURNING (the Fixed Transaction pop-up's shape): a refusal answers with its sentence so the pop-up stays open;
 * success answers with the list address to open (ADR 0181 decision 4: no revalidatePath, refresh or redirect, so the app
 * frame is not redrawn). Both call the SAME core/cp38.ts writers as the employee's Payroll tab, through the payroll
 * pack, with the screen's company-switcher scope: the service resolves the record to its employment and refuses one
 * outside that scope or whose company the caller does not administer for payroll (scopedEmploymentSession semantics),
 * so a tampered id cannot reach another company's row. The Payroll module must be on.
 */
export type Cp38DialogResult = { ok: true; navigate: string } | { ok: false; message: string };

const PAGE = '/payroll/transactions/cp38';

/** Back to the list the pop-up was opened from (its filters and page), never anywhere else. */
function listAddress(formData: FormData, toast: string): string {
  const raw = inAppHref(formData.get('returnTo'));
  const base = raw && (raw === PAGE || raw.startsWith(`${PAGE}?`)) ? raw : PAGE;
  const url = new URL(base, 'http://in-app.invalid');
  url.searchParams.set('toast', toast);
  return `${url.pathname}?${url.searchParams.toString()}`;
}

async function payrollAdmin() {
  const { s, scopeIds } = await scopedAdmin();
  return isModuleEnabledOrFalse(s, 'payroll') ? { s, scopeIds } : null;
}

type Translate = Awaited<ReturnType<typeof getTranslations>>;
function refused(t: Translate, e: unknown): Cp38DialogResult {
  const { key, args } = cp38ErrorKey(e);
  if (!key) return { ok: false, message: publicErrorMessage(e) };
  return { ok: false, message: t(`error.${key}`, { ref: args.ref ?? '', from: args.from ?? '', to: args.to || t('open') }) };
}

/** Add (no `id`) or Edit (with `id`) one CP38 record. */
export async function saveCp38DialogAction(formData: FormData): Promise<Cp38DialogResult> {
  const t = await getTranslations('payroll.transactions.cp38');
  const scoped = await payrollAdmin();
  if (!scoped) return { ok: false, message: t('error.outOfScope') };
  const id = String(formData.get('id') ?? '').trim();
  const values = cp38FormValues(formData);
  try {
    if (id) await updateCp38(scoped.s, { id, ...values, companyIds: scoped.scopeIds });
    else {
      await setCp38(scoped.s, {
        employmentId: String(formData.get('employmentId') ?? '').trim(),
        ...values,
        companyIds: scoped.scopeIds,
      });
    }
  } catch (e) {
    return refused(t, e);
  }
  return { ok: true, navigate: listAddress(formData, t('saved')) };
}

/** Delete one CP38 record (it stops applying to every payroll that is not closed; History keeps it). */
export async function deleteCp38DialogAction(formData: FormData): Promise<Cp38DialogResult> {
  const t = await getTranslations('payroll.transactions.cp38');
  const scoped = await payrollAdmin();
  if (!scoped) return { ok: false, message: t('error.outOfScope') };
  try {
    await deleteCp38(scoped.s, { id: String(formData.get('id') ?? '').trim(), companyIds: scoped.scopeIds });
  } catch (e) {
    return refused(t, e);
  }
  return { ok: true, navigate: listAddress(formData, t('deleted')) };
}
