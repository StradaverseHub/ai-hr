'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { decideLeave } from '@/core/leave';
import { decideAttendanceCorrection } from '@/core/attendance';
import { decideProfileChange } from '@/core/profile';

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
