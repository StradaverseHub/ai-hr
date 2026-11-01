import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {ReviewShell} from '@/components/ai-centre/review-shell';
import {OffboardingStepUndoSection} from '@/components/assistant/offboarding-step-undo-section';
export default async function OffboardingStepUndoPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const t=await getTranslations('assistant.workspace.offboardingStepUndo'),query=await searchParams;return <ReviewShell title={t('title')} description={t('description')}><Card className="p-5"><OffboardingStepUndoSection resumeActionId={query.review}/></Card></ReviewShell>;}
