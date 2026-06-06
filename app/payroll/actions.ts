'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { closeBatch, createBatch, generatePayslips } from '@/core/payroll';

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
