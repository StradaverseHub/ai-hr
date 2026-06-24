'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { myEmployment } from '@/core/read';
import {
  addFeedbackAttachment,
  approveFeedbackPlan,
  cancelFeedback,
  contestFeedbackPlan,
  generateFeedbackPlan,
  submitFeedback,
} from '@/core/feedback';
import type { FeedbackCategory } from '@/db/schema';

const BASE = '/feedback';
const fail = (e: unknown, path: string = BASE): never =>
  redirect(`${path}?error=${encodeURIComponent((e as Error).message)}`);

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
  try {
    await contestFeedbackPlan(s, { feedbackId: id, reason: String(formData.get('reason') ?? '') });
  } catch (e) {
    fail(e, `${BASE}/${id}`);
  }
  revalidatePath(`${BASE}/${id}`);
  redirect(`${BASE}/${id}?toast=${encodeURIComponent('Sent back for re-planning')}`);
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
