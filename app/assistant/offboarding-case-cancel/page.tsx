import {getTranslations} from 'next-intl/server';
import {PageHeader,Card} from '@/components/ui';
import {OffboardingCaseCancelSection} from '@/components/assistant/offboarding-case-cancel-section';
export default async function OffboardingCaseCancelPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const t=await getTranslations('assistant.workspace.offboardingCaseCancel'),query=await searchParams;return <div className="mx-auto max-w-3xl space-y-5"><PageHeader title={t('title')} description={t('description')}/><Card className="p-5"><OffboardingCaseCancelSection resumeActionId={query.review}/></Card></div>;}
