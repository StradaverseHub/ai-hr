'use server';

import { getBrowserCommandSession, getSession } from '@/lib/session';
import { completeOnboarding } from '@/core/onboarding';
import { tourSteps } from '@/lib/onboarding-tour';

/** Load only the requested walkthrough for the current signed-in roles. */
export async function readTourStepsAction(tourId: string) {
  const session = await getBrowserCommandSession();
  return typeof tourId === 'string' && tourId.length <= 64 ? tourSteps(tourId, session.roles) : [];
}

/** Persist that the caller finished or dismissed the first-login tour. */
export async function completeOnboardingAction() {
  const s = await getSession();
  await completeOnboarding(s);
}
