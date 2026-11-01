import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {ReviewShell} from '@/components/ai-centre/review-shell';
import {ModuleMultiCycleRunActionSection} from '@/components/assistant/module-multi-cycle-run-action-section';
/** GET only renders choices and recovery controls. A separate human-confirmed POST creates only the actual native additional-run draft. */
export default async function AssistantMultiCycleRunPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const t=await getTranslations('assistant.workspace.multiCycleRunActions'),query=await searchParams;return <ReviewShell title={t('title')} description={t('description')} back={{href:'/assistant?job=multi_cycle_payroll',label:t('back')}} width="wide"><Card className="p-5"><ModuleMultiCycleRunActionSection resumeActionId={query.review}/></Card></ReviewShell>;}
