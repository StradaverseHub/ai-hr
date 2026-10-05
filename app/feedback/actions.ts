'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { myEmployment } from '@/core/read';
import {
  addFeedbackAttachment,
  answerBlockingQuestion,
  approveFeedbackPlan,
  bulkReview,
  cancelFeedback,
  contestFeedbackPlan,
  generateFeedbackPlan,
  refuteDeployment,
  restoreFeedback,
  submitFeedback,
  type BulkAction,
} from '@/core/feedback';
import type { FeedbackCategory } from '@/db/schema';

const BASE = '/feedback';
const fail = (e: unknown, path: string = BASE): never =>
  redirect(`${path}?error=${encodeURIComponent(publicErrorMessage(e))}`);

export async function submitFeedbackAction(formData: FormData) {
  const s = await getSession();
  try {
    const me = await myEmployment(s);
    if (!me) throw new Error('No active employment is linked to your account.');
    const { id } = await submitFeedback(s, {
      reporterEmploymentId: me.employmentId,
      category: String(formData.get('category')) as FeedbackCategory,
      title: String(formData.get('title') ?? ''),
      description: String(formData.get('description') ?? ''),
      expectedBehavior: String(formData.get('expectedBehavior') ?? '').trim() || null,
      expectedFunction: String(formData.get('expectedFunction') ?? '').trim() || null,
    });
    // Supporting documents + images (multiple).
    const files = formData.getAll('attachments').filter((f): f is File => f instanceof File && f.size > 0);
    for (const file of files) {
      await addFeedbackAttachment(s, {
        feedbackId: id,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        content: Buffer.from(await file.arrayBuffer()),
      });
    }
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Feedback logged')}`);
}

/**
 * Store any images the reporter attached alongside a push-back (0321).
 *
 * Runs AFTER the status change, deliberately: the attachment records the revision it answers, and
 * contestFeedbackPlan / refuteDeployment do not bump plan_revision — only a re-plan does — so the value
 * read here is still the revision the reporter was looking at. Doing it before would work today and
 * break silently the day either service starts bumping.
 *
 * A failed upload must NOT undo an accepted push-back: the words are the thing that matters, and losing
 * a recorded objection because a file was too large would be a worse outcome than a missing screenshot.
 * Failures are surfaced on the toast instead.
 */
async function attachTo(
  s: Awaited<ReturnType<typeof getSession>>,
  feedbackId: string,
  formData: FormData,
  stage: 'contested' | 'refuted',
): Promise<string | null> {
  const files = formData.getAll('attachments').filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return null;
  const failed: string[] = [];
  for (const file of files) {
    try {
      await addFeedbackAttachment(s, {
        feedbackId,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        content: Buffer.from(await file.arrayBuffer()),
        stage,
      });
    } catch {
      failed.push(file.name);
    }
  }
  return failed.length ? `${failed.length} file(s) could not be attached: ${failed.join(', ')}` : null;
}

export async function approveFeedbackPlanAction(formData: FormData) {
  const s = await getSession();
  const id = String(formData.get('id'));
  try {
    await approveFeedbackPlan(s, { feedbackId: id });
  } catch (e) {
    fail(e, `${BASE}/${id}`);
  }
  revalidatePath(`${BASE}/${id}`);
  redirect(`${BASE}/${id}?toast=${encodeURIComponent('Plan approved')}`);
}

export async function contestFeedbackPlanAction(formData: FormData) {
  const s = await getSession();
  const id = String(formData.get('id'));
  let attachNote: string | null = null;
  try {
    await contestFeedbackPlan(s, { feedbackId: id, reason: String(formData.get('reason') ?? '') });
    attachNote = await attachTo(s, id, formData, 'contested');
  } catch (e) {
    fail(e, `${BASE}/${id}`);
  }
  revalidatePath(`${BASE}/${id}`);
  redirect(
    `${BASE}/${id}?toast=${encodeURIComponent(attachNote ?? 'Sent back for re-planning')}`,
  );
}

/**
 * Answer the question a `blocked` item is waiting on (0323) — blocked → approved, answer kept.
 *
 * The loop could ask ("this is waiting on an answer") and could not listen: `blocked` had no control at
 * all on the detail page. Attachments are deliberately NOT accepted here, unlike contest/refute (0321): a
 * block is a question of fact — which channel, which format, which rule — and the answer is words. Adding
 * an upload would be scope the defect does not ask for.
 */
export async function answerBlockingQuestionAction(formData: FormData) {
  const s = await getSession();
  const id = String(formData.get('id'));
  try {
    await answerBlockingQuestion(s, { feedbackId: id, answer: String(formData.get('answer') ?? '') });
  } catch (e) {
    fail(e, `${BASE}/${id}`);
  }
  revalidatePath(`${BASE}/${id}`);
  revalidatePath(BASE); // the list shows status — it moves out of "Waiting on an answer" here
  redirect(`${BASE}/${id}?toast=${encodeURIComponent('Answer sent')}`);
}

/** Admin "Generate plan now" — runs the planning agent immediately instead of waiting for the cron. */
export async function generateFeedbackPlanNowAction(formData: FormData) {
  const s = await getSession();
  const id = String(formData.get('id'));
  try {
    await generateFeedbackPlan(s, { feedbackId: id });
  } catch (e) {
    fail(e, `${BASE}/${id}`);
  }
  revalidatePath(`${BASE}/${id}`);
  redirect(`${BASE}/${id}?toast=${encodeURIComponent('Plan generated')}`);
}

export async function cancelFeedbackAction(formData: FormData) {
  const s = await getSession();
  const id = String(formData.get('id'));
  try {
    await cancelFeedback(s, { feedbackId: id });
  } catch (e) {
    fail(e, `${BASE}/${id}`);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?toast=${encodeURIComponent('Feedback withdrawn')}`);
}

export async function restoreFeedbackAction(formData: FormData) {
  const s = await getSession();
  const id = String(formData.get('id'));
  try {
    await restoreFeedback(s, { feedbackId: id });
  } catch (e) {
    fail(e, `${BASE}/${id}`);
  }
  revalidatePath(`${BASE}/${id}`);
  revalidatePath(BASE);
  redirect(`${BASE}/${id}?toast=${encodeURIComponent('Feedback restored')}`);
}

/** Close the loop: the reporter refutes a DEPLOYED result that still needs changes (→ contested, re-planned). */
export async function refuteDeploymentAction(formData: FormData) {
  const s = await getSession();
  const id = String(formData.get('id'));
  let attachNote: string | null = null;
  try {
    await refuteDeployment(s, { feedbackId: id, reason: String(formData.get('reason') ?? '') });
    attachNote = await attachTo(s, id, formData, 'refuted');
  } catch (e) {
    fail(e, `${BASE}/${id}`);
  }
  revalidatePath(`${BASE}/${id}`);
  redirect(`${BASE}/${id}?toast=${encodeURIComponent(attachNote ?? 'Sent back for changes')}`);
}

/** List-view bulk bar: apply one review action to the selected items at once. */
export async function bulkReviewAction(formData: FormData) {
  const s = await getSession();
  const ids = formData.getAll('ids').map(String).filter(Boolean);
  const action = String(formData.get('action')) as BulkAction;
  let count = 0;
  let skipped = 0;
  try {
    const { succeeded, failed } = await bulkReview(s, { ids, action, reason: String(formData.get('reason') ?? '') });
    count = succeeded.length;
    skipped = failed.length;
  } catch (e) {
    fail(e);
  }
  revalidatePath(BASE);
  // Structured toast (key + params) so the page renders a grammatical, localized message — never a
  // verb derived by appending 'd' (the old `${action}d` printed "canceld"/"contestd").
  const qs = new URLSearchParams({ toastKey: 'bulkResult', count: String(count), action, skipped: String(skipped) });
  redirect(`${BASE}?${qs.toString()}`);
}
