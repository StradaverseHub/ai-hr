'use server';

import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { answerTp3PreviousEmployer, Tp3AnswerRefused } from '@/core/pre-salary/tp3-answer';

/** AI v2 Phase 2 hardening — the one-tap answer on the "Before payroll" checklist (Today and AI Centre › Insights):
 * "Did you work for another employer earlier this year?". The session is the person's own login, never the post; the
 * post carries only the employment the question was asked about, the assessment year and Yes or No, and the owner
 * (core/pre-salary/tp3-answer.ts) checks again that the employment is the person's own current-year one. A refused or
 * failed answer changes nothing: the question stays on the checklist to answer again. */
export async function answerTp3PreviousEmployerAction(formData: FormData): Promise<void> {
  const session = await getSession();
  try {
    await answerTp3PreviousEmployer(session, {
      employmentId: formData.get('employment'),
      assessmentYear: formData.get('year'),
      answer: formData.get('answer'),
    });
  } catch (error) {
    if (!(error instanceof Tp3AnswerRefused)) throw error;
  }
  revalidatePath('/');
  revalidatePath('/assistant');
}
