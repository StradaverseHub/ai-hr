import {getTranslations} from 'next-intl/server';
import {PageHeader,Card} from '@/components/ui';
import {OffboardingStepSection} from '@/components/assistant/offboarding-step-section';
export default async function OffboardingStepPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const t=await getTranslations('assistant.workspace.offboardingStep'),query=await searchParams;return <div className="mx-auto max-w-3xl space-y-5"><PageHeader title={t('title')} description={t('description')}/><Card className="p-5"><OffboardingStepSection resumeActionId={query.review}/></Card></div>;}
