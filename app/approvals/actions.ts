'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { decideLeave, decideLeaveDate, decideLeaveDates, decideLeaveCancellation } from '@/core/leave';
import { parseBulkItems, runBulkDecide, type BulkDecideItem } from '@/lib/approvals-bulk';
import { localizeLeaveError } from '@/app/me/actions';
import { decideAttendanceCorrection } from '@/core/attendance';
import { decideTravelRequest } from '@/core/travel-request';
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
  // Partial Leave Approval (0131): the reject-reason textarea (required when rejecting). Threaded through so
  // decideLeave can enforce the mandatory reason and stamp it onto the leave-request.rejected event.
  const rejectReason = String(formData.get('rejectReason') || '') || undefined;
  try {
    await decideLeave(s, { leaveRequestId: String(formData.get('id')), decision, rejectReason });
  } catch (e) {
    // Partial Leave Approval (0131): re-localize the new MissingRejectReasonError (and the existing typed
    // leave errors) into the viewer's language, like the /me + leave-tab flows do.
    fail(new Error(await localizeLeaveError(e)));
  }
  done(`Leave ${decision}`);
}

// Partial Leave Approval — single-request model (ADR-0068 §4D): decide ONE requested date of a per-date
// request from the detail-view expander. Reject requires a reason (MissingRejectReasonError, re-localized).
export async function decideLeaveDateAction(formData: FormData) {
  const s = await getSession();
  const decision = String(formData.get('decision')) as 'approved' | 'rejected';
  const rejectReason = String(formData.get('rejectReason') || '') || undefined;
  try {
    const me = await myEmployment(s);
    await decideLeaveDate(s, {
      leaveRequestId: String(formData.get('id')),
      leaveDate: String(formData.get('leaveDate')),
      decision,
      deciderEmploymentId: me?.employmentId,
      rejectReason,
    });
  } catch (e) {
    fail(new Error(await localizeLeaveError(e)));
  }
  done(`Date ${decision}`);
}

// Partial Leave Approval — single-request model (R17 600be8ac): decide MANY requested dates in ONE submit
// from the approver's decision table. `decisions` is a JSON array of { leaveDate, decision, rejectReason? };
// the service validates (reject ⇒ reason) and finalizes once. Reject reasons are re-localized on failure.
export async function decideLeaveDatesAction(formData: FormData) {
  const s = await getSession();
  let decisions: { leaveDate: string; decision: 'approved' | 'rejected'; rejectReason?: string }[] = [];
  try {
    const raw = JSON.parse(String(formData.get('decisions') || '[]'));
    if (!Array.isArray(raw)) throw new Error('invalid decisions payload');
    decisions = raw.map((d: { leaveDate?: unknown; decision?: unknown; rejectReason?: unknown }) => {
      const decision = d.decision === 'rejected' ? 'rejected' : 'approved';
      if (typeof d.leaveDate !== 'string') throw new Error('invalid decisions payload');
      return {
        leaveDate: d.leaveDate,
        decision,
        rejectReason: typeof d.rejectReason === 'string' ? d.rejectReason : undefined,
      };
    });
  } catch (e) {
    fail(e);
  }
  try {
    const me = await myEmployment(s);
    await decideLeaveDates(s, {
      leaveRequestId: String(formData.get('id')),
      decisions,
      deciderEmploymentId: me?.employmentId,
    });
  } catch (e) {
    fail(new Error(await localizeLeaveError(e)));
  }
  done('Leave decided');
}

// Partial Leave Cancellation (ADR-0065): manager approves/rejects an employee's request to give back a
// subset of approved leave dates. Authz lives in decideLeaveCancellation (assertCanDecide bans self-approval
// + requires manager/admin). Resolve the decider employment like the claim/resignation actions.
export async function decideLeaveCancellationAction(formData: FormData) {
  const s = await getSession();
  const decision = String(formData.get('decision')) as 'approved' | 'rejected';
  try {
    const me = await myEmployment(s);
    await decideLeaveCancellation(s, {
      cancellationRequestId: String(formData.get('id')),
      decision,
      deciderEmploymentId: me?.employmentId,
    });
  } catch (e) {
    fail(new Error(await localizeLeaveError(e)));
  }
  done(`Cancellation ${decision}`);
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

export async function approveTravelAction(formData: FormData) {
  const s = await getSession();
  const decision = String(formData.get('decision')) as 'approved' | 'rejected';
  try {
    await decideTravelRequest(s, { travelRequestId: String(formData.get('id')), decision });
  } catch (e) {
    fail(e);
  }
  done(`Travel ${decision}`);
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

// Bulk approve/reject (feedback fb99474b). Accepts a JSON `items` list of {type,id} the approver selected
// across the per-type sections, a single `decision`, and (for reject) one `rejectReason` applied to all.
// Each item is dispatched to the SAME core decide* service the row-level action uses — INSIDE the normal
// path — so assertCanDecide + the per-record DomainEvent fire once per request (audit unchanged; bulk never
// approves anything a one-by-one click couldn't). Each item runs in its own try/catch AND its own service
// transaction (every decide* opens its own withTenant), so one failure/permission-skip never aborts the
// rest. We collect approved vs skipped and report both. v1 scope: leave, leave cancellations, claims,
// attendance/OT, travel — reviews / profile changes / resignations are excluded (richer per-item flows).
async function dispatchBulkItem(
  s: Awaited<ReturnType<typeof getSession>>,
  item: BulkDecideItem,
  decision: 'approved' | 'rejected',
  rejectReason: string | undefined,
  deciderEmploymentId: string | undefined,
): Promise<void> {
  switch (item.type) {
    case 'leave':
      // decideLeave enforces the mandatory reject reason itself (MissingRejectReasonError).
      await decideLeave(s, { leaveRequestId: item.id, decision, rejectReason, deciderEmploymentId });
      return;
    case 'leaveCancellation':
      await decideLeaveCancellation(s, { cancellationRequestId: item.id, decision, deciderEmploymentId });
      return;
    case 'claim':
      await decideClaim(s, {
        claimRequestId: item.id,
        decision: decision === 'approved' ? 'approve' : 'reject',
        deciderEmploymentId: deciderEmploymentId ?? null,
      });
      return;
    case 'attendance':
      await decideAttendanceCorrection(s, { correctionId: item.id, decision, deciderEmploymentId });
      return;
    case 'travel':
      await decideTravelRequest(s, { travelRequestId: item.id, decision, deciderEmploymentId });
      return;
  }
}

export async function bulkDecideAction(formData: FormData) {
  const s = await getSession();
  const decision = String(formData.get('decision')) === 'rejected' ? 'rejected' : 'approved';
  const rejectReason = String(formData.get('rejectReason') || '').trim() || undefined;
  const sort = String(formData.get('sort') || '');
  const items = parseBulkItems(String(formData.get('items') || '[]'));

  const t = await getTranslations('approvals');
  if (items.length === 0) redirect(`${back}${sort ? `?sort=${encodeURIComponent(sort)}` : ''}`);

  const me = await myEmployment(s);
  const deciderEmploymentId = me?.employmentId ?? undefined;

  // Each item runs in its own try/catch (runBulkDecide) + its own service transaction (every decide* opens
  // withTenant), so a permission denial (assertCanDecide), an already-decided row, or any per-item failure is
  // a SKIP — never fatal to the batch. The dominant skip reason is approval authority, hence the toast wording.
  const { approved, skipped } = await runBulkDecide(items, (item) =>
    dispatchBulkItem(s, item, decision, rejectReason, deciderEmploymentId),
  );

  revalidatePath(back);
  const summary =
    decision === 'rejected'
      ? skipped > 0
        ? t('bulkRejectedPartial', { done: approved, skipped })
        : t('bulkRejectedAll', { done: approved })
      : skipped > 0
        ? t('bulkApprovedPartial', { done: approved, skipped })
        : t('bulkApprovedAll', { done: approved });
  const qs = new URLSearchParams();
  if (sort) qs.set('sort', sort);
  qs.set('toast', summary);
  redirect(`${back}?${qs.toString()}`);
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
