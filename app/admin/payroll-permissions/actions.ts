'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import { setPayrollPermissionGrant, deletePayrollPermissionGrant } from '@/core/payroll-permissions-admin';

const ROUTE = '/admin/payroll-permissions';

/**
 * Upsert a granular payroll permission override (feedback 9bc442bc). Admin-only (RLS backstops the write);
 * the service validates the key/role and appends a DomainEvent. Company blank = tenant-wide override.
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
    redirect(`${ROUTE}?error=${encodeURIComponent((e as Error).message)}`);
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
    redirect(`${ROUTE}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(ROUTE);
  redirect(`${ROUTE}?toast=removed`);
}
