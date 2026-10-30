import {getTranslations} from 'next-intl/server';
import {PageHeader,Card} from '@/components/ui';
import {OffboardingStepUndoSection} from '@/components/assistant/offboarding-step-undo-section';
export default async function OffboardingStepUndoPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const t=await getTranslations('assistant.workspace.offboardingStepUndo'),query=await searchParams;return <div className="mx-auto max-w-3xl space-y-5"><PageHeader title={t('title')} description={t('description')}/><Card className="p-5"><OffboardingStepUndoSection resumeActionId={query.review}/></Card></div>;}
