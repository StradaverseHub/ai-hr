'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import { publicErrorMessage } from '@/lib/public-error';
import { resolvePayrollLeaveException } from '@/packs/payroll/service';

export async function resolveLeavePayrollExceptionAction(form: FormData) {
  const session = await requireAdmin();
  const batchId = String(form.get('batchId') ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(batchId)) redirect('/payroll');
  let failed = false;
  try {
    await resolvePayrollLeaveException(session, {
      id: String(form.get('exceptionId') ?? ''), batchId,
      resolution: String(form.get('resolution') ?? '') as 'adjustment' | 'no_adjustment',
      adjustmentBatchId: String(form.get('adjustmentBatchId') ?? '').trim() || null,
      explanation: String(form.get('explanation') ?? ''),
    });
  } catch (error) {
    console.error('Payroll leave follow-up resolution failed:', publicErrorMessage(error));
    failed = true;
  }
  if (!failed) revalidatePath(`/payroll/${batchId}`);
  redirect(`/payroll/${batchId}${failed ? '?leaveFollowupError=1' : ''}#leave-followup`);
}
