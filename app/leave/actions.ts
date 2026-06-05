'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { decideLeave, requestLeave } from '@/core/leave';

export async function requestLeaveAction(formData: FormData) {
  const session = await getSession();
  try {
    await requestLeave(session, {
      employmentId: String(formData.get('employmentId')),
      leaveTypeId: String(formData.get('leaveTypeId')),
      startDate: String(formData.get('startDate')),
      endDate: String(formData.get('endDate')),
      reason: (formData.get('reason') as string) || undefined,
    });
  } catch (e) {
    redirect(`/leave?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/leave');
  redirect('/leave');
}

export async function decideLeaveAction(formData: FormData) {
  const session = await getSession();
  try {
    await decideLeave(session, {
      leaveRequestId: String(formData.get('leaveRequestId')),
      decision: String(formData.get('decision')) as 'approved' | 'rejected',
    });
  } catch (e) {
    redirect(`/leave?error=${encodeURIComponent((e as Error).message)}`);
  }
  revalidatePath('/leave');
  redirect('/leave');
}
