import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {ReviewShell} from '@/components/ai-centre/review-shell';
import {OffboardingCaseCancelSection} from '@/components/assistant/offboarding-case-cancel-section';
export default async function OffboardingCaseCancelPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const t=await getTranslations('assistant.workspace.offboardingCaseCancel'),query=await searchParams;return <ReviewShell title={t('title')} description={t('description')}><Card className="p-5"><OffboardingCaseCancelSection resumeActionId={query.review}/></Card></ReviewShell>;}
