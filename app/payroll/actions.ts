'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  closeBatch,
  createBatch,
  generatePayslips,
  prefillOvertimeFromAttendance,
  setPayrollInput,
} from '@/core/payroll';
import { prefillClaimsForBatch } from '@/core/claims';

export async function createBatchAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId'));
  const payPeriod = String(formData.get('payPeriod'));
  let batchId = '';
  try {
    ({ batchId } = await createBatch(s, { companyId, payPeriod }));
  } catch (e) {
    redirect(`/payroll?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/payroll');
  redirect(`/payroll/${batchId}`);
}

export async function generateAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  try {
    await generatePayslips(s, { batchId });
  } catch (e) {
    redirect(`/payroll/${batchId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/payroll/${batchId}`);
  redirect(`/payroll/${batchId}?toast=Payslips generated`);
}

export async function setPayrollInputAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  try {
    await setPayrollInput(s, {
      batchId,
      employmentId: String(formData.get('employmentId')),
      overtimeAmount: Number(formData.get('overtimeAmount')) || 0,
      bonusAmount: Number(formData.get('bonusAmount')) || 0,
      tp1Deduction: Number(formData.get('tp1Deduction')) || 0,
      zakat: Number(formData.get('zakat')) || 0,
    });
  } catch (e) {
    redirect(`/payroll/${batchId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/payroll/${batchId}`);
  redirect(`/payroll/${batchId}?toast=Saved`);
}

export async function prefillOvertimeAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  let applied = 0;
  let ineligible = 0;
  try {
    ({ applied, ineligible } = await prefillOvertimeFromAttendance(s, { batchId }));
  } catch (e) {
    redirect(`/payroll/${batchId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/payroll/${batchId}`);
  const note =
    applied === 0
      ? 'No overtime found in attendance for this period'
      : `OT prefilled for ${applied} employee${applied === 1 ? '' : 's'}${
          ineligible ? ` (${ineligible} above RM4,000 — not statutorily entitled)` : ''
        }`;
  redirect(`/payroll/${batchId}?toast=${encodeURIComponent(note)}`);
}

export async function prefillClaimsAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  let applied = 0;
  let claims = 0;
  let total = 0;
  try {
    ({ applied, claims, total } = await prefillClaimsForBatch(s, { batchId }));
  } catch (e) {
    redirect(`/payroll/${batchId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/payroll/${batchId}`);
  const note =
    claims === 0
      ? 'No approved taxable claims awaiting payout'
      : `Queued ${claims} claim${claims === 1 ? '' : 's'} (RM ${total.toLocaleString('en-MY', {
          minimumFractionDigits: 2,
        })}) onto ${applied} payslip${applied === 1 ? '' : 's'}`;
  redirect(`/payroll/${batchId}?toast=${encodeURIComponent(note)}`);
}

export async function closeAction(formData: FormData) {
  const s = await getSession();
  const batchId = String(formData.get('batchId'));
  try {
    await closeBatch(s, { batchId });
  } catch (e) {
    redirect(`/payroll/${batchId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/payroll/${batchId}`);
  redirect(`/payroll/${batchId}?toast=Batch closed`);
}
