'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import {
  assignPolicy,
  createPolicy,
  deletePolicy,
  DuplicatePolicyNameError,
  PolicyCompanyMismatchError,
  PolicyInUseError,
  setStatus,
  updatePolicy,
} from '@/core/payroll-policy';

const PAGE = '/admin/payroll-policy';

const str = (fd: FormData, k: string): string | undefined => {
  const v = String(fd.get(k) ?? '').trim();
  return v || undefined;
};

/** Map a known service error to its localized message; fall back to the raw message otherwise. */
async function errorMessage(e: unknown): Promise<string> {
  const t = await getTranslations('payrollPolicy.errors');
  if (e instanceof DuplicatePolicyNameError) return t('duplicateName');
  if (e instanceof PolicyInUseError) return t('inUse');
  if (e instanceof PolicyCompanyMismatchError) return t('companyMismatch');
  return (e as Error).message;
}

/**
 * Run a write, then redirect — the success/error redirect always happens OUTSIDE the try/catch so Next's
 * NEXT_REDIRECT control-flow error is never swallowed by the catch. Returns the localized toast key resolved
 * to a real string (global ToastFromQuery fires `?toast=`).
 */
async function run(write: () => Promise<void>, toastKey: string, page = PAGE) {
  let errMsg: string | null = null;
  try {
    await write();
    revalidatePath(page);
  } catch (e) {
    errMsg = await errorMessage(e);
  }
  if (errMsg) redirect(`${page}?error=${encodeURIComponent(errMsg)}`);
  const t = await getTranslations('payrollPolicy.toasts');
  redirect(`${page}?toast=${encodeURIComponent(t(toastKey))}`);
}

export async function createPolicyAction(formData: FormData) {
  const s = await getSession();
  // Monthly-only slice: the server pins policyType to 'monthly' so an unsigned-off calculation type can never
  // be created, regardless of what the disabled dropdown submits.
  await run(
    () =>
      createPolicy(s, {
        companyId: String(formData.get('companyId') ?? ''),
        name: String(formData.get('name') ?? ''),
        description: str(formData, 'description') ?? null,
        policyType: 'monthly',
      }).then(() => undefined),
    'saved',
  );
}

export async function updatePolicyAction(formData: FormData) {
  const s = await getSession();
  await run(
    () =>
      updatePolicy(s, {
        id: String(formData.get('id') ?? ''),
        name: String(formData.get('name') ?? ''),
        description: str(formData, 'description') ?? null,
      }).then(() => undefined),
    'saved',
  );
}

export async function setStatusAction(formData: FormData) {
  const s = await getSession();
  await run(
    () =>
      setStatus(s, { id: String(formData.get('id') ?? ''), status: String(formData.get('status') ?? '') }).then(
        () => undefined,
      ),
    'statusChanged',
  );
}

export async function deletePolicyAction(formData: FormData) {
  const s = await getSession();
  await run(() => deletePolicy(s, { id: String(formData.get('id') ?? '') }).then(() => undefined), 'deleted');
}

/** Assign (or clear, when policyId is empty) a payroll policy to an employment. Used from the employee detail
 *  page; returns to the same employee with a localized toast/error. */
export async function assignPolicyAction(formData: FormData) {
  const s = await getSession();
  const employmentId = String(formData.get('employmentId') ?? '');
  const rawPolicy = String(formData.get('policyId') ?? '').trim();
  const dest = `/people/${employmentId}`;
  let errMsg: string | null = null;
  try {
    await assignPolicy(s, { employmentId, policyId: rawPolicy || null });
    revalidatePath(dest);
  } catch (e) {
    errMsg = await errorMessage(e);
  }
  if (errMsg) redirect(`${dest}?error=${encodeURIComponent(errMsg)}`);
  const t = await getTranslations('payrollPolicy.toasts');
  redirect(`${dest}?toast=${encodeURIComponent(t('assigned'))}`);
}
