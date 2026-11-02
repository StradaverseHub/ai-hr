import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {ReviewShell} from '@/components/ai-centre/review-shell';
import {OffboardingStepSection} from '@/components/assistant/offboarding-step-section';
export default async function OffboardingStepPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const t=await getTranslations('assistant.workspace.offboardingStep'),query=await searchParams;return <ReviewShell title={t('title')} description={t('description')}><Card className="p-5"><OffboardingStepSection resumeActionId={query.review}/></Card></ReviewShell>;}
