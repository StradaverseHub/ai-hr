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

/**
 * 6d72816e — EVERY ACTION RETURNS TO THE LIST, AND NOW TO THE RIGHT ONE.
 *
 * The five lifecycle actions used to be submitted from a fold inside the row, so "back to /admin/loans" was
 * back to where you already were. They now live on the loan's own page, and the list they came from is the
 * one narrowed to the employee the operator was working on — so the forms carry `returnEmploymentId` and
 * the redirect puts it back in the address.
 *
 * IT IS NOT A FENCE AND IS NOT TREATED AS ONE. This value only ever becomes a `?employmentId=` on the list,
 * which scope-guards it on read (`employees.some(...)` before selecting). A tampered value therefore
 * degrades to "no selection", never to somebody else's records.
 */
const returnEmploymentId = (formData: FormData): string | null =>
  String(formData.get('returnEmploymentId') ?? '').trim() || null;
const listHref = (back: string | null, qs: string) =>
  `${BASE}?${back ? `employmentId=${encodeURIComponent(back)}&` : ''}${qs}`;
const fail = (e: unknown, back: string | null = null) =>
  redirect(listHref(back, `error=${encodeURIComponent((e as Error).message)}`));
const ok = (msg: string, back: string | null = null) =>
  redirect(listHref(back, `toast=${encodeURIComponent(msg)}`));

export async function createLoanAction(formData: FormData) {
  const s = await requireAdmin();
  const back = returnEmploymentId(formData);
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
    fail(e, back);
  }
  revalidatePath(BASE);
  ok('Loan created', back);
}

export async function amendLoanAction(formData: FormData) {
  const s = await requireAdmin();
  const back = returnEmploymentId(formData);
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
    fail(e, back);
  }
  revalidatePath(BASE);
  ok('Loan amended', back);
}

export async function suspendLoanAction(formData: FormData) {
  const s = await requireAdmin();
  const back = returnEmploymentId(formData);
  try {
    await suspendLoan(s, String(formData.get('loanId')));
  } catch (e) {
    fail(e, back);
  }
  revalidatePath(BASE);
  ok('Loan suspended', back);
}

export async function resumeLoanAction(formData: FormData) {
  const s = await requireAdmin();
  const back = returnEmploymentId(formData);
  try {
    await resumeLoan(s, String(formData.get('loanId')));
  } catch (e) {
    fail(e, back);
  }
  revalidatePath(BASE);
  ok('Loan resumed', back);
}

export async function settleLoanAction(formData: FormData) {
  const s = await requireAdmin();
  const back = returnEmploymentId(formData);
  try {
    await settleLoan(s, String(formData.get('loanId')));
  } catch (e) {
    fail(e, back);
  }
  revalidatePath(BASE);
  ok('Loan settled', back);
}

export async function cancelLoanAction(formData: FormData) {
  const s = await requireAdmin();
  const back = returnEmploymentId(formData);
  try {
    await cancelLoan(s, String(formData.get('loanId')));
  } catch (e) {
    fail(e, back);
  }
  revalidatePath(BASE);
  ok('Loan cancelled', back);
}
