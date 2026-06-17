'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  acknowledgeReview,
  closeCycle,
  createCycle,
  declineCompAction,
  enactCompAction,
  linkGoalToReview,
  moveCycleToCalibration,
  openCycle,
  releaseCycle,
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
