'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import {
  copyPayrollCycleToCompanies,
  deletePayrollCycle,
  seedPayrollCycleCatalog,
  setPayrollCycleActive,
  upsertPayrollCycle,
  PayrollCycleDuplicateNameError,
  PayrollCycleInUseError,
  PayrollCycleRegularConflictError,
} from '@/core/payroll-cycle';

const PAGE = '/admin/payroll-cycle';

/** Preserve the selected company across the redirect so the page keeps showing the same company's list. */
const dest = (companyId: string, kind: 'toast' | 'error', value: string) =>
  `${PAGE}?company=${encodeURIComponent(companyId)}&${kind}=${encodeURIComponent(value)}`;

/** Map the service's stable typed errors to localised, user-facing messages (no raw English leaks). */
async function localise(e: unknown): Promise<string> {
  const t = await getTranslations('payrollCycleConfig');
  if (e instanceof PayrollCycleDuplicateNameError) return t('errors.duplicateName');
  if (e instanceof PayrollCycleRegularConflictError) return t('errors.regularConflict');
  if (e instanceof PayrollCycleInUseError) return t('errors.inUse', { refs: e.refs });
  return (e as Error).message;
}

/** ToastFromQuery renders the raw string, so pass already-localised toast text (not a code). */
async function toastMsg(key: 'seeded' | 'saved' | 'deleted'): Promise<string> {
  const t = await getTranslations('payrollCycleConfig');
  return t(`toast.${key}`);
}

export async function seedCatalogAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  let ok = false;
  let err = '';
  try {
    await seedPayrollCycleCatalog(s, companyId);
    ok = true;
  } catch (e) {
    err = await localise(e);
  }
  revalidatePath(PAGE);
  redirect(ok ? dest(companyId, 'toast', await toastMsg('seeded')) : dest(companyId, 'error', err));
}

export async function upsertCycleAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const id = String(formData.get('id') ?? '') || undefined;
  let ok = false;
  let err = '';
  try {
    await upsertPayrollCycle(s, {
      id,
      companyId,
      name: String(formData.get('name') ?? ''),
      runType: String(formData.get('runType') ?? 'regular'),
      remarks: String(formData.get('remarks') ?? '') || null,
      description: String(formData.get('description') ?? '') || null,
      sortOrder: Number(formData.get('sortOrder') ?? 0),
    });
    ok = true;
  } catch (e) {
    err = await localise(e);
  }
  revalidatePath(PAGE);
  redirect(ok ? dest(companyId, 'toast', await toastMsg('saved')) : dest(companyId, 'error', err));
}

export async function setActiveAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  let ok = false;
  let err = '';
  try {
    await setPayrollCycleActive(s, { id: String(formData.get('id')), active: formData.get('active') === 'true' });
    ok = true;
  } catch (e) {
    err = await localise(e);
  }
  revalidatePath(PAGE);
  redirect(ok ? dest(companyId, 'toast', await toastMsg('saved')) : dest(companyId, 'error', err));
}

export async function deleteCycleAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  let ok = false;
  let err = '';
  try {
    await deletePayrollCycle(s, String(formData.get('id')));
    ok = true;
  } catch (e) {
    err = await localise(e);
  }
  revalidatePath(PAGE);
  redirect(ok ? dest(companyId, 'toast', await toastMsg('deleted')) : dest(companyId, 'error', err));
}

/**
 * Copy a cycle definition into one or more OTHER companies (the ticket's "assign to many companies" step).
 * Targets are intersected with the admin's scoped companies BEFORE calling the service (RLS is the
 * fail-closed backstop; this pre-filter keeps the normal flow from tripping it). Redirects with a localised
 * toast summarising how many clones were created vs skipped (duplicate / regular-conflict).
 */
export async function copyCycleAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const id = String(formData.get('id') ?? '');
  let ok = false;
  let err = '';
  let toast = '';
  try {
    const { s: scopeS, scopeIds } = await scopedAdmin();
    const all = await listCompanies(scopeS);
    const allowed = new Set(all.filter((c) => scopeIds.includes(c.id)).map((c) => c.id));
    const requested = formData.getAll('companyIds').map((v) => String(v));
    const targets = requested.filter((cid) => allowed.has(cid) && cid !== companyId);
    const { results } = await copyPayrollCycleToCompanies(s, { id, companyIds: targets });
    const created = results.filter((r) => r.outcome === 'created').length;
    const skipped = results.length - created;
    const t = await getTranslations('payrollCycleConfig');
    toast = t('toast.copied', { created, skipped });
    ok = true;
  } catch (e) {
    err = await localise(e);
  }
  revalidatePath(PAGE);
  redirect(ok ? dest(companyId, 'toast', toast) : dest(companyId, 'error', err));
}
