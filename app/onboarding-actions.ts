'use server';

import { getSession } from '@/lib/session';
import { completeOnboarding } from '@/core/onboarding';

/** Persist that the caller finished or dismissed the first-login tour. */
export async function completeOnboardingAction() {
  const s = await getSession();
  await completeOnboarding(s);
}
