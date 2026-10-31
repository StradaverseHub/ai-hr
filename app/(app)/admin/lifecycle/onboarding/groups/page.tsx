import { requireModule } from '@/lib/authz';
import { onboardingContext, onboardingOptions } from '@/packs/lifecycle/service';
import { OnboardingSettings } from '../settings';
import { OnboardingSetup } from '@/app/(app)/lifecycle/onboarding/setup';
export default async function Page() { const s = await requireModule('lifecycle'), context = await onboardingContext(s); if (!context.revision || !context.actor.module && !context.actor.master)
    return <OnboardingSetup master={context.actor.master} initialized={!!context.revision}/>; return <OnboardingSettings context={context} options={await onboardingOptions(s)} initialTab="groups"/>; }
