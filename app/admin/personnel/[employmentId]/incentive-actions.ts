'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { packFor } from '@/localization/registry';
import {payrollTaxContextQuery} from '@/lib/payroll-tax-context-query';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const month = /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/;
const declarationErrorCodes = ['invalid_scheme', 'invalid_period', 'approval_required', 'missing_reference',
  'not_found', 'not_resident', 'citizenship_unknown', 'overlap', 'missing_declaration', 'declaration_revoked', 'declaration_outside_period', 'stale_context'] as const;
type DeclarationErrorCode = typeof declarationErrorCodes[number];
type ErrorKey = 'invalid' | 'unavailable' | 'saveFailed' | 'revokeFailed' | DeclarationErrorCode;

// The country-pack seam exposes stable refusal codes. Do not import a jurisdiction service into UI
// or expose arbitrary database/permission messages in the redirect query.
function refusal(error: unknown, fallback: 'saveFailed' | 'revokeFailed'): ErrorKey {
  if (error instanceof Error && error.name === 'TaxSchemeDeclarationError' && 'code' in error
    && declarationErrorCodes.includes(error.code as DeclarationErrorCode)) return error.code as DeclarationErrorCode;
  return fallback;
}

function back(employmentId: string, formData: FormData, error?: ErrorKey): never {
  const payrollBatchId=String(formData.get('payrollBatchId')??'');
  if(uuid.test(payrollBatchId)&&uuid.test(employmentId)){
    const q=payrollTaxContextQuery(formData.get('payrollFrom'),formData.get('payrollJob'));if(error)q.set('incentiveError',error);else q.set('toast','Saved');
    redirect(`/payroll/${payrollBatchId}/tax-configuration/${employmentId}?${q}`);
  }
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
  const expectedCompanyId = String(formData.get('expectedCompanyId') ?? '');
  const payrollBatchId=formData.has('payrollBatchId')?String(formData.get('payrollBatchId')):undefined;
  const expectedPayPeriod=formData.has('expectedPayPeriod')?String(formData.get('expectedPayPeriod')):undefined;
  const scheme = String(formData.get('scheme') ?? '');
  const validFrom = String(formData.get('validFrom') ?? '');
  const validTo = String(formData.get('validTo') ?? '');
  const approvalReference = String(formData.get('approvalReference') ?? '').trim();
  // Exact checkbox value: an arbitrary present field must not assert HR confirmation.
  const eligibilityConfirmed = formData.get('eligibilityConfirmed') === 'confirmed';
  if (!uuid.test(employmentId)) back(employmentId, formData, 'not_found');
  if (!uuid.test(expectedCompanyId)) back(employmentId, formData, 'stale_context');
  if (!['rep', 'knowledge_worker', 'c_suite'].includes(scheme)) back(employmentId, formData, 'invalid_scheme');
  if (!month.test(validFrom) || !month.test(validTo) || validFrom > validTo) back(employmentId, formData, 'invalid_period');
  if (!approvalReference || approvalReference.length > 300) back(employmentId, formData, 'missing_reference');
  if (!eligibilityConfirmed) back(employmentId, formData, 'approval_required');
  const service = packFor('MY')?.statutory.saveTaxSchemeDeclaration;
  if (!service) back(employmentId, formData, 'unavailable');
  try {
    await service(session, { employmentId, expectedCompanyId, scheme: scheme as 'rep' | 'knowledge_worker' | 'c_suite',
      validFrom, validTo, approvalReference, eligibilityConfirmed, ...(payrollBatchId!==undefined?{payrollBatchId,expectedPayPeriod}:{}) });
  } catch (error) {
    back(employmentId, formData, refusal(error, 'saveFailed'));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  if(payrollBatchId&&uuid.test(payrollBatchId))revalidatePath(`/payroll/${payrollBatchId}/tax-configuration/${employmentId}`);
  back(employmentId, formData);
}

/** Revoke preserves declaration and audit history; no delete or mutable historical approval. */
export async function revokeIncentiveDeclarationAction(formData: FormData) {
  const session = await requireAdmin();
  const employmentId = String(formData.get('employmentId') ?? '');
  const id = String(formData.get('id') ?? '');
  const payrollBatchId=formData.has('payrollBatchId')?String(formData.get('payrollBatchId')):undefined;
  const expectedCompanyId=formData.has('expectedCompanyId')?String(formData.get('expectedCompanyId')):undefined;
  const expectedPayPeriod=formData.has('expectedPayPeriod')?String(formData.get('expectedPayPeriod')):undefined;
  if (!uuid.test(employmentId) || !uuid.test(id)) back(employmentId, formData, 'invalid');
  const service = packFor('MY')?.statutory.revokeTaxSchemeDeclaration;
  if (!service) back(employmentId, formData, 'unavailable');
  try {
    // Service verifies declaration ownership against this employment and derives the company.
    await service(session, { employmentId, id, ...(payrollBatchId!==undefined?{payrollBatchId,expectedCompanyId,expectedPayPeriod}:{}) });
  } catch (error) {
    back(employmentId, formData, refusal(error, 'revokeFailed'));
  }
  revalidatePath(`/admin/personnel/${employmentId}`);
  if(payrollBatchId&&uuid.test(payrollBatchId))revalidatePath(`/payroll/${payrollBatchId}/tax-configuration/${employmentId}`);
  back(employmentId, formData);
}
