import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {ReviewShell} from '@/components/ai-centre/review-shell';
import {ModulePayComponentActionSection} from '@/components/assistant/module-pay-component-action-section';
/** GET only renders choices and recovery controls. A separate human-confirmed POST submits the actual catalogue creation. */
export default async function AssistantPayComponentPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const t=await getTranslations('assistant.workspace.payComponentActions'),query=await searchParams;return <ReviewShell title={t('title')} description={t('description')} back={{href:'/assistant?job=typed_pay_components',label:t('back')}} width="wide"><Card className="p-5"><ModulePayComponentActionSection resumeActionId={query.review}/></Card></ReviewShell>;}
