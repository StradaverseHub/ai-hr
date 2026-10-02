'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { packFor } from '@/localization/registry';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const month = /^\d{4}-(0[1-9]|1[0-2])$/;
type ErrorKey = 'invalid' | 'unavailable' | 'saveFailed' | 'revokeFailed';

function back(employmentId: string, formData: FormData, error?: ErrorKey): never {
  const query = new URLSearchParams({ tab: 'bankStatutory' });
  if (String(formData.get('from') ?? '') === 'org') query.set('from', 'org');
  const asOf = String(formData.get('asOf') ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(asOf)) query.set('asOf', asOf);
  if (error) query.set('incentiveError', error);
  else query.set('toast', 'Saved');
  // A submitted identifier never becomes an arbitrary path or redirect destination.
  redirect(uuid.test(employmentId) ? `/admin/personnel/${employmentId}?${query}` : '/admin/personnel');
}

/** Writes only employer-scoped declarations; never the person's tax-residency row. */
export async function saveIncentiveDeclarationAction(formData: FormData) {
  const session = await requireAdmin();
  const employmentId = String(formData.get('employmentId') ?? '');
  const scheme = String(formData.get('scheme') ?? '');
  const validFrom = String(formData.get('validFrom') ?? '');
  const validTo = String(formData.get('validTo') ?? '');
  const approvalReference = String(formData.get('approvalReference') ?? '').trim();
  // Exact checkbox value: an arbitrary present field must not assert HR confirmation.
  const eligibilityConfirmed = formData.get('eligibilityConfirmed') === 'confirmed';
  if (!uuid.test(employmentId) || !['rep', 'knowledge_worker', 'c_suite'].includes(scheme)
    || !month.test(validFrom) || !month.test(validTo) || validFrom > validTo
    || !approvalReference || !eligibilityConfirmed) back(employmentId, formData, 'invalid');
  const service = packFor('MY')?.statutory.saveTaxSchemeDeclaration;
  if (!service) back(employmentId, formData, 'unavailable');
  try {
    await service(session, { employmentId, scheme: scheme as 'rep' | 'knowledge_worker' | 'c_suite',
      validFrom, validTo, approvalReference, eligibilityConfirmed });
  } catch {
    back(employmentId, formData, 'saveFailed');
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, formData);
}

/** Revoke preserves declaration and audit history; no delete or mutable historical approval. */
export async function revokeIncentiveDeclarationAction(formData: FormData) {
  const session = await requireAdmin();
  const employmentId = String(formData.get('employmentId') ?? '');
  const id = String(formData.get('id') ?? '');
  if (!uuid.test(employmentId) || !uuid.test(id)) back(employmentId, formData, 'invalid');
  const service = packFor('MY')?.statutory.revokeTaxSchemeDeclaration;
  if (!service) back(employmentId, formData, 'unavailable');
  try {
    // Service verifies declaration ownership against this employment and derives the company.
    await service(session, { employmentId, id });
  } catch {
    back(employmentId, formData, 'revokeFailed');
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  back(employmentId, formData);
}
