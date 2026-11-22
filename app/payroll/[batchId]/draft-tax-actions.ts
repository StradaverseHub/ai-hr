'use server';

import {requirePayrollAccess} from '@/lib/authz';
import {readDraftTaxReadiness, requestDraftTaxReadiness} from '@/core/payroll-draft-tax-readiness';

export async function startDraftTaxCheck(batchId: string, operationKey: string) {
  const ctx = await requirePayrollAccess();
  try {
    return await requestDraftTaxReadiness(ctx, batchId, operationKey);
  } catch (error) {
    console.error('[payroll draft tax readiness admission]', error);
    return null;
  }
}

export async function getDraftTaxCheck(batchId: string, jobId: string, offset: number) {
  const ctx = await requirePayrollAccess();
  try {
    return await readDraftTaxReadiness(ctx, batchId, jobId, offset);
  } catch (error) {
    console.error('[payroll draft tax readiness status]', error);
    return null;
  }
}
