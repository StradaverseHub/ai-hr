import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { requireModule } from '@/lib/authz';
import { onboardingContext, onboardingList, onboardingOptions } from '@/packs/lifecycle/service';
import { Joiners } from './joiners';
import { OnboardingSetup } from './setup';
export default async function Page(){
 const s=await requireModule('lifecycle'),context=await onboardingContext(s),t=await getTranslations('lifecycle');
 if(!context.revision||!context.actor.module)return <OnboardingSetup master={context.actor.master} initialized={!!context.revision}/>;
 const [rows,options]=await Promise.all([onboardingList(s),onboardingOptions(s)]);
 return <div className="space-y-6"><Joiners rows={rows} config={context.config} options={options}/><p className="text-sm text-muted-foreground"><Link className="text-primary underline" href="/lifecycle/onboarding/legacy">{t('onboarding.legacyTitle')}</Link></p></div>;
}
