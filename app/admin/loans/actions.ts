'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import {
  amendLoan,
  cancelLoan,
  createLoan,
  resumeLoan,
  settleLoan,
  suspendLoan,
  type LoanInterestMethod,
  type LoanType,
} from '@/core/loans';

const BASE = '/admin/loans';
const fail = (e: unknown) => redirect(`${BASE}?error=${encodeURIComponent((e as Error).message)}`);
const ok = (msg: string) => redirect(`${BASE}?toast=${encodeURIComponent(msg)}`);

export async function createLoanAction(formData: FormData) {
  const s = await requireAdmin();
  try {
    await createLoan(s, {
      employmentId: String(formData.get('employmentId')),
      loanType: String(formData.get('loanType')) as LoanType,
      principal: Number(formData.get('principal')),
      interestRate: Number(formData.get('interestRate') ?? 0),
      interestMethod: String(formData.get('interestMethod')) as LoanInterestMethod,
      durationMonths: Number(formData.get('durationMonths')),
      startDate: String(formData.get('startDate')),
      notes: String(formData.get('notes') ?? '').trim() || null,
    });
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  ok('Loan created');
}

export async function amendLoanAction(formData: FormData) {
  const s = await requireAdmin();
  try {
    const duration = String(formData.get('durationMonths') ?? '').trim();
    const rate = String(formData.get('interestRate') ?? '').trim();
    // Only forward `notes` when the field is actually present in the submission. The inline duration-amend
    // form has no notes input; passing `null` there would map to a DEFINED value and wipe the loan's notes
    // (amendLoan treats `undefined` as "leave unchanged"). Mirror the interestRate absent→undefined path.
    const rawNotes = formData.get('notes');
    await amendLoan(s, {
      loanId: String(formData.get('loanId')),
      durationMonths: duration === '' ? undefined : Number(duration),
      interestRate: rate === '' ? undefined : Number(rate),
      notes: rawNotes === null ? undefined : String(rawNotes).trim() || null,
    });
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  ok('Loan amended');
}

export async function suspendLoanAction(formData: FormData) {
  const s = await requireAdmin();
  try {
    await suspendLoan(s, String(formData.get('loanId')));
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  ok('Loan suspended');
}

export async function resumeLoanAction(formData: FormData) {
  const s = await requireAdmin();
  try {
    await resumeLoan(s, String(formData.get('loanId')));
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  ok('Loan resumed');
}

export async function settleLoanAction(formData: FormData) {
  const s = await requireAdmin();
  try {
    await settleLoan(s, String(formData.get('loanId')));
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  ok('Loan settled');
}

export async function cancelLoanAction(formData: FormData) {
  const s = await requireAdmin();
  try {
    await cancelLoan(s, String(formData.get('loanId')));
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  ok('Loan cancelled');
}
