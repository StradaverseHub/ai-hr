import { requireModule } from '@/lib/authz';
import { onboardingContext, onboardingOptions } from '@/packs/lifecycle/service';
import { OnboardingSettings } from '@/app/(app)/admin/lifecycle/onboarding/settings';
import { OnboardingSetup } from '../setup';
export default async function Page() { const s = await requireModule('lifecycle'), context = await onboardingContext(s); if (!context.revision || !context.actor.module)
    return <OnboardingSetup master={context.actor.master} initialized={!!context.revision}/>; return <OnboardingSettings context={context} options={await onboardingOptions(s)} initialTab="checklists"/>; }
