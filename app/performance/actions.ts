'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  acknowledgeReview,
  cancelCheckIn,
  closeCycle,
  commitCalibration,
  completeCheckIn,
  createCycle,
  declineCompAction,
  draftManagerReview,
  enactCompAction,
  linkGoalToReview,
  openCalibrationSession,
  proposeCalibration,
  moveCycleToCalibration,
  openCycle,
  releaseCycle,
  requestPeerFeedback,
  scheduleCheckIn,
  submitManagerReview,
  submitSelfReview,
  unlinkGoalFromReview,
  type MeritBudget,
} from '@/core/performance';

const num = (v: FormDataEntryValue | null) => {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : undefined;
};
const str = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim();
  return s.length ? s : undefined;
};

export async function createCycleAction(formData: FormData) {
  const s = await getSession();
  let cycleId: string;
  try {
    const kind = str(formData.get('meritBudgetKind'));
    const value = num(formData.get('meritBudgetValue'));
    const meritBudget: MeritBudget =
      kind && (kind === 'percent' || kind === 'amount') && value != null && value > 0
        ? { kind, value }
        : null;
    const res = await createCycle(s, {
      name: String(formData.get('name') ?? ''),
      companyId: str(formData.get('companyId')) ?? null,
      periodStart: String(formData.get('periodStart') ?? ''),
      periodEnd: String(formData.get('periodEnd') ?? ''),
      meritBudget,
      excludeProbation: formData.get('excludeProbation') != null,
      hiredBefore: str(formData.get('hiredBefore')) ?? null,
    });
    cycleId = res.cycleId;
  } catch (e) {
    redirect(`/performance?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/performance');
  redirect(`/performance/${cycleId}`);
}

async function cycleLifecycle(
  formData: FormData,
  fn: (s: Awaited<ReturnType<typeof getSession>>, p: { cycleId: string }) => Promise<unknown>,
) {
  const s = await getSession();
  const cycleId = String(formData.get('cycleId'));
  try {
    await fn(s, { cycleId });
  } catch (e) {
    redirect(`/performance/${cycleId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/performance/${cycleId}`);
  redirect(`/performance/${cycleId}`);
}

export async function openCycleAction(fd: FormData) {
  await cycleLifecycle(fd, openCycle);
}
export async function calibrateAction(fd: FormData) {
  await cycleLifecycle(fd, moveCycleToCalibration);
}
export async function releaseAction(fd: FormData) {
  await cycleLifecycle(fd, releaseCycle);
}
export async function closeAction(fd: FormData) {
  await cycleLifecycle(fd, closeCycle);
}

export async function submitSelfAction(formData: FormData) {
  const s = await getSession();
  const reviewId = String(formData.get('reviewId'));
  try {
    await submitSelfReview(s, {
      reviewId,
      selfRating: num(formData.get('selfRating')) ?? 0,
      selfComments: str(formData.get('selfComments')),
      goalsSummary: str(formData.get('goalsSummary')),
    });
  } catch (e) {
    redirect(`/performance/review/${reviewId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/performance/review/${reviewId}`);
  redirect(`/performance/review/${reviewId}?toast=${encodeURIComponent('Self-review submitted')}`);
}

export async function submitManagerAction(formData: FormData) {
  const s = await getSession();
  const reviewId = String(formData.get('reviewId'));
  try {
    await submitManagerReview(s, {
      reviewId,
      managerRating: num(formData.get('managerRating')) ?? 0,
      overallRating: num(formData.get('overallRating')) ?? 0,
      managerComments: str(formData.get('managerComments')),
      recommendedMeritPct: num(formData.get('recommendedMeritPct')) ?? null,
      recommendedBonus: num(formData.get('recommendedBonus')) ?? null,
    });
  } catch (e) {
    redirect(`/performance/review/${reviewId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/performance/review/${reviewId}`);
  redirect(`/performance/review/${reviewId}?toast=${encodeURIComponent('Review finalized')}`);
}

export async function acknowledgeAction(formData: FormData) {
  const s = await getSession();
  const reviewId = String(formData.get('reviewId'));
  try {
    await acknowledgeReview(s, { reviewId });
  } catch (e) {
    redirect(`/performance/review/${reviewId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/performance/review/${reviewId}`);
  redirect(`/performance/review/${reviewId}?toast=${encodeURIComponent('Acknowledged')}`);
}

/**
 * AI draft (ADR-0022 slice 5) — RPC-shaped, NOT a redirecting form action: the generated prose must
 * return to the client so it can land in the manager's editable textarea. Draft-only; nothing is
 * persisted to the review here. Errors (incl. "AI not configured") come back as a string to toast.
 */
export async function draftManagerReviewAction(reviewId: string): Promise<{ draft?: string; error?: string }> {
  const s = await getSession();
  try {
    const { draft } = await draftManagerReview(s, { reviewId });
    return { draft };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function linkGoalAction(formData: FormData) {
  const s = await getSession();
  const reviewId = String(formData.get('reviewId'));
  try {
    await linkGoalToReview(s, { reviewId, goalId: String(formData.get('goalId')) });
  } catch (e) {
    redirect(`/performance/review/${reviewId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/performance/review/${reviewId}`);
  redirect(`/performance/review/${reviewId}?toast=${encodeURIComponent('Goal linked')}`);
}

export async function unlinkGoalAction(formData: FormData) {
  const s = await getSession();
  const reviewId = String(formData.get('reviewId'));
  try {
    await unlinkGoalFromReview(s, { reviewId, goalId: String(formData.get('goalId')) });
  } catch (e) {
    redirect(`/performance/review/${reviewId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/performance/review/${reviewId}`);
  redirect(`/performance/review/${reviewId}?toast=${encodeURIComponent('Goal unlinked')}`);
}

export async function scheduleCheckInAction(formData: FormData) {
  const s = await getSession();
  try {
    await scheduleCheckIn(s, {
      subjectEmploymentId: String(formData.get('subjectEmploymentId')),
      scheduledOn: String(formData.get('scheduledOn')),
      notes: str(formData.get('notes')),
    });
  } catch (e) {
    redirect(`/performance?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/performance');
  redirect(`/performance?toast=${encodeURIComponent('Check-in scheduled')}`);
}

export async function completeCheckInAction(formData: FormData) {
  const s = await getSession();
  try {
    await completeCheckIn(s, { checkinId: String(formData.get('checkinId')), notes: str(formData.get('notes')) });
  } catch (e) {
    redirect(`/performance?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/performance');
  redirect(`/performance?toast=${encodeURIComponent('Check-in completed')}`);
}

export async function cancelCheckInAction(formData: FormData) {
  const s = await getSession();
  try {
    await cancelCheckIn(s, { checkinId: String(formData.get('checkinId')) });
  } catch (e) {
    redirect(`/performance?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/performance');
  redirect(`/performance?toast=${encodeURIComponent('Check-in cancelled')}`);
}

export async function requestPeerFeedbackAction(formData: FormData) {
  const s = await getSession();
  const reviewId = String(formData.get('reviewId'));
  const peerEmploymentIds = formData.getAll('peerEmploymentId').map(String).filter(Boolean);
  try {
    await requestPeerFeedback(s, { reviewId, peerEmploymentIds });
  } catch (e) {
    redirect(`/performance/review/${reviewId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/performance/review/${reviewId}`);
  redirect(`/performance/review/${reviewId}?toast=${encodeURIComponent('Feedback requested')}`);
}

export async function openCalibrationAction(formData: FormData) {
  const s = await getSession();
  const cycleId = String(formData.get('cycleId'));
  try {
    await openCalibrationSession(s, { cycleId });
  } catch (e) {
    redirect(`/performance/${cycleId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/performance/${cycleId}`);
  redirect(`/performance/${cycleId}?toast=${encodeURIComponent('Calibration opened')}`);
}

export async function proposeCalibrationAction(formData: FormData) {
  const s = await getSession();
  const cycleId = String(formData.get('cycleId'));
  const rating = num(formData.get('proposedRating'));
  try {
    await proposeCalibration(s, {
      sessionId: String(formData.get('sessionId')),
      reviewId: String(formData.get('reviewId')),
      proposedRating: rating ?? null,
    });
  } catch (e) {
    redirect(`/performance/${cycleId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/performance/${cycleId}`);
  redirect(`/performance/${cycleId}`);
}

export async function commitCalibrationAction(formData: FormData) {
  const s = await getSession();
  const cycleId = String(formData.get('cycleId'));
  try {
    await commitCalibration(s, { sessionId: String(formData.get('sessionId')) });
  } catch (e) {
    redirect(`/performance/${cycleId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/performance/${cycleId}`);
  redirect(`/performance/${cycleId}?toast=${encodeURIComponent('Calibration committed')}`);
}

export async function enactAction(formData: FormData) {
  const s = await getSession();
  const reviewId = String(formData.get('reviewId'));
  const cycleId = String(formData.get('cycleId'));
  try {
    await enactCompAction(s, {
      reviewId,
      meritEffectiveFrom: str(formData.get('meritEffectiveFrom')),
      bonusBatchId: str(formData.get('bonusBatchId')),
    });
  } catch (e) {
    redirect(`/performance/${cycleId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/performance/${cycleId}`);
  redirect(`/performance/${cycleId}?toast=${encodeURIComponent('Recommendation enacted')}`);
}

export async function declineAction(formData: FormData) {
  const s = await getSession();
  const reviewId = String(formData.get('reviewId'));
  const cycleId = String(formData.get('cycleId'));
  try {
    await declineCompAction(s, { reviewId });
  } catch (e) {
    redirect(`/performance/${cycleId}?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath(`/performance/${cycleId}`);
  redirect(`/performance/${cycleId}?toast=${encodeURIComponent('Recommendation declined')}`);
}
