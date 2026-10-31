import { notFound } from 'next/navigation';
import { requireModule } from '@/lib/authz';
import { onboardingContext, onboardingOptions } from '@/packs/lifecycle/service';
import { OnboardingSettings } from '../settings';
import { OnboardingSetup } from '@/app/(app)/lifecycle/onboarding/setup';
export default async function Page() { const s = await requireModule('lifecycle'), context = await onboardingContext(s); if (!context.actor.master)
    notFound(); if (!context.revision)
    return <OnboardingSetup master initialized={false}/>; return <OnboardingSettings context={context} options={await onboardingOptions(s)} initialTab="access"/>; }
