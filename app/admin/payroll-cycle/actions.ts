'use server';

import { publicErrorMessage } from '@/lib/public-error';
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
  PayrollCycleDuplicateCodeError,
  PayrollCycleDuplicateNameError,
  PayrollCycleInUseError,
  PayrollCycleRegularConflictError,
} from '@/core/payroll-cycle';
import { cycleCompanyHref, cycleHref, cycleNewHref } from './nav';

const PAGE = '/admin/payroll-cycle';

/**
 * 6df24751 — WHERE A WRITE LANDS, now that the screen is company-first.
 *
 * These actions used to redirect to one page with `?company=` on it, because there WAS one page. There
 * are four routes now (company listing · one company's catalog · new · one cycle), so each action says
 * where it belongs:
 *   • success  ⇒ the company's catalog, which is the list the change is visible in;
 *   • failure  ⇒ back to the FORM the admin was filling in, so their rejected input is re-rendered with
 *                the message rather than being thrown away on a list screen.
 * `q` is the company listing's search term, threaded through the form as a hidden input so that a save
 * does not quietly discard it (the plan promises the search survives the round trip).
 */
const backTo = (href: string, kind: 'toast' | 'error', value: string) =>
  `${href}${href.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(value)}`;

/**
 * Invalidate the whole company-first subtree, not just the listing. `revalidatePath(PAGE)` alone was
 * sufficient while the screen WAS one page; a cycle now appears on three routes (the company listing's
 * counts and Last Updated, the company's catalog, and the cycle's own screen), and two of them sit behind
 * dynamic segments — which is why the second call passes the route PATTERN plus `'layout'`, the form the
 * Next 16 API requires for a path containing a dynamic segment (docs: revalidatePath, "Parameters").
 */
const revalidateCycles = () => {
  revalidatePath(PAGE);
  revalidatePath('/admin/payroll-cycle/[companyId]', 'layout');
};

/** The company's own cycle catalog — where every successful write lands. */
const dest = (companyId: string, kind: 'toast' | 'error', value: string, q?: string) =>
  backTo(cycleCompanyHref(companyId, q), kind, value);

/** Map the service's stable typed errors to localised, user-facing messages (no raw English leaks). */
async function localise(e: unknown): Promise<string> {
  const t = await getTranslations('payrollCycleConfig');
  if (e instanceof PayrollCycleDuplicateNameError) return t('errors.duplicateName');
  if (e instanceof PayrollCycleDuplicateCodeError) return t('errors.duplicateCode');
  if (e instanceof PayrollCycleRegularConflictError) return t('errors.regularConflict');
  if (e instanceof PayrollCycleInUseError) return t('errors.inUse', { refs: e.refs });
  return publicErrorMessage(e);
}

/** ToastFromQuery renders the raw string, so pass already-localised toast text (not a code). */
async function toastMsg(key: 'seeded' | 'saved' | 'deleted'): Promise<string> {
  const t = await getTranslations('payrollCycleConfig');
  return t(`toast.${key}`);
}

export async function seedCatalogAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const q = String(formData.get('q') ?? '') || undefined;
  let ok = false;
  let err = '';
  try {
    await seedPayrollCycleCatalog(s, companyId);
    ok = true;
  } catch (e) {
    err = await localise(e);
  }
  revalidateCycles();
  redirect(ok ? dest(companyId, 'toast', await toastMsg('seeded'), q) : dest(companyId, 'error', err, q));
}

export async function upsertCycleAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const id = String(formData.get('id') ?? '') || undefined;
  const q = String(formData.get('q') ?? '') || undefined;
  let ok = false;
  let err = '';
  try {
    await upsertPayrollCycle(s, {
      id,
      companyId,
      name: String(formData.get('name') ?? ''),
      code: String(formData.get('code') ?? '') || null,
      runType: String(formData.get('runType') ?? 'regular'),
      remarks: String(formData.get('remarks') ?? '') || null,
      description: String(formData.get('description') ?? '') || null,
      sortOrder: Number(formData.get('sortOrder') ?? 0),
    });
    ok = true;
  } catch (e) {
    err = await localise(e);
  }
  revalidateCycles();
  // A rejection goes back to the form that produced it — the edit screen for an existing cycle, the Add
  // screen for a new one — so the admin sees the message on the fields it is about.
  redirect(
    ok
      ? dest(companyId, 'toast', await toastMsg('saved'), q)
      : backTo(id ? cycleHref(companyId, id, q) : cycleNewHref(companyId, q), 'error', err),
  );
}

export async function setActiveAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const id = String(formData.get('id') ?? '');
  const q = String(formData.get('q') ?? '') || undefined;
  let ok = false;
  let err = '';
  try {
    await setPayrollCycleActive(s, { id, active: formData.get('active') === 'true' });
    ok = true;
  } catch (e) {
    err = await localise(e);
  }
  revalidateCycles();
  // The cycle still exists either way, and the toggle lives on its own screen — so stay on it.
  redirect(backTo(cycleHref(companyId, id, q), ok ? 'toast' : 'error', ok ? await toastMsg('saved') : err));
}

export async function deleteCycleAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId') ?? '');
  const id = String(formData.get('id') ?? '');
  const q = String(formData.get('q') ?? '') || undefined;
  let ok = false;
  let err = '';
  try {
    await deletePayrollCycle(s, id);
    ok = true;
  } catch (e) {
    err = await localise(e);
  }
  revalidateCycles();
  // A deleted cycle has no screen left to return to, so success goes up to the catalog. A REFUSED delete
  // (the in-use guard) does have one, and that is where the reason belongs.
  redirect(
    ok
      ? dest(companyId, 'toast', await toastMsg('deleted'), q)
      : backTo(cycleHref(companyId, id, q), 'error', err),
  );
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
  const q = String(formData.get('q') ?? '') || undefined;
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
  revalidateCycles();
  // The copy form lives on the source cycle's screen, and its result is a per-company summary about THAT
  // cycle — so the summary is delivered where the choice was made.
  redirect(backTo(cycleHref(companyId, id, q), ok ? 'toast' : 'error', ok ? toast : err));
}
