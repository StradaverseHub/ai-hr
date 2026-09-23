'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { myEmployment } from '@/core/read';
import {
  createTestCase,
  raiseRunAsFeedback,
  recordTestRun,
  updateTestCase,
} from '@/core/system-testing';
import type { TestRunOutcome } from '@/db/schema';

/**
 * System Testing — the write endpoints (e6be5a3b, r330).
 *
 * EVERY ONE OF THESE IS A PUBLIC ENDPOINT, not a private helper of the page: a server action is
 * addressable by anyone who can guess its id, so nothing here relies on the route guard having run.
 * Authorisation is the SERVICE's (core/system-testing.ts asserts the module, then the admin role, then
 * RLS refuses behind both) and these functions deliberately add no checks of their own — a second,
 * parallel guard here is a second thing to forget to update.
 *
 * NONE OF THESE CROSSES INTO A CLIENT ISLAND. Every screen in this feature is a server component with
 * plain `<form action={…}>` elements, so no action is ever passed as a prop to a `'use client'`
 * component — the shape that type-checks, builds, and 500s at runtime.
 */

const BASE = '/admin/system-testing';
const fail = (e: unknown, path: string = BASE): never =>
  redirect(`${path}?error=${encodeURIComponent((e as Error).message)}`);

/** One step per line, order preserved — the form asks for a textarea, not a repeating field set. */
function stepsFrom(formData: FormData): string[] {
  return String(formData.get('steps') ?? '')
    .split('\n')
    .map((s) => s.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter((s) => s.length > 0);
}

function caseFieldsFrom(formData: FormData) {
  return {
    moduleCode: String(formData.get('moduleCode') ?? ''),
    title: String(formData.get('title') ?? ''),
    precondition: String(formData.get('precondition') ?? '').trim() || null,
    steps: stepsFrom(formData),
    testType: String(formData.get('testType') ?? ''),
    priority: String(formData.get('priority') ?? ''),
    expectedBehavior: String(formData.get('expectedBehavior') ?? '').trim() || null,
    expectedFunction: String(formData.get('expectedFunction') ?? '').trim() || null,
  };
}

export async function createTestCaseAction(formData: FormData) {
  const s = await getSession();
  let id: string;
  try {
    ({ id } = await createTestCase(s, caseFieldsFrom(formData)));
  } catch (e) {
    return fail(e, `${BASE}/new`);
  }
  revalidatePath(BASE);
  redirect(`${BASE}/${id}?toast=${encodeURIComponent('Test case created')}`);
}

export async function updateTestCaseAction(formData: FormData) {
  const s = await getSession();
  const caseId = String(formData.get('caseId'));
  try {
    await updateTestCase(s, { caseId, ...caseFieldsFrom(formData) });
  } catch (e) {
    return fail(e, `${BASE}/${caseId}`);
  }
  revalidatePath(`${BASE}/${caseId}`);
  revalidatePath(BASE);
  redirect(`${BASE}/${caseId}?toast=${encodeURIComponent('Test case saved')}`);
}

export async function recordTestRunAction(formData: FormData) {
  const s = await getSession();
  const caseId = String(formData.get('caseId'));
  try {
    await recordTestRun(s, {
      caseId,
      outcome: String(formData.get('outcome') ?? '') as TestRunOutcome,
      actualResult: String(formData.get('actualResult') ?? '').trim() || null,
    });
  } catch (e) {
    return fail(e, `${BASE}/${caseId}`);
  }
  revalidatePath(`${BASE}/${caseId}`);
  revalidatePath(BASE); // the list shows the DERIVED status, which this run may have just changed
  redirect(`${BASE}/${caseId}?toast=${encodeURIComponent('Run recorded')}`);
}

/**
 * Raise a failed run on the existing feedback board — ONE PRESS, no re-typing, no hand-keyed id.
 *
 * `myEmployment` for the same reason app/feedback/actions.ts uses it: `feedback_request` is keyed on the
 * reporter's EMPLOYMENT, which is what drives its RLS (can_see_employment). An admin with no employment
 * linked to their login gets the same message the feedback form gives them, rather than a foreign-key
 * error from two layers down.
 */
export async function raiseRunAsFeedbackAction(formData: FormData) {
  const s = await getSession();
  const caseId = String(formData.get('caseId'));
  const runId = String(formData.get('runId'));
  let feedbackId: string;
  try {
    const me = await myEmployment(s);
    if (!me) throw new Error('No active employment is linked to your account.');
    ({ feedbackId } = await raiseRunAsFeedback(s, { runId, reporterEmploymentId: me.employmentId }));
  } catch (e) {
    return fail(e, `${BASE}/${caseId}`);
  }
  revalidatePath(`${BASE}/${caseId}`);
  revalidatePath('/feedback');
  redirect(`/feedback/${feedbackId}?toast=${encodeURIComponent('Request raised from a failed test')}`);
}
