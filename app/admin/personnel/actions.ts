'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { decideProfileChange } from '@/core/profile';

/**
 * 6d671f44 — `hireAction` USED TO LIVE HERE, and it is gone rather than merely unused.
 *
 * Create New Employee is now a dedicated step-by-step screen (app/admin/personnel/new) whose final
 * step calls `completeEmployeeDraft`, which runs the same writers this action ran (hireEmployee →
 * the company pack's statutory.set → setCompensation). Leaving the old action exported would have
 * left a SECOND way to create an employee — and every export of a 'use server' module is a callable
 * endpoint whether or not any screen posts to it. That is exactly the vestige r80 found and removed
 * for leave decisions (`decideLeaveAction`), for the same reason.
 *
 * What moved with it: the initial basic salary is still required and still validated before anything
 * is created; the provisional end date is still computed SERVER-side from the company's configured
 * probation months (r79a / 4fb8b75a step 3), never trusted from the client; and the three standing
 * leave grants (ANNUAL / SICK / HOSPITALIZATION) are still made on hire.
 */
export async function decideProfileChangeAction(formData: FormData) {
  const session = await requireAdmin();
  const decision = String(formData.get('decision')) as 'approved' | 'rejected';
  try {
    await decideProfileChange(session, {
      requestId: String(formData.get('requestId')),
      decision,
    });
  } catch (e) {
    redirect(`/admin/personnel?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/admin/personnel');
  redirect(`/admin/personnel?toast=${encodeURIComponent('Change ' + decision)}`);
}
