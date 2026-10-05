'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  acknowledgeReview,
  addPerformanceAttachment,
  approveGoal,
  cancelCheckIn,
  closeCycle,
  closeReview,
  commitCalibration,
  completeCheckIn,
  createCycle,
  declineCompAction,
  draftManagerReview,
  enactCompAction,
  linkGoalToReview,
  lockGoalSetting,
  openCalibrationSession,
  previewEligibleCount,
  proposeCalibration,
  proposeGoals,
  moveCycleToCalibration,
  openCycle,
  releaseCycle,
  requestPeerFeedback,
  scheduleCheckIn,
  submitManagerReview,
  submitSelfReview,
  submitStageManager,
  submitStageSelf,
  unlinkGoalFromReview,
  ALL_STAGE_KINDS,
  type AssignmentStatus,
  type CycleStage,
  type EligibilityRules,
  type EmploymentTypeValue,
  type MeritBudget,
  type StageKind,
} from '@/core/performance';
import { EMPLOYMENT_STATUSES } from '@/core/employment-status';

const num = (v: FormDataEntryValue | null) => {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : undefined;
};
const str = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim();
  return s.length ? s : undefined;
};

// R81 (9cbf5e0d): the eligibility Status predicate speaks the ONE derived Employee Status vocabulary.
// Hardcoding the old five (three of them now retired) here is what let a tampered — or merely stale —
// submit re-introduce the three retired values into a stored rule after the screens had
// stopped offering them. Sourcing the list from EMPLOYMENT_STATUSES means the parser can only ever accept
// what the deriver can actually produce.
const STATUS_VALUES: readonly AssignmentStatus[] = EMPLOYMENT_STATUSES;
const EMP_TYPE_VALUES: readonly EmploymentTypeValue[] = ['full_time', 'part_time', 'contract', 'intern'];

/** Parse the eligibility-rule form fields (multi-selects + number + date) into an EligibilityRules
 *  object. Shared by createCycleAction and previewEligibilityAction so both read the form identically. */
function parseEligibilityRules(formData: FormData): EligibilityRules {
  const companyIds = formData.getAll('eligibilityCompanyId').map(String).filter(Boolean);
  const statuses = formData
    .getAll('eligibilityStatus')
    .map(String)
    .filter((v): v is AssignmentStatus => (STATUS_VALUES as string[]).includes(v));
  const employmentTypes = formData
    .getAll('eligibilityEmploymentType')
    .map(String)
    .filter((v): v is EmploymentTypeValue => (EMP_TYPE_VALUES as string[]).includes(v));
  const minServiceMonths = num(formData.get('minServiceMonths'));
  const hiredBefore = str(formData.get('hiredBefore')) ?? null;
  return {
    companyIds: companyIds.length ? companyIds : undefined,
    statuses: statuses.length ? statuses : undefined,
    employmentTypes: employmentTypes.length ? employmentTypes : undefined,
    minServiceMonths: minServiceMonths != null && minServiceMonths > 0 ? minServiceMonths : undefined,
    hiredBefore,
  };
}

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
    // Stages: HR ticks which lifecycle stages run; default (none ticked) = all three.
    const labelOf: Record<StageKind, string> = { goal_setting: 'Goal-setting', mid_year: 'Mid-year review', year_end: 'Year-end review' };
    const picked = formData.getAll('stage').map(String).filter((k): k is StageKind => (ALL_STAGE_KINDS as string[]).includes(k));
    const stages: CycleStage[] | undefined = picked.length ? picked.map((kind) => ({ kind, label: labelOf[kind] })) : undefined;
    const res = await createCycle(s, {
      name: String(formData.get('name') ?? ''),
      companyId: str(formData.get('companyId')) ?? null,
      periodStart: String(formData.get('periodStart') ?? ''),
      periodEnd: String(formData.get('periodEnd') ?? ''),
      meritBudget,
      eligibilityRules: parseEligibilityRules(formData),
      stages,
    });
    cycleId = res.cycleId;
  } catch (e) {
    redirect(`/performance?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath('/performance');
  redirect(`/performance/${cycleId}`);
}

/**
 * RPC-shaped (NOT redirecting) server action for the "Preview eligible employees" button. Returns the
 * point-in-time count to the client island so it can render "N employees currently eligible (as of now)"
 * without navigating away. Surfaces the cross-company-scope rejection (and any other) as an error string.
 */
export async function previewEligibilityAction(formData: FormData): Promise<{ count?: number; error?: string }> {
  const s = await getSession();
  try {
    const { count } = await previewEligibleCount(s, {
      companyId: str(formData.get('companyId')) ?? null,
      eligibilityRules: parseEligibilityRules(formData),
    });
    return { count };
  } catch (e) {
    return { error: publicErrorMessage(e) };
  }
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
    redirect(`/performance/${cycleId}?error=${encodeURIComponent(publicErrorMessage(e))}`);
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
    redirect(`/performance/review/${reviewId}?error=${encodeURIComponent(publicErrorMessage(e))}`);
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
    redirect(`/performance/review/${reviewId}?error=${encodeURIComponent(publicErrorMessage(e))}`);
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
    redirect(`/performance/review/${reviewId}?error=${encodeURIComponent(publicErrorMessage(e))}`);
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
    return { error: publicErrorMessage(e) };
  }
}

export async function linkGoalAction(formData: FormData) {
  const s = await getSession();
  const reviewId = String(formData.get('reviewId'));
  try {
    await linkGoalToReview(s, { reviewId, goalId: String(formData.get('goalId')) });
  } catch (e) {
    redirect(`/performance/review/${reviewId}?error=${encodeURIComponent(publicErrorMessage(e))}`);
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
    redirect(`/performance/review/${reviewId}?error=${encodeURIComponent(publicErrorMessage(e))}`);
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
    redirect(`/performance?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath('/performance');
  redirect(`/performance?toast=${encodeURIComponent('Check-in scheduled')}`);
}

export async function completeCheckInAction(formData: FormData) {
  const s = await getSession();
  try {
    await completeCheckIn(s, { checkinId: String(formData.get('checkinId')), notes: str(formData.get('notes')) });
  } catch (e) {
    redirect(`/performance?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath('/performance');
  redirect(`/performance?toast=${encodeURIComponent('Check-in completed')}`);
}

export async function cancelCheckInAction(formData: FormData) {
  const s = await getSession();
  try {
    await cancelCheckIn(s, { checkinId: String(formData.get('checkinId')) });
  } catch (e) {
    redirect(`/performance?error=${encodeURIComponent(publicErrorMessage(e))}`);
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
    redirect(`/performance/review/${reviewId}?error=${encodeURIComponent(publicErrorMessage(e))}`);
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
    redirect(`/performance/${cycleId}?error=${encodeURIComponent(publicErrorMessage(e))}`);
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
    redirect(`/performance/${cycleId}?error=${encodeURIComponent(publicErrorMessage(e))}`);
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
    redirect(`/performance/${cycleId}?error=${encodeURIComponent(publicErrorMessage(e))}`);
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
    redirect(`/performance/${cycleId}?error=${encodeURIComponent(publicErrorMessage(e))}`);
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
    redirect(`/performance/${cycleId}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(`/performance/${cycleId}`);
  redirect(`/performance/${cycleId}?toast=${encodeURIComponent('Recommendation declined')}`);
}

// ─────────────────────────── Lifecycle (stages / goals / closure / attachments) ───────────────────────────

const reviewRedirect = (reviewId: string, msg: string) =>
  redirect(`/performance/review/${reviewId}?toast=${encodeURIComponent(msg)}`);

export async function submitStageSelfAction(formData: FormData) {
  const s = await getSession();
  const reviewId = String(formData.get('reviewId'));
  const stage = String(formData.get('stage')) as 'mid_year' | 'year_end';
  try {
    await submitStageSelf(s, {
      reviewId,
      stage,
      selfRating: num(formData.get('selfRating')) ?? 0,
      selfComments: str(formData.get('selfComments')),
      goalsSummary: str(formData.get('goalsSummary')),
    });
  } catch (e) {
    redirect(`/performance/review/${reviewId}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(`/performance/review/${reviewId}`);
  reviewRedirect(reviewId, 'Self-assessment submitted');
}

export async function submitStageManagerAction(formData: FormData) {
  const s = await getSession();
  const reviewId = String(formData.get('reviewId'));
  const stage = String(formData.get('stage')) as 'mid_year' | 'year_end';
  try {
    await submitStageManager(s, {
      reviewId,
      stage,
      managerRating: num(formData.get('managerRating')) ?? 0,
      managerComments: str(formData.get('managerComments')),
      overallRating: num(formData.get('overallRating')),
    });
  } catch (e) {
    redirect(`/performance/review/${reviewId}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(`/performance/review/${reviewId}`);
  reviewRedirect(reviewId, 'Manager evaluation submitted');
}

export async function proposeGoalsAction(formData: FormData) {
  const s = await getSession();
  const reviewId = String(formData.get('reviewId'));
  try {
    await proposeGoals(s, { reviewId });
  } catch (e) {
    redirect(`/performance/review/${reviewId}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(`/performance/review/${reviewId}`);
  reviewRedirect(reviewId, 'Goals proposed');
}

export async function approveGoalAction(formData: FormData) {
  const s = await getSession();
  const reviewId = String(formData.get('reviewId'));
  try {
    await approveGoal(s, { goalId: String(formData.get('goalId')) });
  } catch (e) {
    redirect(`/performance/review/${reviewId}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(`/performance/review/${reviewId}`);
  reviewRedirect(reviewId, 'Goal approved');
}

export async function lockGoalSettingAction(formData: FormData) {
  const s = await getSession();
  const reviewId = String(formData.get('reviewId'));
  try {
    await lockGoalSetting(s, { reviewId });
  } catch (e) {
    redirect(`/performance/review/${reviewId}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(`/performance/review/${reviewId}`);
  reviewRedirect(reviewId, 'Goal-setting locked');
}

export async function closeReviewAction(formData: FormData) {
  const s = await getSession();
  const reviewId = String(formData.get('reviewId'));
  const cycleId = String(formData.get('cycleId'));
  const abcClass = String(formData.get('abcClass')) as 'A' | 'B' | 'C';
  try {
    await closeReview(s, { reviewId, abcClass, finalScore: num(formData.get('finalScore')) });
  } catch (e) {
    redirect(`/performance/${cycleId}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(`/performance/${cycleId}`);
  redirect(`/performance/${cycleId}?toast=${encodeURIComponent('Review closed')}`);
}

export async function uploadAttachmentAction(formData: FormData) {
  const s = await getSession();
  const reviewId = String(formData.get('reviewId'));
  const rawStage = str(formData.get('stageKind'));
  const stageKind = rawStage && (ALL_STAGE_KINDS as string[]).includes(rawStage) ? (rawStage as StageKind) : null;
  const file = formData.get('file');
  try {
    if (!(file instanceof File) || file.size === 0) throw new Error('Choose a file to upload');
    await addPerformanceAttachment(s, {
      reviewId,
      stageKind,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      content: Buffer.from(await file.arrayBuffer()),
    });
  } catch (e) {
    redirect(`/performance/review/${reviewId}?error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath(`/performance/review/${reviewId}`);
  reviewRedirect(reviewId, 'File uploaded');
}
