'use server';
/**
 * Employee referrals (Recruitment slice 7): the refer form's one server action. It only translates the form into
 * submitReferral; the service checks the form and the database decides whether this person may refer this candidate to
 * this job. A refusal comes back as ONE code whatever the reason (D-023); the reason is in HR's audit event, never here.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { pgSqlState } from '@/lib/db-error';
import { CANDIDATE_FILE_MAX_BYTES, RecruitmentError, submitReferral } from '@/packs/recruitment/service';

export type ReferralFormState = {
  status: 'idle' | 'error';
  /** A stable code the page translates: missing_fields, invalid_input, confirm_required, file_type, file_too_large,
   *  referral_refused, unavailable. */
  code?: string;
  fields?: string[];
  values?: { fullName: string; email: string; mobile: string; reason: string };
  nonce?: number;
};

const FORM_CODES = new Set(['missing_fields', 'invalid_input', 'confirm_required', 'file_type', 'file_too_large', 'referral_refused']);
const str = (f: FormData, key: string) => String(f.get(key) ?? '').trim();

export async function submitReferralAction(_prev: ReferralFormState, f: FormData): Promise<ReferralFormState> {
  const values = { fullName: str(f, 'fullName'), email: str(f, 'email'), mobile: str(f, 'mobile'), reason: String(f.get('reason') ?? '').trim() };
  const file = f.get('resume');
  try {
    if (file instanceof File && file.size > CANDIDATE_FILE_MAX_BYTES) throw new RecruitmentError('file_too_large');
    await submitReferral(await getSession(), {
      jobId: str(f, 'jobId'), ...values, confirmed: f.get('confirmed') === 'on',
      file: file instanceof File && file.size > 0 ? { fileName: file.name, content: Buffer.from(await file.arrayBuffer()) } : null,
    });
  } catch (e) {
    // Only the error's kind and SQLSTATE: a database error's message carries the bound values (a candidate's details).
    if (!(e instanceof RecruitmentError)) console.error('referral submission failed', e instanceof Error ? e.name : typeof e, pgSqlState(e) ?? '');
    const code = e instanceof RecruitmentError && FORM_CODES.has(e.code) ? e.code : e instanceof RecruitmentError && e.code === 'not_found' ? 'referral_refused' : 'unavailable';
    return { status: 'error', code, fields: e instanceof RecruitmentError ? [...(e.detail ?? [])] : [], values, nonce: Date.now() };
  }
  revalidatePath('/me/referrals', 'layout');
  redirect('/me/referrals/mine?notice=sent');
}
