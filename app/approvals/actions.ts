'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { decideLeave } from '@/core/leave';
import { decideAttendanceCorrection } from '@/core/attendance';
import { decideProfileChange } from '@/core/profile';
import { decideClaim } from '@/core/claims';
import { decideResignation } from '@/core/offboarding';
import {
  decideReview,
  submitManagerEvaluation,
  type ReviewDecision,
  type ReviewRecommendation,
} from '@/core/employment-review';
import { myEmployment } from '@/core/read';

// Thin wrappers around the same decide services the source pages use (authz lives in the
// services: assertCanDecide / admin-only) — these just land back on /approvals.

const back = '/approvals';
function done(toast: string): never {
  revalidatePath(back);
  redirect(`${back}?toast=${encodeURIComponent(toast)}`);
}
function fail(e: unknown): never {
  redirect(`${back}?error=${encodeURIComponent((e as Error).message)}`);
}

export async function approveLeaveAction(formData: FormData) {
  const s = await getSession();
  const decision = String(formData.get('decision')) as 'approved' | 'rejected';
  try {
    await decideLeave(s, { leaveRequestId: String(formData.get('id')), decision });
  } catch (e) {
    fail(e);
  }
  done(`Leave ${decision}`);
}

export async function approveCorrectionAction(formData: FormData) {
  const s = await getSession();
  const decision = String(formData.get('decision')) as 'approved' | 'rejected';
  try {
    await decideAttendanceCorrection(s, { correctionId: String(formData.get('id')), decision });
  } catch (e) {
    fail(e);
  }
  done(`Correction ${decision}`);
}

export async function approveProfileChangeAction(formData: FormData) {
  const s = await getSession();
  const decision = String(formData.get('decision')) as 'approved' | 'rejected';
  try {
    await decideProfileChange(s, { requestId: String(formData.get('id')), decision });
  } catch (e) {
    fail(e);
  }
  done(`Change ${decision}`);
}

export async function decideResignationAction(formData: FormData) {
  const s = await getSession();
  const accepted = String(formData.get('decision')) === 'approved';
  try {
    const me = await myEmployment(s);
    await decideResignation(s, {
      requestId: String(formData.get('id')),
      decision: accepted ? 'accepted' : 'rejected',
      deciderEmploymentId: me?.employmentId,
    });
  } catch (e) {
    fail(e);
  }
  done(`Resignation ${accepted ? 'accepted' : 'rejected'}`);
}

export async function submitManagerEvaluationAction(formData: FormData) {
  const s = await getSession();
  try {
    await submitManagerEvaluation(s, {
      reviewId: String(formData.get('id')),
      recommendation: String(formData.get('recommendation')) as ReviewRecommendation,
      comments: String(formData.get('comments') || '') || null,
    });
  } catch (e) {
    fail(e);
  }
  done('Evaluation submitted');
}

export async function decideReviewAction(formData: FormData) {
  const s = await getSession();
  const decision = String(formData.get('decision')) as ReviewDecision;
  try {
    const me = await myEmployment(s);
    await decideReview(s, {
      reviewId: String(formData.get('id')),
      decision,
      extendToDate: String(formData.get('extendToDate') || '') || null,
      hrComments: String(formData.get('hrComments') || '') || null,
      deciderEmploymentId: me?.employmentId ?? null,
    });
  } catch (e) {
    fail(e);
  }
  done('Decision recorded');
}

export async function approveClaimAction(formData: FormData) {
  const s = await getSession();
  const approved = String(formData.get('decision')) === 'approved';
  try {
    const me = await myEmployment(s);
    await decideClaim(s, {
      claimRequestId: String(formData.get('id')),
      decision: approved ? 'approve' : 'reject',
      deciderEmploymentId: me?.employmentId ?? null,
    });
  } catch (e) {
    fail(e);
  }
  done(`Claim ${approved ? 'approved' : 'rejected'}`);
}
