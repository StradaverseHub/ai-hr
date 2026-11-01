import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';
import {ReviewShell} from '@/components/ai-centre/review-shell';
import {ModuleCountryStatutoryActionSection} from '@/components/assistant/module-country-statutory-action-section';
/** GET renders authorized choices/recovery only. Saving requires a separate human-confirmed POST. */
export default async function AssistantStatutoryPage({searchParams}:{searchParams:Promise<{review?:string|string[]}>}){const t=await getTranslations('assistant.workspace.countryStatutoryActions'),query=await searchParams;return <ReviewShell title={t('title')} description={t('description')} back={{href:'/assistant?job=country-my',label:t('back')}} width="wide"><Card className="p-5"><ModuleCountryStatutoryActionSection resumeActionId={query.review}/></Card></ReviewShell>;}
