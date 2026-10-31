'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { setPayrollPermissionGrant, deletePayrollPermissionGrant } from '@/core/payroll-permissions-admin';

const ROUTE = '/admin/payroll-permissions';

/**
 * Upsert a granular permission override (feedback 9bc442bc). Admin-only (RLS backstops the write); the
 * service validates the key/role and appends a DomainEvent. Company blank = tenant-wide override.
 *
 * "payroll" in the names is historical (5206539f): the key set this writes now includes
 * `leave.apply_on_behalf`, so a row saved here can decide who may file leave for another employee. Nothing
 * in this file is key-specific — it validates against PAYROLL_PERMISSION_KEYS via the service — so a future
 * non-payroll key needs no edit here either.
 */
export async function setPayrollPermissionAction(formData: FormData) {
  const s = await getSession();
  if (!isAdmin(s)) redirect(`${ROUTE}?error=forbidden`);
  const companyId = String(formData.get('companyId') ?? '').trim() || null;
  const permissionKey = String(formData.get('permissionKey') ?? '');
  const role = String(formData.get('role') ?? '');
  const allowed = String(formData.get('allowed') ?? 'true') === 'true';
  try {
    await setPayrollPermissionGrant(s, { companyId, permissionKey, role, allowed });
  } catch (e) {
    redirect(`${ROUTE}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(ROUTE);
  redirect(`${ROUTE}?toast=saved`);
}

export async function deletePayrollPermissionAction(formData: FormData) {
  const s = await getSession();
  if (!isAdmin(s)) redirect(`${ROUTE}?error=forbidden`);
  const id = String(formData.get('id') ?? '');
  try {
    await deletePayrollPermissionGrant(s, { id });
  } catch (e) {
    redirect(`${ROUTE}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(ROUTE);
  redirect(`${ROUTE}?toast=removed`);
}
